package dev.podjs.tests.fontscale;

import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.content.pm.InstrumentationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.TypedValue;

import androidx.test.runner.AndroidJUnitRunner;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.IdentityHashMap;
import java.util.Arrays;
import java.util.Map;
import java.util.Objects;

/** Test-APK-only configuration injection. Never writes a process or system configuration. */
abstract class IsolatedFontScaleRunner extends AndroidJUnitRunner {
    private final FontScalePolicy policy;
    private final Map<Activity, ActivityEvidence> activities = new IdentityHashMap<>();
    private final JSONArray events = new JSONArray();
    private final JSONArray failures = new JSONArray();
    private final JSONObject evidence = new JSONObject();
    private float expectedFontScale;
    private ResourceSnapshot targetBaseline;
    private ResourceSnapshot systemBaseline;
    private ResourceSnapshot applicationBaseline;
    private Application application;
    private String settingBaseline;
    private File evidenceFile;
    private boolean configured;
    private int instanceCount;

    IsolatedFontScaleRunner(FontScalePolicy policy) {
        this.policy = policy;
    }

    @Override public void onCreate(Bundle arguments) {
        // No target resource or file access is authorized until both package identities pass.
        expectedFontScale = policy.validate(getTargetContext().getPackageName(),
                getContext().getPackageName(), getClass().getName(),
                arguments == null ? null : arguments.get("fontScale"));
        try {
            InstrumentationInfo info = getContext().getPackageManager()
                    .getInstrumentationInfo(getComponentName(), 0);
            FontScalePolicy.require(policy.targetPackage.equals(info.targetPackage)
                            && policy.testPackage.equals(info.packageName)
                            && policy.runnerClass.equals(info.name)
                            && policy.testPackage.equals(getComponentName().getPackageName()),
                    "Installed instrumentation metadata does not match the isolated runner");
        } catch (PackageManager.NameNotFoundException error) {
            throw new IllegalStateException("Cannot verify installed instrumentation identity", error);
        }
        targetBaseline = new ResourceSnapshot(getTargetContext().getResources());
        systemBaseline = new ResourceSnapshot(Resources.getSystem());
        settingBaseline = readSetting();
        File directory = getTargetContext().getExternalFilesDir("font-scale-runner");
        FontScalePolicy.require(directory != null && (directory.isDirectory() || directory.mkdirs()),
                "Isolated target externalFilesDir is unavailable");
        evidenceFile = new File(directory, "font-scale-" + expectedFontScale + "-"
                + System.currentTimeMillis() + "-" + android.os.Process.myPid() + ".json");
        configured = true;
        put(evidence, "schemaVersion", 1);
        put(evidence, "runner", getClass().getName());
        put(evidence, "targetPackage", policy.targetPackage);
        put(evidence, "testPackage", policy.testPackage);
        put(evidence, "expectedFontScale", expectedFontScale);
        put(evidence, "targetBaseline", targetBaseline.json());
        put(evidence, "systemBaseline", systemBaseline.json());
        put(evidence, "settingsSystemFontScaleBaseline", nullable(settingBaseline));
        put(evidence, "events", events);
        put(evidence, "failures", failures);
        put(evidence, "finished", false);
        writeEvidence();
        checked("runner_onCreate", () -> {
            super.onCreate(arguments);
            assertGlobals("runner_after_onCreate");
        });
    }

    @Override public void callApplicationOnCreate(Application app) {
        checked("application_onCreate", () -> {
            FontScalePolicy.require(configured, "Runner was not configured before Application.onCreate");
            FontScalePolicy.require(application == null, "Unexpected second Application instance");
            FontScalePolicy.require(policy.targetPackage.equals(app.getPackageName()),
                    "Application is not the isolated target package");
            application = app;
            applicationBaseline = new ResourceSnapshot(app.getResources());
            put(evidence, "applicationBaseline", applicationBaseline.json());
            assertGlobals("application_before_onCreate");
            super.callApplicationOnCreate(app);
            assertGlobals("application_after_onCreate");
            writeEvidence();
        });
    }

    @Override public Activity newActivity(ClassLoader classLoader, String className, Intent intent)
            throws InstantiationException, IllegalAccessException, ClassNotFoundException {
        Activity activity = super.newActivity(classLoader, className, intent);
        // API 30 ActivityThread calls attach/PhoneWindow/setTheme AFTER this method returns.
        // callActivityOnCreate is too late: ContextThemeWrapper may already cache Resources.
        // Do not inspect this unattached Activity's resources, application or package.
        if (policy.acceptsActivity(activity.getClass().getName())) {
            try {
                FontScalePolicy.require(configured && applicationBaseline != null,
                        "Global baselines must exist before Activity construction");
                FontScalePolicy.require(className.equals(activity.getClass().getName()),
                        "Activity factory substituted a different class");
                FontScalePolicy.require(activity.getBaseContext() == null,
                        "Activity is already attached; refusing a late configuration override");
                Configuration delta = new Configuration();
                delta.fontScale = expectedFontScale;
                // On API 30 this only copies delta; it does not access base Context or Resources.
                activity.applyOverrideConfiguration(delta);
                ActivityEvidence state = new ActivityEvidence(activity, ++instanceCount);
                activities.put(activity, state);
                JSONObject event = state.event("newActivity_override_applied");
                put(event, "baseContextWasNull", true);
                put(event, "overrideApplied", true);
                put(event, "deltaFontScale", delta.fontScale);
                events.put(event);
                assertGlobals("newActivity_after_override");
                writeEvidence();
            } catch (RuntimeException | Error error) {
                recordFailure("newActivity:" + className, error);
                throw error;
            }
        } else {
            FontScalePolicy.require(!policy.acceptsActivity(className),
                    "Activity factory substituted an unapproved class for " + className);
        }
        return activity;
    }

    @Override public void callActivityOnCreate(Activity activity, Bundle savedInstanceState) {
        createActivity(activity, () -> super.callActivityOnCreate(activity, savedInstanceState));
    }

    @Override public void callActivityOnCreate(Activity activity, Bundle savedInstanceState,
            PersistableBundle persistentState) {
        createActivity(activity,
                () -> super.callActivityOnCreate(activity, savedInstanceState, persistentState));
    }

    private void createActivity(Activity activity, Runnable create) {
        if (!policy.acceptsActivity(activity.getClass().getName())) {
            create.run();
            return;
        }
        checked("activity_onCreate:" + activity.getClass().getName(), () -> {
            ActivityEvidence state = activities.get(activity);
            FontScalePolicy.require(state != null,
                    "Allowed Activity bypassed newActivity; refusing a late override");
            assertActivity(activity, state, "before_onCreate");
            create.run();
            assertActivity(activity, state, "after_onCreate");
            state.onCreateCompleted = true;
            boolean posted = new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        assertActivity(activity, state, "next_main_loop");
                        state.nextLoopCompleted = true;
                        writeEvidence();
                    } catch (RuntimeException | Error error) {
                        // Persist asynchronous failure and let finish report a failing result.
                        // An uncaught main-thread exception could kill instrumentation first.
                        recordFailure("next_main_loop:" + state.className, error);
                    }
                });
            FontScalePolicy.require(posted, "Could not enqueue next-main-loop verification");
        });
    }

    private void assertActivity(Activity activity, ActivityEvidence state, String phase) {
        FontScalePolicy.require(Looper.myLooper() == Looper.getMainLooper(),
                "Activity verification must execute on the main thread");
        Resources resources = activity.getResources();
        ResourceSnapshot actual = new ResourceSnapshot(resources);
        JSONObject event = state.event(phase);
        put(event, "actualActivityResources", actual.json());
        put(event, "actualFontScale", actual.configuration.fontScale);
        put(event, "actualDensity", actual.metrics.density);
        put(event, "actualDensityDpi", actual.metrics.densityDpi);
        events.put(event);
        writeEvidence(); // Preserve actual values even if the following assertion fails.
        FontScalePolicy.require(sameFloat(expectedFontScale, actual.configuration.fontScale),
                phase + ": Activity fontScale is " + actual.configuration.fontScale
                        + ", expected " + expectedFontScale);
        FontScalePolicy.require(sameFloat(targetBaseline.metrics.density, actual.metrics.density)
                        && targetBaseline.metrics.densityDpi == actual.metrics.densityDpi
                        && targetBaseline.configuration.densityDpi == actual.configuration.densityDpi,
                phase + ": Activity density changed from the target baseline");
        assertGlobals(phase);
        writeEvidence();
    }

    private void assertGlobals(String phase) {
        FontScalePolicy.require(configured, "Global baselines are not initialized");
        ResourceSnapshot target = new ResourceSnapshot(getTargetContext().getResources());
        ResourceSnapshot system = new ResourceSnapshot(Resources.getSystem());
        ResourceSnapshot app = application == null ? null : new ResourceSnapshot(application.getResources());
        String setting = readSetting();
        JSONObject event = new JSONObject();
        put(event, "phase", phase + "_global_check");
        put(event, "target", target.json());
        put(event, "system", system.json());
        put(event, "application", app == null ? JSONObject.NULL : app.json());
        put(event, "settingsSystemFontScale", nullable(setting));
        boolean unchanged = targetBaseline.matches(target) && systemBaseline.matches(system)
                && (applicationBaseline == null || applicationBaseline.matches(app))
                && Objects.equals(settingBaseline, setting);
        put(event, "unchanged", unchanged);
        events.put(event);
        FontScalePolicy.require(unchanged, phase
                + ": Application/target/system resources or Settings.System.FONT_SCALE changed"
                + " (including an external system change); inspect recorded snapshots");
    }

    @Override public void finish(int resultCode, Bundle results) {
        Bundle finalResults = results == null ? new Bundle() : new Bundle(results);
        if (configured) {
            Runnable finishChecks = () -> checked("before_finish", () -> {
                assertGlobals("before_finish");
                FontScalePolicy.require(applicationBaseline != null, "Application baseline is missing");
                FontScalePolicy.require(instanceCount > 0, "No allowlisted real Activity was exercised");
                for (ActivityEvidence state : activities.values()) {
                    FontScalePolicy.require(state.onCreateCompleted && state.nextLoopCompleted,
                            "Incomplete lifecycle evidence for " + state.className + " #" + state.sequence);
                }
            });
            try {
                if (Looper.myLooper() == Looper.getMainLooper()) finishChecks.run();
                else runOnMainSync(finishChecks);
            } catch (RuntimeException | Error error) {
                // checked() recorded this. Finish instrumentation with a failing result below.
            }
            synchronized (this) {
                put(evidence, "finished", true);
                put(evidence, "activityInstanceCount", instanceCount);
                put(evidence, "runnerAssertionsPassed", failures.length() == 0);
                put(evidence, "originalInstrumentationResultCode", resultCode);
                finalResults.putString("fontScaleEvidence", evidenceFile.getAbsolutePath());
                if (failures.length() > 0) {
                    resultCode = Activity.RESULT_CANCELED;
                    finalResults.putString("stream", finalResults.getString("stream", "")
                            + "\nIsolated font-scale runner failed: " + failures.toString() + "\n");
                    finalResults.putString("shortMsg", "Isolated font-scale runner assertions failed");
                }
                put(evidence, "finalInstrumentationResultCode", resultCode);
                writeEvidence();
            }
        }
        super.finish(resultCode, finalResults);
    }

    @Override public boolean onException(Object object, Throwable error) {
        if (configured) recordFailure("instrumentation_exception", error);
        return super.onException(object, error);
    }

    private String readSetting() {
        return Settings.System.getString(getTargetContext().getContentResolver(), Settings.System.FONT_SCALE);
    }

    private void checked(String phase, Runnable action) {
        try {
            action.run();
        } catch (RuntimeException | Error error) {
            recordFailure(phase, error);
            throw error;
        }
    }

    private synchronized void recordFailure(String phase, Throwable error) {
        JSONObject failure = new JSONObject();
        put(failure, "phase", phase);
        put(failure, "error", error.toString());
        failures.put(failure);
        try {
            writeEvidence();
        } catch (RuntimeException writeError) {
            error.addSuppressed(writeError);
        }
    }

    private synchronized void writeEvidence() {
        if (evidenceFile == null) return;
        File pending = new File(evidenceFile.getParentFile(), evidenceFile.getName() + ".pending");
        try (FileOutputStream output = new FileOutputStream(pending)) {
            output.write(evidence.toString(2).getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        } catch (IOException | JSONException error) {
            throw new IllegalStateException("Cannot write isolated font-scale evidence", error);
        }
        FontScalePolicy.require(pending.renameTo(evidenceFile), "Cannot publish font-scale evidence file");
    }

    private static final class ActivityEvidence {
        final String className;
        final String identity;
        final int sequence;
        boolean onCreateCompleted;
        boolean nextLoopCompleted;

        ActivityEvidence(Activity activity, int sequence) {
            this.className = activity.getClass().getName();
            this.identity = Integer.toHexString(System.identityHashCode(activity));
            this.sequence = sequence;
        }

        JSONObject event(String phase) {
            JSONObject event = new JSONObject();
            put(event, "phase", phase);
            put(event, "actualActivityClass", className);
            put(event, "activityIdentity", identity);
            put(event, "instanceSequence", sequence);
            put(event, "overrideApplied", true);
            return event;
        }
    }

    private static final class ResourceSnapshot {
        private static final float[] SP_SAMPLES = {8f, 12f, 14f, 20f, 30f, 100f};
        final Configuration configuration;
        final DisplayMetrics metrics;
        final int[] spToPxBits;

        ResourceSnapshot(Resources resources) {
            // Resources returns mutable shared objects: retaining those would hide global writes.
            configuration = new Configuration(resources.getConfiguration());
            metrics = new DisplayMetrics();
            metrics.setTo(resources.getDisplayMetrics());
            // Newer APIs have a hidden converter reference not covered by DisplayMetrics.equals.
            // Freeze its public observable behavior now; never reflect on hidden APIs.
            spToPxBits = new int[SP_SAMPLES.length];
            for (int index = 0; index < SP_SAMPLES.length; index++) {
                spToPxBits[index] = Float.floatToIntBits(TypedValue.applyDimension(
                        TypedValue.COMPLEX_UNIT_SP, SP_SAMPLES[index], metrics));
            }
        }

        boolean matches(ResourceSnapshot other) {
            return other != null && configuration.equals(other.configuration) && metrics.equals(other.metrics)
                    && Arrays.equals(spToPxBits, other.spToPxBits);
        }

        JSONObject json() {
            JSONObject value = new JSONObject();
            put(value, "configuration", configuration.toString());
            put(value, "displayMetrics", metrics.toString());
            put(value, "fontScale", configuration.fontScale);
            put(value, "configurationDensityDpi", configuration.densityDpi);
            put(value, "density", metrics.density);
            put(value, "densityDpi", metrics.densityDpi);
            put(value, "scaledDensity", metrics.scaledDensity);
            put(value, "widthPixels", metrics.widthPixels);
            put(value, "heightPixels", metrics.heightPixels);
            put(value, "xdpi", metrics.xdpi);
            put(value, "ydpi", metrics.ydpi);
            JSONArray samples = new JSONArray();
            for (int index = 0; index < SP_SAMPLES.length; index++) {
                JSONObject sample = new JSONObject();
                put(sample, "sp", SP_SAMPLES[index]);
                put(sample, "pxFloatBits", spToPxBits[index]);
                samples.put(sample);
            }
            put(value, "spToPxSamples", samples);
            return value;
        }
    }

    private static boolean sameFloat(float first, float second) {
        return Float.floatToIntBits(first) == Float.floatToIntBits(second);
    }

    private static Object nullable(Object value) {
        return value == null ? JSONObject.NULL : value;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException error) {
            throw new IllegalStateException("Invalid evidence value for " + key, error);
        }
    }
}
