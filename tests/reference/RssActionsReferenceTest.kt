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
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

class RssActionsReferenceTest {
    @Test fun captureAiPreset() = capture(false, "reference-ai-preset.png", aiMode = "preset")
    @Test fun captureAiUsage() = capture(false, "reference-ai-usage.png", aiMode = "usage")
    @Test fun captureAiUsageEmpty() = capture(false, "reference-ai-usage-empty.png", aiMode = "usage-empty")
    @Test fun captureAiUsageConfirm() = capture(false, "reference-ai-usage-confirm.png", aiMode = "usage-confirm")
    @Test fun captureRssActions() = capture(false, "reference-rss-actions.png")
    @Test fun captureAutoScroll() = capture(true, "reference-auto-scroll.png")
    @Test fun captureImagePreview() = capture(false, "reference-image-preview.png", true)
    @Test fun captureMissingLocalImagePreview() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val missing = File(context.filesDir, "missing-local-image-preview.jpg")
        missing.delete()
        capture(false, "reference-image-preview-missing-local.png", true, imagePath = missing.path)
    }
    @Test fun captureImagePreviewLarge() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assumeTrue("isolated reference package required", context.packageName == "com.lightningstudio.watchrss.reference")
        val source = File(context.filesDir, "reference-large-image.jpg")
        val width = 1031
        val height = 513
        val colors = IntArray(width * height)
        for (y in 0 until height) for (x in 0 until width) {
            colors[y * width + x] = 0xff000000.toInt() or
                (((x * 17 + y * 3) and 255) shl 16) or
                (((x * 5 + y * 11) and 255) shl 8) or
                ((x * 7 + y * 13) and 255)
        }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.setPixels(colors, 0, width, 0, 0, width, height)
        FileOutputStream(source).use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
        bitmap.recycle()
        val sourceSha256 = MessageDigest.getInstance("SHA-256").digest(source.readBytes())
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        File(context.getExternalFilesDir(null), "native-large-image-source.sha256")
            .writeText("$sourceSha256\n")
        source.copyTo(File(context.getExternalFilesDir(null), "native-large-image-source.jpg"), overwrite = true)
        try { capture(false, "reference-large-image-preview.png", true, imagePath = source.path) }
        finally { source.delete() }
    }
    @Test fun captureImagePreviewSampledLarge() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assumeTrue("isolated reference package required", context.packageName == "com.lightningstudio.watchrss.reference")
        val source = File(context.filesDir, "reference-large-sampled.jpg")
        val width = 2053
        val height = 1027
        val colors = IntArray(width * height)
        for (y in 0 until height) for (x in 0 until width) {
            colors[y * width + x] = 0xff000000.toInt() or
                (((x * 17 + y * 3) and 255) shl 16) or
                (((x * 5 + y * 11) and 255) shl 8) or
                ((x * 7 + y * 13) and 255)
        }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.setPixels(colors, 0, width, 0, 0, width, height)
        FileOutputStream(source).use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
        bitmap.recycle()
        val sha = MessageDigest.getInstance("SHA-256").digest(source.readBytes())
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        File(context.getExternalFilesDir(null), "native-large-sampled-source.sha256").writeText("$sha\n")
        source.copyTo(File(context.getExternalFilesDir(null), "native-large-sampled-source.jpg"), overwrite = true)
        try { capture(false, "native-large-sampled-fit.png", true, imagePath = source.path) }
        finally { source.delete() }
    }
    @Test fun captureImagePreviewVeryLarge() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assumeTrue("isolated reference package required", context.packageName == "com.lightningstudio.watchrss.reference")
        val source = File(context.filesDir, "reference-very-large.jpg")
        val width = 4096
        val height = 2048
        val colors = IntArray(width * height)
        for (y in 0 until height) for (x in 0 until width) {
            colors[y * width + x] = 0xff000000.toInt() or
                (((x * 17 + y * 3) and 255) shl 16) or
                (((x * 5 + y * 11) and 255) shl 8) or
                ((x * 7 + y * 13) and 255)
        }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.setPixels(colors, 0, width, 0, 0, width, height)
        FileOutputStream(source).use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
        bitmap.recycle()
        val sha = MessageDigest.getInstance("SHA-256").digest(source.readBytes())
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        File(context.getExternalFilesDir(null), "native-very-large-source.sha256").writeText("$sha\n")
        try { capture(false, "native-very-large-fit.png", true, imagePath = source.path) }
        finally { source.delete() }
    }
    @Test fun captureImagePreviewExtended() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assumeTrue("isolated reference package required", context.packageName == "com.lightningstudio.watchrss.reference")
        val source = File(context.filesDir, "reference-extended-image.jpg")
        val width = 4096
        val height = 3072
        val row = IntArray(width)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        for (y in 0 until height) {
            for (x in 0 until width) row[x] = 0xff000000.toInt() or
                (((x * 17 + y * 3) and 255) shl 16) or
                (((x * 5 + y * 11) and 255) shl 8) or
                ((x * 7 + y * 13) and 255)
            bitmap.setPixels(row, 0, width, 0, y, width, 1)
        }
        FileOutputStream(source).use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
        bitmap.recycle()
        val sha = MessageDigest.getInstance("SHA-256").digest(source.readBytes())
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        File(context.getExternalFilesDir(null), "native-extended-image-source.sha256").writeText("$sha\n")
        try { capture(false, "native-extended-image-fit.png", true, imagePath = source.path) }
        finally { source.delete() }
    }
    @Test fun captureChannelSettings() = capture(false, "reference-channel-settings.png", channelMode = "regular")
    @Test fun captureLocalChannelSettings() = capture(false, "reference-local-channel-settings.png", channelMode = "local")
    @Test fun captureMediaChannelSettings() = capture(false, "reference-media-channel-settings.png", channelMode = "media")
    @Test fun captureDeleteChannelConfirm() = capture(false, "reference-delete-channel-confirm.png", channelMode = "delete")
    @Test fun captureClearChannelConfirm() = capture(false, "reference-clear-channel-confirm.png", channelMode = "clear")
    @Test fun captureReaderShort() = capture(false, "reference-reader-short.png", readerMode = "short")
    @Test fun captureSummaryError() = capture(false, "reference-summary-error.png", readerMode = "summary-error")
    @Test fun captureSummaryDone() = capture(false, "reference-summary-done.png", readerMode = "summary-done")
    @Test fun captureReaderLong() = capture(false, "reference-reader-long.png", readerMode = "long")
    @Test fun captureRssSearch() = capture(false, "reference-rss-search.png", searchScreen = true)
    @Test fun captureAddRssInput() = capture(false, "reference-add-rss-input.png", addRssInput = true)
    @Test fun captureAddRssEmpty() = capture(false, "reference-add-rss-empty.png", addRssInput = true, addRssMode = "empty")
    @Test fun captureAddRssError() = capture(false, "reference-add-rss-error.png", addRssInput = true, addRssMode = "error")
    @Test fun captureAddRssPreview() = capture(false, "reference-add-rss-preview.png", addRssInput = true, addRssMode = "preview")
    @Test fun captureAddRssExisting() = capture(false, "reference-add-rss-existing.png", addRssInput = true, addRssMode = "existing")
    @Test fun captureSavedListItem() = capture(false, "reference-saved-list-item.png", savedListMode = "item")
    @Test fun captureSavedListEmpty() = capture(false, "reference-saved-list-empty.png", savedListMode = "empty")
    private fun capture(autoScroll: Boolean, outputName: String, imagePreview: Boolean = false, channelMode: String? = null, readerMode: String? = null, aiMode: String? = null, imagePath: String? = null, searchScreen: Boolean = false, addRssInput: Boolean = false, addRssMode: String? = null, savedListMode: String? = null) {
        val instrumentation: Instrumentation = InstrumentationRegistry.getInstrumentation()
        val target = instrumentation.targetContext
        assumeTrue("isolated reference package required", target.packageName == "com.lightningstudio.watchrss.reference")
        val activity = instrumentation.startActivitySync(
            Intent(target, ReferenceRssActivity::class.java).putExtra("ai-mode", aiMode).putExtra("auto-scroll", autoScroll).putExtra("image-preview", imagePreview).putExtra("image-preview-path", imagePath).putExtra("channel-mode", channelMode).putExtra("reader-mode", readerMode).putExtra("search-screen", searchScreen).putExtra("add-rss-input", addRssInput).putExtra("add-rss-mode", addRssMode).putExtra("saved-list-mode", savedListMode).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as Activity
        try {
            awaitWindow(activity)
            SystemClock.sleep(if (imagePath != null) 2500 else 600)
            if (readerMode?.startsWith("summary-") == true || aiMode == "usage-confirm") {
                instrumentation.runOnMainSync {
                    val now = SystemClock.uptimeMillis()
                    val down = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, 233f, if (aiMode == "usage-confirm") 347f else 150f, 0)
                    val up = android.view.MotionEvent.obtain(now, now + 50, android.view.MotionEvent.ACTION_UP, 233f, if (aiMode == "usage-confirm") 347f else 150f, 0)
                    activity.dispatchTouchEvent(down); activity.dispatchTouchEvent(up); down.recycle(); up.recycle()
                }
                SystemClock.sleep(800)
            }
            if (aiMode == "usage-confirm") {
                val roots = android.view.inspector.WindowInspector.getGlobalWindowViews()
                val dialog = roots.lastOrNull { it !== activity.window.decorView && it.javaClass.simpleName == "DecorView" }
                assertTrue("native clear confirmation dialog window missing: " + roots.map { it.javaClass.name }, dialog != null)
                val field = dialog!!.javaClass.getDeclaredField("mWindow").apply { isAccessible = true }
                val dialogWindow = field.get(dialog) as android.view.Window
                val dialogBitmap = Bitmap.createBitmap(dialog.width, dialog.height, Bitmap.Config.ARGB_8888)
                val dialogCopied = CountDownLatch(1); val dialogStatus = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
                PixelCopy.request(dialogWindow, dialogBitmap, { result -> dialogStatus.set(result); dialogCopied.countDown() }, Handler(Looper.getMainLooper()))
                assertTrue(dialogCopied.await(20, TimeUnit.SECONDS)); assertEquals(PixelCopy.SUCCESS, dialogStatus.get())
                FileOutputStream(File(target.getExternalFilesDir(null), "reference-ai-dialog-window.png")).use { dialogBitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                val position = IntArray(2); instrumentation.runOnMainSync { dialog.getLocationOnScreen(position) }
                File(target.getExternalFilesDir(null), "reference-ai-dialog-window.json").writeText(org.json.JSONObject().put("width", dialog.width).put("height", dialog.height).put("left", position[0]).put("top", position[1]).put("dimAmount", dialogWindow.attributes.dimAmount).toString())
                dialogBitmap.recycle()
            }
            val bitmap = Bitmap.createBitmap(466, 466, Bitmap.Config.ARGB_8888)
            val status = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
            val copied = CountDownLatch(1)
            PixelCopy.request(activity.window, bitmap, { value -> status.set(value); copied.countDown() }, Handler(Looper.getMainLooper()))
            assertTrue("PixelCopy timed out", copied.await(20, TimeUnit.SECONDS))
            assertEquals(PixelCopy.SUCCESS, status.get())
            val output = File(if (aiMode != null || channelMode != null || readerMode != null || imagePath != null || searchScreen || addRssInput || savedListMode != null) target.getExternalFilesDir(null)!! else target.filesDir, outputName)
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
        assertTrue("reference RSS window did not become ready", activity.window.decorView.width > 0)
    }
}
