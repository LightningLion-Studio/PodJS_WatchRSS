package dev.podjs.androidwatch;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import org.junit.Test;

/**
 * Run on an onboarded debug app on a disposable 466x466 Wear OS emulator
 * with English QWERTY Gboard and an initially empty notes list.
 */
public final class NoteExitInstrumentationTest {
    private static final String APP = "com.lightningstudio.watchrss.podjs";
    private static final String BODY_HINT = "直接输入原始文本";

    @Test public void softKeyboardThenCloseButtonSavesAndReturnsToList() throws Exception {
        verifyExit(false, 92, "saa");
    }

    @Test public void softKeyboardThenSwipeBackSavesAndReturnsToList() throws Exception {
        verifyExit(true, 138, "daa");
    }

    private void verifyExit(boolean swipeBack, int firstKeyX, String expected) throws Exception {
        Instrumentation test = InstrumentationRegistry.getInstrumentation();
        Context context = test.getTargetContext();
        assertEquals(APP, context.getPackageName());
        assertTrue("Use a disposable emulator", android.os.Build.FINGERPRINT.contains("generic")
                || android.os.Build.HARDWARE.startsWith("ranchu"));
        Activity activity = test.startActivitySync(new Intent().setClassName(APP,
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            waitFor(() -> hasDescription(test.getUiAutomation().getRootInActiveWindow(),
                    "备忘录，纯文本编辑 · 手机同步"), "Notes entry missing");
            shell(test, "input tap 233 257");
            waitFor(() -> hasDescription(test.getUiAutomation().getRootInActiveWindow(), "备忘录"),
                    "Notes list missing");
            List<String> before = savedBodies(context);
            assertTrue("Start with an empty notes list", before.size() <= 1);
            if (before.size() == 1) {
                shell(test, "input swipe 233 397 233 180 300");
                SystemClock.sleep(600);
            }
            shell(test, "input tap 233 " + (before.isEmpty() ? 294 : 383));
            waitFor(() -> bodyField(test, activity) != null, "Note editor body missing");
            EditText body = bodyField(test, activity);
            tapBody(test, body);
            if (!imeVisible(test)) tapBody(test, body);
            waitFor(() -> imeVisible(test), "Gboard did not open");
            SystemClock.sleep(400);
            for (int x : new int[]{firstKeyX, 44, 44}) shell(test, "input tap " + x + " 271");
            SystemClock.sleep(400);
            shell(test, "input tap 133 136"); // Commit the composed word in Gboard.

            // Dismiss via the IME. Android Back would also exercise the app's
            // navigation callback on some Wear OS versions.
            test.runOnMainSync(() -> context.getSystemService(InputMethodManager.class)
                    .hideSoftInputFromWindow(body.getWindowToken(), 0));
            waitFor(() -> !imeVisible(test), "Gboard remained visible");
            String[] value = {""};
            test.runOnMainSync(() -> value[0] = body.getText().toString());
            assertTrue("Gboard text was not committed: " + value[0],
                    expected.equalsIgnoreCase(value[0].trim()));
            assertTrue("Editor closed before the tested action", body.isAttachedToWindow());

            shell(test, swipeBack ? "input swipe 20 233 397 233 300" : "input tap 233 418");
            waitFor(() -> hasDescription(test.getUiAutomation().getRootInActiveWindow(),
                    "备忘录：" + value[0].trim()), "Saved note did not appear in the list");
            assertNull("Editor body still mounted", bodyField(test, activity));
            List<String> after = new ArrayList<>(before);
            after.add(value[0]);
            assertEquals("Raw body must be saved in exactly one new note", after, savedBodies(context));
        } finally {
            test.runOnMainSync(activity::finish);
        }
    }

    private static void tapBody(Instrumentation test, EditText body) throws Exception {
        int[] position = new int[2];
        test.runOnMainSync(() -> body.getLocationOnScreen(position));
        shell(test, "input tap " + (position[0] + 70) + " " + (position[1] + 17));
        SystemClock.sleep(500);
    }

    private static String shell(Instrumentation test, String command) throws Exception {
        try (ParcelFileDescriptor.AutoCloseInputStream output = new ParcelFileDescriptor.AutoCloseInputStream(
                test.getUiAutomation().executeShellCommand(command))) {
            return new String(output.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static boolean imeVisible(Instrumentation test) {
        try {
            String windows = shell(test, "dumpsys window windows");
            for (String window : windows.split("(?m)^  Window #")) {
                if (window.contains(" InputMethod}:") && window.contains("isVisible=true")) return true;
            }
            return false;
        } catch (Exception error) {
            throw new AssertionError("Could not inspect IME window", error);
        }
    }

    private static EditText bodyField(Instrumentation test, Activity activity) {
        EditText[] field = {null};
        test.runOnMainSync(() -> field[0] = findBody(activity.getWindow().getDecorView()));
        return field[0];
    }

    private static EditText findBody(View view) {
        if (view instanceof EditText && BODY_HINT.contentEquals(((EditText) view).getHint())) return (EditText) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                EditText body = findBody(group.getChildAt(i));
                if (body != null) return body;
            }
        }
        return null;
    }

    private static boolean hasDescription(AccessibilityNodeInfo node, String description) {
        if (node == null) return false;
        if (description.contentEquals(node.getContentDescription() == null ? "" : node.getContentDescription()))
            return true;
        for (int i = 0; i < node.getChildCount(); i++) {
            if (hasDescription(node.getChild(i), description)) return true;
        }
        return false;
    }

    private static List<String> savedBodies(Context context) {
        List<String> bodies = new ArrayList<>();
        try (SQLiteDatabase db = SQLiteDatabase.openDatabase(
                context.getDatabasePath("podjs.sqlite").getPath(), null, SQLiteDatabase.OPEN_READONLY);
             Cursor rows = db.rawQuery("SELECT markdown FROM memo_notes WHERE deleted=0 ORDER BY rowid", null)) {
            while (rows.moveToNext()) bodies.add(rows.getString(0));
        }
        return bodies;
    }

    private static void waitFor(BooleanSupplier ready, String message) {
        long deadline = SystemClock.uptimeMillis() + 8000;
        do {
            if (ready.getAsBoolean()) return;
            SystemClock.sleep(100);
        } while (SystemClock.uptimeMillis() < deadline);
        fail(message);
    }
}
