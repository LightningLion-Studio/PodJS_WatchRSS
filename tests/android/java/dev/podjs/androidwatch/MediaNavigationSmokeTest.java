package dev.podjs.androidwatch;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.TextureView;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Assume;
import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;

import dev.podjs.runtime.PodRuntimeView;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Navigation and login-entry smoke coverage for the built-in media pages. */
public final class MediaNavigationSmokeTest {
    private static final long TIMEOUT_MS = 20_000L;

    @Test public void biliLoginShowsQrAndReturnsToBiliThenHome() throws Exception {
        Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        Context target = registry.getTargetContext();
        Assume.assumeTrue("com.lightningstudio.watchrss.podjs".equals(target.getPackageName()));
        Activity activity = start(registry, target);
        try {
            TextureView texture = awaitTextureView(activity);
            awaitBitmap(registry, texture);
            tap(registry, activity, 233, 390); // Home -> 哔哩哔哩; physical 466px surface.
            awaitStable(registry, texture);
            tap(registry, activity, 233, 196); // Bili entry -> 登录.
            Bitmap login = awaitQr(registry, texture);
            try { save(login, new File(target.getFilesDir(), "watchrss-bili-login-qr.png")); }
            finally { login.recycle(); }
            assertTrue("Bili login route did not expose internal back", canNavigateBack(texture));

            registry.runOnMainSync(activity::onBackPressed);
            awaitStable(registry, texture);
            assertTrue("Bili entry route did not expose internal back", canNavigateBack(texture));
            registry.runOnMainSync(activity::onBackPressed);
            awaitStable(registry, texture);
            assertFalse("Bili back did not return to the home root", canNavigateBack(texture));
        } finally { registry.runOnMainSync(activity::finish); }
    }

    @Test public void douyinLoginEntryAndHorizontalBackStayWithinRoutes() throws Exception {
        Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        Context target = registry.getTargetContext();
        Assume.assumeTrue("com.lightningstudio.watchrss.podjs".equals(target.getPackageName()));
        Activity activity = start(registry, target);
        try {
            TextureView texture = awaitTextureView(activity);
            awaitBitmap(registry, texture);
            swipe(registry, activity, 233, 420, 233, 220);
            SystemClock.sleep(500L);
            tap(registry, activity, 233, 240); // Home -> 抖音 after vertical scroll; avoids 备忘录.
            awaitStable(registry, texture);
            tap(registry, activity, 233, 196); // 抖音 entry -> 登录入口.
            Bitmap login = getBitmap(registry, texture);
            assertNotNull("Douyin login-entry bitmap missing", login);
            try {
                save(login, new File(target.getFilesDir(), "watchrss-douyin-login-entry.png"));
                assertTrue("Douyin login entry did not expose internal back", canNavigateBack(texture));
            } finally { login.recycle(); }

            Bitmap beforeCancel = getBitmap(registry, texture);
            long down = SystemClock.uptimeMillis();
            dispatch(registry, activity, down, MotionEvent.ACTION_DOWN, 60, 233);
            dispatch(registry, activity, down, MotionEvent.ACTION_MOVE, 160, 233);
            dispatch(registry, activity, down, MotionEvent.ACTION_CANCEL, 160, 233);
            SystemClock.sleep(500L);
            Bitmap afterCancel = getBitmap(registry, texture);
            try { assertTrue("cancelled media back changed the login route", bitmapsEqual(beforeCancel, afterCancel)); }
            finally { beforeCancel.recycle(); afterCancel.recycle(); }

            down = SystemClock.uptimeMillis();
            dispatch(registry, activity, down, MotionEvent.ACTION_DOWN, 60, 233);
            dispatch(registry, activity, down, MotionEvent.ACTION_MOVE, 320, 233);
            dispatch(registry, activity, down, MotionEvent.ACTION_UP, 320, 233);
            awaitStable(registry, texture);
            assertTrue("committed media back did not return to Douyin entry", canNavigateBack(texture));
        } finally { registry.runOnMainSync(activity::finish); }
    }

    private static Activity start(Instrumentation registry, Context target) {
        return registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    private static Bitmap awaitQr(Instrumentation registry, TextureView texture) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            Bitmap bitmap = getBitmap(registry, texture);
            if (bitmap != null && whitePixels(bitmap) > 100) return bitmap;
            if (bitmap != null) bitmap.recycle();
            SystemClock.sleep(200L);
        }
        throw new AssertionError("Bili login QR texture did not become non-empty");
    }

    private static int whitePixels(Bitmap bitmap) {
        int count = 0;
        for (int y = 0; y < bitmap.getHeight(); y += 2)
            for (int x = 0; x < bitmap.getWidth(); x += 2) {
                int c = bitmap.getPixel(x, y);
                if (((c >> 16) & 255) > 220 && ((c >> 8) & 255) > 220 && (c & 255) > 220) count++;
            }
        return count;
    }

    private static void tap(Instrumentation registry, Activity activity, float x, float y) {
        long down = SystemClock.uptimeMillis();
        dispatch(registry, activity, down, MotionEvent.ACTION_DOWN, x, y);
        SystemClock.sleep(40L);
        dispatch(registry, activity, down, MotionEvent.ACTION_UP, x, y);
    }

    private static void swipe(Instrumentation registry, Activity activity, float sx, float sy, float ex, float ey) {
        long down = SystemClock.uptimeMillis();
        dispatch(registry, activity, down, MotionEvent.ACTION_DOWN, sx, sy);
        for (int i = 1; i <= 8; i++)
            dispatch(registry, activity, down, MotionEvent.ACTION_MOVE, sx + (ex - sx) * i / 8f, sy + (ey - sy) * i / 8f);
        dispatch(registry, activity, down, MotionEvent.ACTION_UP, ex, ey);
    }

    private static void dispatch(Instrumentation registry, Activity activity, long down,
                                 int action, float x, float y) {
        registry.runOnMainSync(() -> {
            MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0);
            activity.dispatchTouchEvent(event);
            event.recycle();
        });
        SystemClock.sleep(60L);
    }

    private static boolean canNavigateBack(TextureView texture) {
        final boolean[] result = new boolean[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                result[0] = texture instanceof PodRuntimeView && ((PodRuntimeView) texture).canNavigateBack());
        return result[0];
    }

    private static void awaitStable(Instrumentation registry, TextureView texture) {
        SystemClock.sleep(800L);
        Bitmap bitmap = getBitmap(registry, texture);
        assertNotNull("media route bitmap missing", bitmap);
        bitmap.recycle();
    }

    private static Bitmap getBitmap(Instrumentation registry, TextureView texture) {
        final Bitmap[] result = new Bitmap[1];
        registry.runOnMainSync(() -> result[0] = texture.getBitmap());
        return result[0];
    }

    private static boolean bitmapsEqual(Bitmap left, Bitmap right) {
        if (left == null || right == null || left.getWidth() != right.getWidth() || left.getHeight() != right.getHeight()) return false;
        for (int y = 0; y < left.getHeight(); y++) for (int x = 0; x < left.getWidth(); x++)
            if (left.getPixel(x, y) != right.getPixel(x, y)) return false;
        return true;
    }

    private static void save(Bitmap bitmap, File output) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(output)) {
            assertTrue("media screenshot could not be encoded", bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream));
        }
        assertTrue("media screenshot missing", output.isFile() && output.length() > 0);
    }

    private static void awaitBitmap(Instrumentation registry, TextureView texture) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            Bitmap bitmap = getBitmap(registry, texture);
            if (bitmap != null) { bitmap.recycle(); return; }
            SystemClock.sleep(100L);
        }
        throw new AssertionError("media renderer did not produce a bitmap");
    }

    private static TextureView awaitTextureView(Activity activity) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        TextureView found;
        while (((found = findTextureView(activity.getWindow().getDecorView())) == null || !found.isAvailable())
                && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100L);
        return found;
    }

    private static TextureView findTextureView(android.view.View view) {
        if (view instanceof PodRuntimeView) return (PodRuntimeView) view;
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                TextureView found = findTextureView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }
}
