package dev.podjs.androidwatch;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Rect;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.EditText;
import android.widget.TextView;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import org.junit.Test;

/** Runs with an onboarded WatchRSS test package on a disposable 466×466 round emulator. */
public final class NoteEditHintInstrumentationTest {
    private static final String HINT = "滚动滚轮调整光标位置，再次点击打开输入法";
    private static final String BODY = "直接输入原始文本";
    private static final String TITLE = "Crown fixture";
    private final Instrumentation test = InstrumentationRegistry.getInstrumentation();
    private Activity activity;

    @Test public void eachEditorEntryShowsHintAndDefersKeyboardUntilFirstTap() throws Exception {
        assertTrue(android.os.Build.HARDWARE.startsWith("ranchu"));
        String app = test.getTargetContext().getPackageName();
        activity = test.startActivitySync(new Intent().setClassName(app, "dev.podjs.androidwatch.MainActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        try {
            click("备忘录，纯文本编辑 · 手机同步");
            await(() -> node("备忘录") != null, "Notes list did not open");
            revealListControl("新建备忘录", true);
            click("新建备忘录");
            TextView newHint = awaitEntry();
            EditText body = body();
            test.runOnMainSync(() -> assertEquals(0, body.getSelectionStart()));
            capture("new-blank");
            test.runOnMainSync(() -> {
                StringBuilder note = new StringBuilder(TITLE).append('\n');
                for (int i = 1; i <= 35; i++) note.append("第").append(i).append("行　滚轮定位和正文编辑示例\n");
                body.setText(note.toString());
            });
            tap(233, 418);
            await(() -> body() == null, "Saved note did not leave the editor");
            test.runOnMainSync(() -> assertFalse(newHint.isAttachedToWindow()));

            revealListControl("备忘录：" + TITLE, false);
            click("备忘录：" + TITLE);
            click("编辑备忘录");
            TextView first = awaitEntry();
            assertNotSame(newHint, first);
            capture("existing-long");

            EditText existing = body();
            int[] initial = {0};
            test.runOnMainSync(() -> {
                initial[0] = existing.getSelectionStart();
                assertTrue("Fixture needs an editable next code point", initial[0] < existing.length());
                long now = SystemClock.uptimeMillis();
                rotate(-1, 0, now);
                assertEquals("AXIS_VSCROLL", initial[0] + 1, existing.getSelectionStart());
                rotate(0, 1, now + 300);
                assertEquals("AXIS_SCROLL", initial[0], existing.getSelectionStart());
                rotate(-1, 1, now + 600);
                assertEquals("dual axis must use VSCROLL once", initial[0] + 1, existing.getSelectionStart());
                assertSame(first, onlyToast());
                assertFalse("Rotary input opened the keyboard", imeVisible());
            });

            int beforeSwipe = initial[0] + 1;
            shell("input swipe 220 320 220 240 240");
            test.runOnMainSync(() -> {
                assertTrue("Swipe did not move the pre-IME cursor", existing.getSelectionStart() > beforeSwipe);
                assertFalse("Swipe opened the keyboard", imeVisible());
                assertGeometry(first, existing);
            });

            tap(233, 418);
            await(() -> body() == null && node("编辑备忘录") != null, "Editor did not return to reader");
            click("编辑备忘录");
            TextView reentered = awaitEntry();
            assertNotSame(first, reentered);
            test.runOnMainSync(() -> {
                assertFalse(first.isAttachedToWindow());
                assertEquals("Re-entry changed the reader anchor", initial[0], bodyOnMain().getSelectionStart());
            });
            SystemClock.sleep(500);
            int[] tapPoint = new int[2];
            test.runOnMainSync(() -> {
                assertSame(reentered, onlyToast());
                Rect shared = new Rect(), toast = new Rect();
                assertTrue(bodyOnMain().getGlobalVisibleRect(shared));
                assertTrue(reentered.getGlobalVisibleRect(toast));
                assertTrue("Fixture must tap the body through the toast", shared.intersect(toast));
                tapPoint[0] = shared.centerX();
                tapPoint[1] = shared.centerY();
            });
            tap(tapPoint[0], tapPoint[1]);
            await(() -> onMain(this::imeVisible), "First body tap did not open the IME");
            await(() -> onMain(() -> !reentered.isAttachedToWindow()), "Hint did not expire");
            test.runOnMainSync(() -> assertTrue(bodyOnMain().hasFocus()));
        } finally {
            test.runOnMainSync(activity::finish);
        }
    }

    private TextView awaitEntry() {
        await(() -> onMain(() -> !toasts().isEmpty() && toasts().get(0).isShown()), "Entry hint did not appear");
        TextView[] result = {null};
        test.runOnMainSync(() -> {
            EditText body = bodyOnMain();
            assertTrue("Body did not immediately get the native blinking cursor", body.hasFocus() && body.isCursorVisible());
            assertFalse("IME opened on editor entry", imeVisible());
            TextView toast = onlyToast();
            assertFalse(toast.isClickable());
            assertFalse(toast.isFocusable());
            assertNotNull(toast.getLayout());
            assertTrue("Round hint should fit in two lines", toast.getLineCount() <= 2);
            for (int line = 0; line < toast.getLineCount(); line++) {
                assertEquals("Hint text was truncated", 0, toast.getLayout().getEllipsisCount(line));
            }
            assertGeometry(toast, body);
            result[0] = toast;
        });
        return result[0];
    }

    private void assertGeometry(TextView toast, EditText body) {
        View root = activity.getWindow().getDecorView();
        assertEquals(466, root.getWidth());
        assertEquals(466, root.getHeight());
        int[] xy = new int[2];
        toast.getLocationOnScreen(xy);
        int toastTop = xy[1], toastBottom = toastTop + toast.getHeight();
        for (int x : new int[]{xy[0], xy[0] + toast.getWidth()}) {
            for (int y : new int[]{toastTop, toastBottom}) {
                assertTrue("Hint goes outside the circle", Math.hypot(x - 233, y - 233) <= 233);
            }
        }
        body.getLocationOnScreen(xy);
        int line = body.getLayout().getLineForOffset(body.getSelectionStart());
        int origin = xy[1] + body.getTotalPaddingTop() - body.getScrollY();
        int lineTop = origin + body.getLayout().getLineTop(line);
        int lineBottom = origin + body.getLayout().getLineBottom(line);
        assertTrue("Hint overlaps the cursor line", toastBottom <= lineTop || toastTop >= lineBottom);
    }

    private void rotate(float vertical, float rotary, long now) {
        MotionEvent.PointerProperties pointer = new MotionEvent.PointerProperties();
        pointer.id = 0;
        pointer.toolType = MotionEvent.TOOL_TYPE_MOUSE;
        MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
        coords.setAxisValue(MotionEvent.AXIS_VSCROLL, vertical);
        coords.setAxisValue(MotionEvent.AXIS_SCROLL, rotary);
        for (int i = 0; i < 6; i++) {
            MotionEvent event = MotionEvent.obtain(now, now + i * 40, MotionEvent.ACTION_SCROLL, 1,
                new MotionEvent.PointerProperties[]{pointer}, new MotionEvent.PointerCoords[]{coords},
                0, 0, 1, 1, 0, 0, InputDevice.SOURCE_ROTARY_ENCODER, 0);
            try { assertTrue(activity.dispatchGenericMotionEvent(event)); }
            finally { event.recycle(); }
        }
    }

    private EditText body() {
        EditText[] field = {null};
        test.runOnMainSync(() -> field[0] = bodyOnMain());
        return field[0];
    }

    private EditText bodyOnMain() {
        List<TextView> fields = new ArrayList<>();
        findText(activity.getWindow().getDecorView(), BODY, true, fields);
        return fields.isEmpty() ? null : (EditText) fields.get(0);
    }

    private TextView onlyToast() {
        List<TextView> hints = toasts();
        assertEquals("One hint per editor entry", 1, hints.size());
        return hints.get(0);
    }

    private List<TextView> toasts() {
        List<TextView> hints = new ArrayList<>();
        findText(activity.getWindow().getDecorView(), HINT, false, hints);
        return hints;
    }

    private static void findText(View view, String value, boolean edit, List<TextView> found) {
        if (view instanceof TextView) {
            TextView text = (TextView) view;
            if (edit ? text instanceof EditText && value.contentEquals(text.getHint())
                : !(text instanceof EditText) && value.contentEquals(text.getText())) found.add(text);
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) findText(group.getChildAt(i), value, edit, found);
        }
    }

    private boolean imeVisible() {
        WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
        return insets != null && insets.isVisible(WindowInsets.Type.ime());
    }

    private boolean onMain(BooleanSupplier condition) {
        boolean[] result = {false};
        test.runOnMainSync(() -> result[0] = condition.getAsBoolean());
        return result[0];
    }

    private void revealListControl(String label, boolean towardEnd) throws Exception {
        for (int attempt = 0; attempt < 8 && node(label) == null; attempt++) {
            shell(towardEnd ? "input swipe 233 365 233 145 300" : "input swipe 233 145 233 365 300");
            SystemClock.sleep(250);
        }
    }

    private void click(String label) throws Exception {
        await(() -> node(label) != null, "Missing accessible node: " + label);
        Rect bounds = new Rect();
        node(label).getBoundsInScreen(bounds);
        tap(bounds.centerX(), bounds.centerY());
    }

    private AccessibilityNodeInfo node(String label) {
        return findNode(test.getUiAutomation().getRootInActiveWindow(), label);
    }

    private static AccessibilityNodeInfo findNode(AccessibilityNodeInfo node, String label) {
        if (node == null) return null;
        if (label.contentEquals(String.valueOf(node.getContentDescription()))) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findNode(node.getChild(i), label);
            if (found != null) return found;
        }
        return null;
    }

    private void capture(String name) throws Exception {
        if ("true".equals(InstrumentationRegistry.getArguments().getString("captureEditHint"))) {
            // The native view can report visibility before its first composited frame.
            SystemClock.sleep(120);
            shell("screencap -p /data/local/tmp/notes-edit-hint-" + name + ".png");
        }
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
            SystemClock.sleep(35);
        } while (SystemClock.uptimeMillis() < deadline);
        fail(message);
    }
}
