package dev.podjs.androidwatch.reference

import android.app.Instrumentation
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.PixelCopy
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

class BiliPlayerBlackBackgroundReferenceTest {
    @Test fun capturePureBlackPlaybackBackground() {
        val instrumentation: Instrumentation = InstrumentationRegistry.getInstrumentation()
        val target = instrumentation.targetContext
        assumeTrue("isolated reference package required", target.packageName == "com.lightningstudio.watchrss.reference")
        val activity = instrumentation.startActivitySync(
            Intent(target, ReferencePlayerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as Activity
        try {
            awaitWindow(activity)
            val bitmap = Bitmap.createBitmap(466, 466, Bitmap.Config.ARGB_8888)
            val status = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
            val copied = CountDownLatch(1)
            PixelCopy.request(activity.window, bitmap, { value -> status.set(value); copied.countDown() }, Handler(Looper.getMainLooper()))
            assertTrue("PixelCopy timed out", copied.await(20, TimeUnit.SECONDS))
            assertEquals(PixelCopy.SUCCESS, status.get())
            val output = File(target.filesDir, "reference-bili-black.png")
            FileOutputStream(output).use { stream -> assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) }
            bitmap.recycle()
            assertTrue(output.isFile && output.length() > 0)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
        }
    }

    private fun awaitWindow(activity: Activity) {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while ((!activity.hasWindowFocus() || activity.window.decorView.width < 1) && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(100)
        }
        assertTrue("reference player window did not become ready", activity.window.decorView.width > 0)
    }
}
