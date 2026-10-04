package dev.podjs.androidwatch;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.PixelCopy;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Assume;
import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/** Captures only the original app window, excluding system charging overlays. */
public final class OriginalHomeReferenceTest {
    private static final long TIMEOUT_MS = 20_000L;

    @Test public void captureOriginalShareWindow() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context target = instrumentation.getTargetContext();
        Assume.assumeTrue("com.lightningstudio.watchrss.reference".equals(target.getPackageName()));
        Intent intent = new Intent().setClassName(target.getPackageName(), "com.lightningstudio.watchrss.ShareQrActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("extra_title", "分享视频")
                .putExtra("extra_link", "https://www.bilibili.com/video/BV1s18Y61E92")
                .putExtra("extra_qr_width_ratio", .7f);
        Activity activity = instrumentation.startActivitySync(intent);
        try { SystemClock.sleep(2200); captureWindow(activity, new File(target.getFilesDir(), "reference-share.png")); }
        finally { instrumentation.runOnMainSync(activity::finish); }
    }

    @Test public void captureOriginalEmptyHomeWindow() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context target = instrumentation.getTargetContext();
        Assume.assumeTrue("isolated WatchRSS reference package required", "com.lightningstudio.watchrss.reference".equals(target.getPackageName()));
        Intent intent = new Intent().setClassName(target.getPackageName(), "com.lightningstudio.watchrss.HomeFeedListActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        Activity activity = instrumentation.startActivitySync(intent);
        try {
            captureWindow(activity, new File(target.getFilesDir(), "reference-original-home.png"));
        } finally {
            instrumentation.runOnMainSync(activity::finish);
        }
    }

    @Test public void captureOriginalProfileWindow() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context target = instrumentation.getTargetContext();
        Assume.assumeTrue("isolated WatchRSS package required", "com.lightningstudio.watchrss.reference".equals(target.getPackageName()));
        Intent intent = new Intent().setClassName(target.getPackageName(), "com.lightningstudio.watchrss.ProfileActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        Activity activity = instrumentation.startActivitySync(intent);
        try {
            captureWindow(activity, new File(target.getFilesDir(), "reference-profile.png"));
        } finally {
            instrumentation.runOnMainSync(activity::finish);
        }
    }

    private static void captureWindow(Activity activity, File output) throws Exception {
        waitForWindow(activity);
        Bitmap bitmap = Bitmap.createBitmap(466, 466, Bitmap.Config.ARGB_8888);
        AtomicInteger result = new AtomicInteger(PixelCopy.ERROR_UNKNOWN);
        CountDownLatch copied = new CountDownLatch(1);
        PixelCopy.request(activity.getWindow(), bitmap, status -> { result.set(status); copied.countDown(); }, new Handler(Looper.getMainLooper()));
        assertTrue("PixelCopy timed out", copied.await(TIMEOUT_MS, TimeUnit.MILLISECONDS));
        assertEquals("PixelCopy failed", PixelCopy.SUCCESS, result.get());
        try (FileOutputStream stream = new FileOutputStream(output)) {
            assertTrue("PNG encoding failed", bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream));
        } finally { bitmap.recycle(); }
        assertTrue(output.isFile() && output.length() > 0);
    }

    private static void waitForWindow(Activity activity) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        while ((!activity.hasWindowFocus() || activity.getWindow().getDecorView().getWidth() < 1)
                && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100L);
        assertTrue("original activity window did not become ready", activity.getWindow().getDecorView().getWidth() > 0);
    }
}
