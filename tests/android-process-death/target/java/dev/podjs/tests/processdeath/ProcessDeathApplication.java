package dev.podjs.tests.processdeath;

import android.app.Activity;
import android.app.Application;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import dev.podjs.runtime.PodRuntimeView;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Debug-only observer and semantic controller for one owned, non-instrumented package.
 * It never writes application KV or restores, supplies, or modifies an Android Bundle.
 * Process termination and task restoration remain external coordinator operations. */
public final class ProcessDeathApplication extends Application {
    private static final String OWN_PACKAGE = "dev.podjs.tests.startup";
    private static final String OWN_ACTIVITY = "dev.podjs.androidwatch.MainActivity";
    private static final String SAVED_KEY = "dev.podjs.activity-state";
    private static final int MAX_COMMAND_BYTES = 8192;
    private static final int MAX_COMMANDS = 256;
    private static final long MAX_RUN_MILLIS = 20 * 60 * 1000L;
    private static final long MAX_LOG_BYTES = 16 * 1024 * 1024L;
    private static final int MAX_STATE_BYTES = 1024 * 1024;
    private static final int MAX_KV_BYTES = 4 * 1024 * 1024;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final String processInstance = nonce();
    private final int pid = Process.myPid();
    private File directory;
    private File claims;
    private File acknowledgements;
    private String runNonce;
    private long eventSequence;
    private long deadline;
    private int commands;
    private Activity activity;
    private boolean resumed;
    private boolean enabled;
    private Snapshot lastSnapshot;

    @Override public void onCreate() {
        super.onCreate();
        if (!OWN_PACKAGE.equals(getPackageName()) || (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0)
            throw new IllegalStateException("Process-death harness requires its exact debug package");
        if (!OWN_PACKAGE.equals(Application.getProcessName())) return;
        try {
            directory = new File(getFilesDir(), "process-death");
            if (!directory.exists()) return; // An unconfigured isolated APK behaves normally.
            checkDirectory(directory, getFilesDir());
            File config = child(directory, "config.json");
            if (!config.exists()) return;
            JSONObject options = readJson(config, MAX_COMMAND_BYTES);
            exactKeys(options, "version", "packageName", "runNonce");
            requireInteger(options, "version", 1, 1);
            if (!OWN_PACKAGE.equals(options.opt("packageName"))) throw new IOException("Wrong configured package");
            runNonce = requireNonce(options, "runNonce");
            claims = ownDirectory("claims");
            acknowledgements = ownDirectory("acks");
            deadline = SystemClock.uptimeMillis() + MAX_RUN_MILLIS;
            enabled = true;
            registerActivityLifecycleCallbacks(callbacks);
            append(event("processStarted", null).put("packageName", getPackageName())
                    .put("uid", Process.myUid()).put("controller", "private-files"));
            recoverInterruptedCommand();
            main.post(poll);
        } catch (Exception error) {
            enabled = false;
            android.util.Log.e("ProcessDeathHarness", "Harness disabled: " + error.getClass().getSimpleName());
        }
    }

    private final ActivityLifecycleCallbacks callbacks = new ActivityLifecycleCallbacks() {
        @Override public void onActivityPreCreated(Activity next, Bundle incoming) {
            if (!owned(next)) return;
            activity = next;
            resumed = false;
            lastSnapshot = null;
            observe("preCreate", next, incoming, true);
        }
        @Override public void onActivityCreated(Activity next, Bundle incoming) { }
        @Override public void onActivityPostCreated(Activity next, Bundle incoming) {
            if (!owned(next)) return;
            try {
                PodRuntimeView view = requireView(next);
                JSONObject observed = event("postCreate", next)
                        .put("hostBooted", host(view) != 0).put("hostState", state(view));
                append(observed);
            } catch (Exception error) { failure("postCreate", next, error); }
        }
        @Override public void onActivityStarted(Activity next) { }
        @Override public void onActivityResumed(Activity next) { }
        @Override public void onActivityPostResumed(Activity next) {
            if (!owned(next)) return;
            activity = next;
            resumed = true;
            observe("postResume", next, null, false);
        }
        @Override public void onActivityPrePaused(Activity next) {
            if (next == activity) { resumed = false; lastSnapshot = null; }
        }
        @Override public void onActivityPaused(Activity next) { }
        @Override public void onActivityPostPaused(Activity next) { observe("postPause", next, null, false); }
        @Override public void onActivityStopped(Activity next) { }
        @Override public void onActivityPostStopped(Activity next) { observe("postStop", next, null, false); }
        @Override public void onActivitySaveInstanceState(Activity next, Bundle outgoing) { }
        @Override public void onActivityPostSaveInstanceState(Activity next, Bundle outgoing) {
            observe("postSave", next, outgoing, true);
        }
        @Override public void onActivityDestroyed(Activity next) { }
        @Override public void onActivityPostDestroyed(Activity next) {
            observe("postDestroy", next, null, false);
            if (next == activity) { activity = null; resumed = false; lastSnapshot = null; }
        }
    };

    private void observe(String name, Activity observed, Bundle bundle, boolean hasBundle) {
        if (!enabled || !owned(observed)) return;
        try {
            JSONObject value = event(name, observed).put("finishing", observed.isFinishing())
                    .put("changingConfigurations", observed.isChangingConfigurations());
            if (hasBundle) value.put("bundle", bundle(bundle));
            if ("preCreate".equals(name))
                value.put("lastNonConfigurationPresent", observed.getLastNonConfigurationInstance() != null);
            append(value);
        } catch (Exception error) { failure(name, observed, error); }
    }

    /** Observation only: the Bundle and its strings are never modified or supplied to the Activity. */
    @SuppressWarnings("deprecation") // API 30 supports this type-checking read; no newer typed getter is required.
    private JSONObject bundle(Bundle value) throws Exception {
        Object saved = value == null ? null : value.get(SAVED_KEY);
        if (saved != null && !(saved instanceof String)) throw new IOException("Unexpected saved-state value type");
        String json = (String) saved;
        byte[] bytes = json == null ? new byte[0] : json.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 64 * 1024) throw new IOException("Saved state exceeds SDK bound");
        return new JSONObject().put("present", value != null)
                .put("savedKeyPresent", value != null && value.containsKey(SAVED_KEY))
                .put("savedJson", json == null ? JSONObject.NULL : json)
                .put("savedUtf8Bytes", bytes.length)
                .put("savedSha256", json == null ? JSONObject.NULL : sha256(bytes));
    }

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            if (!enabled) return;
            if (SystemClock.uptimeMillis() >= deadline || commands >= MAX_COMMANDS) {
                try { append(event("controlExpired", activity)); } catch (Exception ignored) { }
                enabled = false;
                return;
            }
            try { consumeCommand(); }
            catch (Exception error) { failure("commandChannel", activity, error); }
            if (enabled) main.postDelayed(this, 100);
        }
    };

    private void consumeCommand() throws Exception {
        File input = child(directory, "command.json");
        if (!input.exists()) return;
        File inflight = child(directory, "inflight.json");
        if (inflight.exists()) throw new IOException("Unresolved command claim");
        checkRegularFile(input);
        Files.move(input.toPath(), inflight.toPath(), StandardCopyOption.ATOMIC_MOVE);
        commands++;
        JSONObject command = null;
        boolean claimed = false;
        try {
            command = readJson(inflight, MAX_COMMAND_BYTES);
            String id = requireNonce(command, "id");
            File claim = child(claims, id + ".json");
            File ack = child(acknowledgements, id + ".json");
            if (claim.exists() || ack.exists()) {
                claimed = claim.exists();
                if (ack.exists()) requireTerminalAck(command);
                else acknowledge(command, "interrupted", null, "Command was already claimed; its effect will not be replayed");
                append(event("duplicateIgnored", activity).put("id", id));
                return;
            }
            writeExclusive(claim, command); // The durable claim precedes every possible side effect.
            claimed = true;
            validateCommand(command);
            JSONObject result = execute(command);
            acknowledge(command, "ok", result, null);
        } catch (Exception error) {
            if (claimed) acknowledge(command, "error", null, error.getClass().getSimpleName() + ": " + error.getMessage());
            else append(event("commandRejected", activity).put("error", error.getClass().getSimpleName()));
        } finally {
            // If an effect might have run but publishing its result failed, leave
            // the claim for a future process to acknowledge without replaying it.
            if (!claimed || terminalAckExists(command)) Files.deleteIfExists(inflight.toPath());
        }
    }

    /** A crash after claiming never causes the command to be executed in a new process. */
    private void recoverInterruptedCommand() throws Exception {
        File inflight = child(directory, "inflight.json");
        if (!inflight.exists()) return;
        JSONObject command = readJson(inflight, MAX_COMMAND_BYTES);
        if (!terminalAckExists(command))
            acknowledge(command, "interrupted", null, "Previous process ended before command completion; command was not replayed");
        requireTerminalAck(command);
        Files.deleteIfExists(inflight.toPath());
    }

    private void validateCommand(JSONObject command) throws Exception {
        String op = requireString(command, "op");
        if ("action".equals(op)) exactKeys(command, "version", "runNonce", "id", "pid", "processInstance", "op", "snapshotToken", "nodeId", "action");
        else exactKeys(command, "version", "runNonce", "id", "pid", "processInstance", "op");
        requireInteger(command, "version", 1, 1);
        if (!runNonce.equals(requireNonce(command, "runNonce"))) throw new IOException("Wrong run nonce");
        if (requireInteger(command, "pid", 1, Integer.MAX_VALUE) != pid
                || !processInstance.equals(requireNonce(command, "processInstance")))
            throw new IOException("Command belongs to a different process instance");
        if (!"snapshot".equals(op) && !"action".equals(op) && !"background".equals(op)) throw new IOException("Unknown operation");
        if (activity == null || !owned(activity) || activity.isFinishing() || activity.isDestroyed() || !resumed)
            throw new IOException("Owned Activity is not resumed");
    }

    private JSONObject execute(JSONObject command) throws Exception {
        Activity current = activity;
        PodRuntimeView view = requireView(current);
        String op = command.getString("op");
        if ("snapshot".equals(op)) {
            lastSnapshot = snapshot(view, true);
            return new JSONObject().put("snapshotToken", lastSnapshot.token).put("tree", lastSnapshot.tree)
                    .put("hostState", state(view)).put("persistentKv", persistentKv());
        }
        if ("action".equals(op)) {
            int nodeId = requireInteger(command, "nodeId", 1, Integer.MAX_VALUE);
            int action = requireInteger(command, "action", 1, 4);
            if (action != 1 && action != 2 && action != 4) throw new IOException("Unsupported semantic action");
            if (lastSnapshot == null || !lastSnapshot.token.equals(requireNonce(command, "snapshotToken")))
                throw new IOException("Snapshot token is unavailable or consumed");
            Snapshot expected = lastSnapshot;
            lastSnapshot = null; // At most one action can consume a snapshot token.
            Snapshot live = snapshot(view, false);
            if (live.host != expected.host || live.hash != expected.hash) throw new IOException("Semantic snapshot is stale");
            JSONArray nodes = live.tree.getJSONArray("nodes");
            JSONObject selected = null;
            for (int index = 0; index < nodes.length(); index++) {
                JSONObject node = nodes.getJSONObject(index);
                if (node.getInt("id") == nodeId) {
                    if (selected != null) throw new IOException("Ambiguous semantic node ID");
                    selected = node;
                }
            }
            if (selected == null || (selected.optInt("actions") & action) == 0)
                throw new IOException("Live node does not support this semantic action");
            boolean accepted = Boolean.TRUE.equals(method("nativeAccessibilityAction", long.class, int.class, long.class, int.class)
                    .invoke(null, live.host, nodeId, live.hash, action));
            if (!accepted) throw new IOException("Native semantic action rejected its live ID/hash");
            method("nativeFrame", long.class).invoke(null, live.host);
            return new JSONObject().put("accepted", true).put("nodeId", nodeId).put("action", action)
                    .put("label", selected.optString("label"));
        }
        JSONObject before = new JSONObject().put("hostState", state(view)).put("persistentKv", persistentKv());
        lastSnapshot = null;
        boolean moved = current.moveTaskToBack(true);
        if (!moved) throw new IOException("Owned task did not move to the background");
        return before.put("moved", true);
    }

    private Snapshot snapshot(PodRuntimeView view, boolean advanceFrame) throws Exception {
        long host = host(view);
        if (host == 0) throw new IOException("Guest runtime is not ready");
        method("nativeAccessibilityEnabled", long.class, boolean.class).invoke(null, host, true);
        if (advanceFrame) method("nativeFrame", long.class).invoke(null, host);
        long[] metadata = new long[3];
        byte[] bytes = (byte[]) method("nativeAccessibilitySnapshot", long.class, long[].class).invoke(null, host, metadata);
        if (bytes == null || bytes.length > MAX_STATE_BYTES) throw new IOException("Semantic snapshot is unavailable or oversized");
        JSONObject tree = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        tree.getJSONArray("nodes");
        return new Snapshot(nonce(), host, metadata[0], tree);
    }

    /** Read native state without flushing/running JS, preserving the pre-guest restore observation. */
    private JSONObject state(PodRuntimeView view) throws Exception {
        Field servicesField = PodRuntimeView.class.getDeclaredField("services");
        servicesField.setAccessible(true);
        Object services = servicesField.get(view);
        Field stateField = services.getClass().getDeclaredField("activityState");
        stateField.setAccessible(true);
        Object state = stateField.get(services);
        Method saved = state.getClass().getDeclaredMethod("saved");
        Method retained = state.getClass().getDeclaredMethod("retained");
        saved.setAccessible(true);
        retained.setAccessible(true);
        String savedJson;
        String retainedJson;
        synchronized (state) {
            savedJson = (String) saved.invoke(state);
            retainedJson = (String) retained.invoke(state);
        }
        if (savedJson.getBytes(StandardCharsets.UTF_8).length + retainedJson.getBytes(StandardCharsets.UTF_8).length > MAX_STATE_BYTES)
            throw new IOException("Activity channels exceed the SDK bound");
        return new JSONObject().put("savedJson", savedJson).put("retainedJson", retainedJson);
    }

    private JSONObject persistentKv() throws Exception {
        File parent = new File(getFilesDir(), "podjs");
        if (!parent.exists()) return new JSONObject().put("exists", false).put("bytes", 0).put("sha256", JSONObject.NULL);
        checkDirectory(parent, getFilesDir());
        File file = child(parent, "podjs-kv.json");
        if (!file.exists()) return new JSONObject().put("exists", false).put("bytes", 0).put("sha256", JSONObject.NULL);
        byte[] bytes = readBytes(file, MAX_KV_BYTES);
        return new JSONObject().put("exists", true).put("sha256", sha256(bytes)).put("bytes", bytes.length);
    }

    private JSONObject event(String name, Activity observed) throws Exception {
        JSONObject value = new JSONObject().put("version", 1).put("runNonce", runNonce)
                .put("pid", pid).put("processInstance", processInstance).put("event", name)
                .put("eventSeq", ++eventSequence).put("uptimeMillis", SystemClock.uptimeMillis())
                .put("wallTimeMillis", System.currentTimeMillis());
        if (observed != null) value.put("taskId", observed.getTaskId())
                .put("activityInstance", Integer.toHexString(System.identityHashCode(observed)))
                .put("activityClass", observed.getClass().getName());
        return value;
    }

    private void acknowledge(JSONObject command, String status, JSONObject value, String error) throws Exception {
        String id = requireNonce(command, "id");
        File destination = child(acknowledgements, id + ".json");
        if (destination.exists()) { requireTerminalAck(command); return; }
        JSONObject ack = new JSONObject().put("version", 1).put("runNonce", runNonce).put("id", id)
                .put("pid", pid).put("processInstance", processInstance).put("op", command.optString("op"))
                .put("status", status).put("taskId", activity == null ? JSONObject.NULL : activity.getTaskId());
        if (value != null) ack.put("value", value);
        if (error != null) ack.put("error", error);
        writeExclusive(destination, ack);
        append(event("commandAcknowledged", activity).put("id", id).put("op", command.optString("op")).put("status", status));
    }

    private boolean terminalAckExists(JSONObject command) throws Exception {
        if (!child(acknowledgements, requireNonce(command, "id") + ".json").exists()) return false;
        requireTerminalAck(command);
        return true;
    }

    private void requireTerminalAck(JSONObject command) throws Exception {
        String id = requireNonce(command, "id");
        JSONObject result = readJson(child(acknowledgements, id + ".json"), 2 * MAX_STATE_BYTES);
        String status = result.optString("status");
        if (result.optInt("version") != 1 || !id.equals(result.optString("id"))
                || !runNonce.equals(result.optString("runNonce"))
                || !command.optString("op").equals(result.optString("op"))
                || !(status.equals("ok") || status.equals("error") || status.equals("interrupted")))
            throw new IOException("Existing terminal acknowledgement is invalid");
    }

    private void append(JSONObject value) throws Exception {
        File log = child(directory, "lifecycle.jsonl");
        byte[] bytes = (value.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        if (log.exists()) checkRegularFile(log);
        if (log.length() + bytes.length > MAX_LOG_BYTES) throw new IOException("Lifecycle log bound reached");
        try (FileOutputStream output = new FileOutputStream(log, true)) {
            output.write(bytes);
            output.flush();
            output.getFD().sync();
        }
    }

    private void failure(String stage, Activity observed, Exception error) {
        android.util.Log.e("ProcessDeathHarness", stage + ": " + error.getClass().getSimpleName());
        try { append(event("harnessError", observed).put("stage", stage).put("error", error.getClass().getSimpleName() + ": " + error.getMessage())); }
        catch (Exception ignored) { /* The external checker also rejects incomplete evidence. */ }
        finally { enabled = false; }
    }

    private boolean owned(Activity candidate) {
        return candidate != null && OWN_PACKAGE.equals(candidate.getPackageName())
                && OWN_ACTIVITY.equals(candidate.getClass().getName());
    }

    private PodRuntimeView requireView(Activity owner) throws Exception {
        if (!owned(owner)) throw new IOException("Wrong Activity");
        PodRuntimeView found = find(owner.getWindow().getDecorView());
        if (found == null) throw new IOException("Production PodRuntimeView is not attached");
        return found;
    }

    private static PodRuntimeView find(View view) {
        if (view instanceof PodRuntimeView) return (PodRuntimeView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                PodRuntimeView result = find(group.getChildAt(index));
                if (result != null) return result;
            }
        }
        return null;
    }

    private static long host(PodRuntimeView view) throws Exception {
        Field field = PodRuntimeView.class.getDeclaredField("host");
        field.setAccessible(true);
        return field.getLong(view);
    }

    private static Method method(String name, Class<?>... parameters) throws Exception {
        Method method = PodRuntimeView.class.getDeclaredMethod(name, parameters);
        method.setAccessible(true);
        return method;
    }

    private File ownDirectory(String name) throws Exception {
        File value = child(directory, name);
        if (!value.isDirectory() && !value.mkdir()) throw new IOException("Cannot create owned directory");
        checkDirectory(value, directory);
        return value;
    }

    private static void checkDirectory(File value, File parent) throws Exception {
        if (Files.isSymbolicLink(value.toPath()) || !value.isDirectory()
                || !value.getCanonicalFile().getParentFile().equals(parent.getCanonicalFile()))
            throw new IOException("Directory escapes its owned parent");
    }

    private static File child(File parent, String name) throws Exception {
        if (!name.matches("[A-Za-z0-9.-]+") || name.equals(".") || name.equals("..")) throw new IOException("Invalid fixed child name");
        File result = new File(parent, name);
        if (Files.isSymbolicLink(result.toPath()) || !result.getCanonicalFile().getParentFile().equals(parent.getCanonicalFile()))
            throw new IOException("File escapes its owned parent");
        return result;
    }

    private static void checkRegularFile(File file) throws IOException {
        if (Files.isSymbolicLink(file.toPath()) || !file.isFile()) throw new IOException("Expected an owned regular file");
    }

    private static byte[] readBytes(File file, int limit) throws Exception {
        checkRegularFile(file);
        if (file.length() > limit) throw new IOException("File exceeds bound");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[limit + 1];
            int total = 0;
            while (total < bytes.length) {
                int count = input.read(bytes, total, bytes.length - total);
                if (count < 0) break;
                total += count;
            }
            if (total > limit) throw new IOException("File exceeds bound");
            return Arrays.copyOf(bytes, total);
        }
    }

    private static JSONObject readJson(File file, int limit) throws Exception {
        return new JSONObject(new String(readBytes(file, limit), StandardCharsets.UTF_8));
    }

    private static void writeExclusive(File file, JSONObject value) throws Exception {
        if (file.exists()) throw new IOException("Receipt already exists");
        File temporary = Files.createTempFile(file.getParentFile().toPath(), ".receipt-", ".json").toFile();
        try {
            try (FileOutputStream output = new FileOutputStream(temporary, false)) {
                output.write((value.toString() + "\n").getBytes(StandardCharsets.UTF_8));
                output.flush();
                output.getFD().sync();
            }
            // The controller runs only in the package's default process and on its
            // main thread. No other producer may write claims or acknowledgements.
            if (file.exists()) throw new IOException("Receipt already exists");
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(temporary.toPath());
        }
    }

    private static void exactKeys(JSONObject value, String... expected) throws Exception {
        Set<String> wanted = new HashSet<>(Arrays.asList(expected));
        if (value.length() != wanted.size()) throw new IOException("Unexpected command/configuration keys");
        java.util.Iterator<String> keys = value.keys();
        while (keys.hasNext()) if (!wanted.remove(keys.next())) throw new IOException("Unexpected command/configuration key");
        if (!wanted.isEmpty()) throw new IOException("Missing command/configuration key");
    }

    private static int requireInteger(JSONObject value, String key, int minimum, int maximum) throws Exception {
        Object raw = value.opt(key);
        if (!(raw instanceof Number)) throw new IOException("Expected integer " + key);
        double number = ((Number) raw).doubleValue();
        if (!Double.isFinite(number) || number != Math.rint(number) || number < minimum || number > maximum)
            throw new IOException("Invalid integer " + key);
        return (int) number;
    }

    private static String requireString(JSONObject value, String key) throws Exception {
        Object raw = value.opt(key);
        if (!(raw instanceof String)) throw new IOException("Expected string " + key);
        return (String) raw;
    }

    private static String requireNonce(JSONObject value, String key) throws Exception {
        String result = requireString(value, key);
        if (!result.matches("[0-9a-f]{32}")) throw new IOException("Invalid nonce " + key);
        return result;
    }

    private static String nonce() { return UUID.randomUUID().toString().replace("-", ""); }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder result = new StringBuilder(64);
        for (byte value : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    private static final class Snapshot {
        final String token;
        final long host;
        final long hash;
        final JSONObject tree;
        Snapshot(String token, long host, long hash, JSONObject tree) {
            this.token = token;
            this.host = host;
            this.hash = hash;
            this.tree = tree;
        }
    }
}
