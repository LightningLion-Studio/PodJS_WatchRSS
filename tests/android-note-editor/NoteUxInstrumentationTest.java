package dev.podjs.androidwatch;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.EditText;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.function.BooleanSupplier;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Uses an onboarded 466x466 round emulator with no preexisting notes. */
public final class NoteUxInstrumentationTest {
    private static final String BODY = "直接输入原始文本";
    private static final String EDIT = "编辑备忘录";
    private final Instrumentation test = InstrumentationRegistry.getInstrumentation();
    private Activity activity;

    @Before public void launch() throws Exception {
        assertTrue("Use a disposable emulator", android.os.Build.HARDWARE.startsWith("ranchu"));
        String app = test.getTargetContext().getPackageName();
        try (SQLiteDatabase db = SQLiteDatabase.openDatabase(test.getTargetContext()
                .getDatabasePath("podjs.sqlite").getPath(), null, SQLiteDatabase.OPEN_READWRITE)) {
            db.delete("memo_notes", null, null);
        }
        activity = test.startActivitySync(new Intent().setClassName(app, "dev.podjs.androidwatch.MainActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        await(() -> node("备忘录，纯文本编辑 · 手机同步") != null, "Home notes entry missing");
        tap(233, 257);
        await(() -> node("新建备忘录") != null, "Notes list missing");
    }

    @After public void finish() {
        if (activity != null) test.runOnMainSync(activity::finish);
    }

    @Test public void oneTapOutsidePaintEntersEditor() throws Exception {
        openReader();
        tap(281, 410); // 4 physical px outside the original 44 dp visual button.
        await(() -> field(BODY) != null, "One tap in the expanded hit target did not enter");
    }

    @Test public void bodyTapAndVerticalSwipeKeepReaderOpen() throws Exception {
        openReader();
        tap(82, 220);
        SystemClock.sleep(400);
        assertNull("Body tap opened the editor", field(BODY));
        shell("input swipe 110 225 110 95 300");
        SystemClock.sleep(300);
        assertNull("Swipe starting on the body opened the editor", field(BODY));
        shell("input swipe 233 410 233 230 300");
        SystemClock.sleep(400);
        assertNull("Vertical swipe opened the editor", field(BODY));
    }

    @Test public void editTapDuringCancelledBackDoesNotGetLost() throws Exception {
        openReader();
        shell("input swipe 118 190 75 190 180");
        tap(281, 410);
        await(() -> field(BODY) != null, "Edit tap during back settling was lost");
    }

    @Test public void closeAndInFlightSwipeConsumeOneEditor() throws Exception {
        openReader();
        tap(233, 410);
        await(() -> field(BODY) != null, "Edit button did not enter");
        AccessibilityNodeInfo close = node("保存并退出");
        assertNotNull(close);
        // The guest settles for 100–220 ms after releasing the back swipe.
        // Invoke the accessible close action while that commit is pending.
        shell("input swipe 18 233 273 233 280");
        boolean clicked = close.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        // If the swipe already removed the button, its one-level result
        // still has to be the reader. Record when both actions reached it.
        android.util.Log.i("NoteUxTest", "overlap close accepted=" + clicked);
        await(() -> field(BODY) == null, "Overlapping close failed to detach the editor");
        SystemClock.sleep(350);
        shell("screencap -p /data/local/tmp/note-ux-overlap.png");
        assertNull("Late swipe completion popped the reader to the list", node("新建备忘录"));
        assertNotNull("Reader missing after overlapping exit actions", node(EDIT));
    }

    @Test public void closeExistingReturnsToReaderWithSavedBody() throws Exception {
        openReader();
        tap(233, 410);
        await(() -> field(BODY) != null, "Edit button did not enter");
        writeBody("Reader update");
        tap(233, 418);
        awaitReaderAfterClose();
        assertSaved("Reader update");
        tap(233, 410);
        await(() -> field(BODY) != null, "Could not reopen existing editor");
        assertEquals("Reader update", bodyValue());
    }

    @Test public void swipeExistingReturnsToReader() throws Exception {
        openReader();
        tap(233, 410);
        await(() -> field(BODY) != null, "Edit button did not enter");
        writeBody("Swipe update");
        // Start inside the native body to exercise the Android touch stream.
        shell("input swipe 66 233 386 233 280");
        awaitReaderAfterClose();
        assertSaved("Swipe update");
    }

    @Test public void closeWhitespaceNewReturnsToListWithoutRecord() throws Exception {
        openNew();
        writeBody(" ");
        tap(233, 418);
        await(() -> field(BODY) == null && node("新建备忘录") != null, "New draft did not return to list");
        assertSaved();
    }

    @Test public void emptyTitleBodyAndCaretAreInsideCircle() throws Exception {
        openNew();
        EditText body = field(BODY), title = field("新建备忘录");
        assertNotNull(title);
        shell("screencap -p /data/local/tmp/note-ux-empty.png");
        test.runOnMainSync(() -> {
            assertTrue(activity.getResources().getConfiguration().isScreenRound());
            assertFirstLineInCircle(title, 0);
            assertFirstLineInCircle(body, 2); // Unfocused caret extends left of the text.
        });
    }

    private void openNew() throws Exception {
        tap(233, 294);
        await(() -> field(BODY) != null, "New editor missing");
    }

    private void openReader() throws Exception {
        openNew();
        writeBody("Note UX fixture");
        tap(233, 418);
        await(() -> node("备忘录：Note UX fixture") != null, "Fixture did not return to list");
        tap(233, 354);
        await(() -> node(EDIT) != null, "Reader edit button missing");
    }

    private void awaitReaderAfterClose() {
        await(() -> field(BODY) == null && node(EDIT) != null, "Close skipped or failed to reach the reader");
        assertNull("Close routed to the notes list", node("新建备忘录"));
    }

    private void assertSaved(String... expected) {
        try (SQLiteDatabase db = SQLiteDatabase.openDatabase(test.getTargetContext()
                .getDatabasePath("podjs.sqlite").getPath(), null, SQLiteDatabase.OPEN_READONLY);
             Cursor rows = db.rawQuery("SELECT markdown FROM memo_notes WHERE deleted=0", null)) {
            assertEquals(expected.length, rows.getCount());
            for (String value : expected) {
                assertTrue(rows.moveToNext());
                assertEquals(value, rows.getString(0));
            }
        }
    }

    private void writeBody(String value) {
        EditText body = field(BODY);
        assertNotNull(body);
        test.runOnMainSync(() -> body.setText(value));
        test.waitForIdleSync();
    }

    private String bodyValue() {
        EditText body = field(BODY);
        String[] value = {null};
        test.runOnMainSync(() -> value[0] = body.getText().toString());
        return value[0];
    }

    private static void assertFirstLineInCircle(EditText field, int overhang) {
        int[] xy = new int[2];
        field.getLocationOnScreen(xy);
        assertNotNull(field.getLayout());
        View root = field.getRootView();
        double cx = root.getWidth() / 2.0, cy = root.getHeight() / 2.0;
        double radius = Math.min(cx, cy);
        int left = xy[0] + field.getCompoundPaddingLeft() - overhang;
        int right = xy[0] + field.getWidth() - field.getCompoundPaddingRight() + overhang;
        int top = xy[1] + field.getTotalPaddingTop() + field.getLayout().getLineTop(0);
        int bottom = xy[1] + field.getTotalPaddingTop() + field.getLayout().getLineBottom(0);
        for (int x : new int[]{left, right}) for (int y : new int[]{top, bottom}) {
            assertTrue("Unsafe line for " + field.getHint() + " at " + x + "," + y,
                    Math.hypot(x - cx, y - cy) <= radius);
        }
    }

    private EditText field(String hint) {
        EditText[] result = {null};
        test.runOnMainSync(() -> result[0] = findField(activity.getWindow().getDecorView(), hint));
        return result[0];
    }

    private static EditText findField(View view, String hint) {
        if (view instanceof EditText && hint.contentEquals(((EditText)view).getHint())) return (EditText)view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            for (int i = 0; i < group.getChildCount(); i++) {
                EditText found = findField(group.getChildAt(i), hint);
                if (found != null) return found;
            }
        }
        return null;
    }

    private AccessibilityNodeInfo node(String label) {
        return findNode(test.getUiAutomation().getRootInActiveWindow(), label);
    }

    private static AccessibilityNodeInfo findNode(AccessibilityNodeInfo node, String label) {
        if (node == null) return null;
        if (label.equals(String.valueOf(node.getContentDescription()))) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findNode(node.getChild(i), label);
            if (found != null) return found;
        }
        return null;
    }

    private void tap(int x, int y) throws Exception {
        shell("input tap " + x + " " + y);
    }

    private void shell(String command) throws Exception {
        try (ParcelFileDescriptor.AutoCloseInputStream output = new ParcelFileDescriptor.AutoCloseInputStream(
                test.getUiAutomation().executeShellCommand(command))) {
            output.readAllBytes();
        }
    }

    private static void await(BooleanSupplier ready, String message) {
        long deadline = SystemClock.uptimeMillis() + 6500;
        do {
            if (ready.getAsBoolean()) return;
            SystemClock.sleep(50);
        } while (SystemClock.uptimeMillis() < deadline);
        fail(message);
    }
}
