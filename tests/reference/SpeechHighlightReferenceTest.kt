package dev.podjs.androidwatch.reference

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.PixelCopy
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Actual production Compose UI, explicitly scripted state; no synthesis is requested. */
class SpeechHighlightReferenceTest {
    @Test fun captureTitle() = capture("highlight-title")
    @Test fun captureBody() = capture("highlight-body")
    @Test fun captureEmoji() = capture("emoji")
    private fun capture(mode: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        assertEquals("com.lightningstudio.watchrss.reference", context.packageName)
        val activity = instrumentation.startActivitySync(Intent().setClassName(context.packageName, "dev.podjs.androidwatch.reference.ReferenceRssActivity").putExtra("reader-mode", mode).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as Activity
        try {
            SystemClock.sleep(3800)
            val bitmap = Bitmap.createBitmap(466, 466, Bitmap.Config.ARGB_8888)
            val done = CountDownLatch(1); val status = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
            PixelCopy.request(activity.window, bitmap, { status.set(it); done.countDown() }, Handler(Looper.getMainLooper()))
            assertTrue(done.await(20, TimeUnit.SECONDS)); assertEquals(PixelCopy.SUCCESS, status.get())
            var visible = 0
            for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) if ((bitmap.getPixel(x, y) and 0xffffff) != 0) visible++
            assertTrue("empty playback frame", visible > 1000)
            FileOutputStream(File(context.getExternalFilesDir(null), "reference-$mode.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
}
