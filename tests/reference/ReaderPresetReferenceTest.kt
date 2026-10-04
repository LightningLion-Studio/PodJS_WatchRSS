package dev.podjs.androidwatch.reference

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.PixelCopy
import androidx.test.platform.app.InstrumentationRegistry
import com.lightningstudio.watchrss.WatchRssApplication
import com.lightningstudio.watchrss.data.reader.ReaderThemeMode
import org.junit.Test
import org.junit.Assert.*
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ReaderPresetReferenceTest {
    @Test fun captureDark() = capture(ReaderThemeMode.DARK)
    @Test fun captureLight() = capture(ReaderThemeMode.LIGHT)
    @Test fun captureAutomatic() = capture(ReaderThemeMode.SYSTEM)
    @Test fun captureAutomaticControls() = capture(ReaderThemeMode.SYSTEM, lower = true)
    @Test fun captureDarkMenu() = capture(ReaderThemeMode.DARK, lower = true, popup = true)

    private fun capture(mode: ReaderThemeMode, lower: Boolean = false, popup: Boolean = false) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        assertEquals("com.lightningstudio.watchrss.reference", context.packageName)
        val repository = (context.applicationContext as WatchRssApplication).container.readerPresetRepository
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (repository.presets.value.isEmpty() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
        assertTrue(repository.presets.value.isNotEmpty())
        val previous = repository.selection.value.mode
        instrumentation.runOnMainSync { repository.setThemeMode(mode) }
        val activity = instrumentation.startActivitySync(Intent().setClassName(context.packageName, "com.lightningstudio.watchrss.ReaderPresetActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as Activity
        try {
            var popupDrawable = true
            SystemClock.sleep(1500)
            if (lower) {
                repeat(if (popup) 5 else 3) {
                    val started = SystemClock.uptimeMillis()
                    fun event(action: Int, y: Float) = instrumentation.runOnMainSync {
                        val event = android.view.MotionEvent.obtain(started, SystemClock.uptimeMillis(), action, 233f, y, 0)
                        activity.dispatchTouchEvent(event); event.recycle()
                    }
                    event(android.view.MotionEvent.ACTION_DOWN, 330f)
                    for (step in 1..16) { SystemClock.sleep(20); event(android.view.MotionEvent.ACTION_MOVE, 330f - step * 10) }
                    SystemClock.sleep(400); event(android.view.MotionEvent.ACTION_MOVE, 170f)
                    event(android.view.MotionEvent.ACTION_UP, 170f)
                }
                SystemClock.sleep(600)
            }
            if (popup) {
                instrumentation.runOnMainSync {
                    val started = SystemClock.uptimeMillis()
                    for (action in listOf(android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_UP)) {
                        val event = android.view.MotionEvent.obtain(started, SystemClock.uptimeMillis(), action, 233f, 342f, 0)
                        activity.dispatchTouchEvent(event); event.recycle()
                    }
                }
                SystemClock.sleep(500)
                val root = android.view.inspector.WindowInspector.getGlobalWindowViews().lastOrNull { it.javaClass.simpleName.contains("PopupLayout") }
                assertNotNull("native preset dropdown missing", root)
                val parent = root!!.parent
                val surfaceField = parent.javaClass.getDeclaredField("mSurface").apply { isAccessible = true }
                val surface = surfaceField.get(parent) as android.view.Surface
                val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
                val done = CountDownLatch(1); val status = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
                PixelCopy.request(surface, bitmap, { status.set(it); done.countDown() }, Handler(Looper.getMainLooper()))
                assertTrue(done.await(20, TimeUnit.SECONDS)); assertEquals(PixelCopy.SUCCESS, status.get())
                var visiblePixels = 0
                for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) if (android.graphics.Color.alpha(bitmap.getPixel(x, y)) > 0) visiblePixels++
                popupDrawable = visiblePixels > 0
                FileOutputStream(File(context.getExternalFilesDir(null), "reference-reader-presets-menu-window.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                val position = IntArray(2); instrumentation.runOnMainSync { root.getLocationOnScreen(position) }
                File(context.getExternalFilesDir(null), "reference-reader-presets-menu-window.json").writeText(org.json.JSONObject().put("left", position[0]).put("top", position[1]).put("width", root.width).put("height", root.height).put("visiblePixels", visiblePixels).put("captureValid", popupDrawable).put("shown", root.isShown).put("alpha", root.alpha).put("hasWindowFocus", root.hasWindowFocus()).toString())
                bitmap.recycle()
            }
            val image = Bitmap.createBitmap(466, 466, Bitmap.Config.ARGB_8888)
            val done = CountDownLatch(1)
            val status = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
            PixelCopy.request(activity.window, image, { status.set(it); done.countDown() }, Handler(Looper.getMainLooper()))
            assertTrue(done.await(20, TimeUnit.SECONDS)); assertEquals(PixelCopy.SUCCESS, status.get())
            val suffix = if (popup) "-menu-activity" else if (lower) "-controls" else ""
            FileOutputStream(File(context.getExternalFilesDir(null), "reference-reader-presets-${mode.name.lowercase()}$suffix.png")).use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
            image.recycle()
            org.junit.Assume.assumeTrue("Native popup Surface returned a transparent frame; geometry is available but this is not visual capture evidence", popupDrawable)
        } finally { instrumentation.runOnMainSync { activity.finish(); repository.setThemeMode(previous) } }
    }
}
