package dev.podjs.androidwatch.reference

import android.graphics.Bitmap
import android.media.ExifInterface
import androidx.core.graphics.drawable.toBitmap
import androidx.test.platform.app.InstrumentationRegistry
import coil.ImageLoader
import coil.request.ImageRequest
import coil.request.SuccessResult
import coil.size.Size
import com.lightningstudio.watchrss.ui.util.RssImageLoader
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** Native app's production Coil dependency, exercised in its isolated reference package. */
class ImageExifReferenceTest {
    @Test fun nativeLargeImageTileHashes() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("com.lightningstudio.watchrss.reference", context.packageName)
        val source = File(context.cacheDir, "large-tile-${System.nanoTime()}.jpg")
        val width = 1031
        val height = 513
        val colors = IntArray(width * height)
        for (y in 0 until height) for (x in 0 until width) {
            colors[y * width + x] = 0xff000000.toInt() or
                (((x * 17 + y * 3) and 255) shl 16) or
                (((x * 5 + y * 11) and 255) shl 8) or
                ((x * 7 + y * 13) and 255)
        }
        val fixture = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        fixture.setPixels(colors, 0, width, 0, 0, width, height)
        FileOutputStream(source).use { assertTrue(fixture.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
        fixture.recycle()
        try {
            val preview = runBlocking { RssImageLoader.loadBitmap(context, source.path, Int.MAX_VALUE) }
            assertTrue("native large preview decode failed", preview != null)
            assertEquals(Bitmap.Config.RGB_565, preview!!.config)
            assertEquals(width, preview.width)
            assertEquals(height, preview.height)
            File(context.getExternalFilesDir(null), "native-large-image.rgba").writeBytes(rgbaBytes(preview))
            val tiles = JSONArray()
            for (y in intArrayOf(0, 512)) for (x in intArrayOf(0, 512, 1024)) {
                val tileWidth = minOf(512, width - x)
                val tileHeight = minOf(512, height - y)
                tiles.put(JSONObject().put("x", x).put("y", y).put("width", tileWidth)
                    .put("height", tileHeight)
                    .put("rgbaSha256", sha256(rgbaRegion(preview, x, y, tileWidth, tileHeight))))
            }
            File(context.getExternalFilesDir(null), "native-large-image-tiles.json").writeText(
                JSONObject().put("inputSha256", sha256(source.readBytes()))
                    .put("sourceWidth", width).put("sourceHeight", height).put("tiles", tiles).toString()
            )
        } finally {
            source.delete()
        }
    }

    @Test fun nativeFullscreenPreviewKeepsRawExifOrientation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("com.lightningstudio.watchrss.reference", context.packageName)
        val source = File(context.cacheDir, "exif-preview-raw.jpg")
        val fixture = Bitmap.createBitmap(64, 32, Bitmap.Config.ARGB_8888)
        for (y in 0 until 32) for (x in 0 until 64) {
            fixture.setPixel(x, y, if (x < 32) 0xffff0000.toInt() else 0xff00ff00.toInt())
        }
        FileOutputStream(source).use { assertTrue(fixture.compress(Bitmap.CompressFormat.JPEG, 100, it)) }
        fixture.recycle()
        ExifInterface(source.path).apply {
            setAttribute(ExifInterface.TAG_ORIENTATION, "6")
            saveAttributes()
        }
        try {
            val bitmap = runBlocking { RssImageLoader.loadBitmap(context, source.path, Int.MAX_VALUE) }
            assertTrue("native preview decode failed", bitmap != null)
            assertEquals(64, bitmap!!.width)
            assertEquals(32, bitmap.height)
            assertEquals(Bitmap.Config.RGB_565, bitmap.config)
            val left = bitmap.getPixel(16, 16)
            val right = bitmap.getPixel(48, 16)
            assertTrue("raw left should remain red", ((left ushr 16) and 255) > 180)
            assertTrue("raw right should remain green", ((right ushr 8) and 255) > 180)
        } finally {
            source.delete()
        }
    }

    @Test fun coilDisplaysAllExifOrientations() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("com.lightningstudio.watchrss.reference", context.packageName)
        val source = File(context.cacheDir, "exif-reference.jpg")
        val colors = intArrayOf(0xffff0000.toInt(), 0xff00ff00.toInt(), 0xff0000ff.toInt(), 0xffffff00.toInt())
        val fixture = Bitmap.createBitmap(64, 32, Bitmap.Config.ARGB_8888)
        for (y in 0 until 32) for (x in 0 until 64) {
            fixture.setPixel(x, y, colors[(if (y >= 16) 2 else 0) + (if (x >= 32) 1 else 0)])
        }
        FileOutputStream(source).use { assertTrue(fixture.compress(Bitmap.CompressFormat.JPEG, 100, it)) }
        fixture.recycle()
        val expected = arrayOf(
            intArrayOf(0, 1, 2, 3), intArrayOf(1, 0, 3, 2),
            intArrayOf(3, 2, 1, 0), intArrayOf(2, 3, 0, 1),
            intArrayOf(0, 2, 1, 3), intArrayOf(2, 0, 3, 1),
            intArrayOf(3, 1, 2, 0), intArrayOf(1, 3, 0, 2)
        )
        val loader = ImageLoader.Builder(context).build()
        val hashes = JSONArray()
        try {
            for (orientation in 1..8) {
                ExifInterface(source.path).apply {
                    setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
                    saveAttributes()
                }
                val request = ImageRequest.Builder(context).data(source).size(Size.ORIGINAL)
                    .allowHardware(false).memoryCacheKey("exif-$orientation").build()
                val result = runBlocking { loader.execute(request) } as SuccessResult
                val image = result.drawable.toBitmap()
                val width = if (orientation >= 5) 32 else 64
                val height = if (orientation >= 5) 64 else 32
                val rgba = ByteArray(width * height * 4)
                for (y in 0 until height) for (x in 0 until width) {
                    val pixel = image.getPixel(x, y)
                    val offset = (y * width + x) * 4
                    rgba[offset] = (pixel ushr 16).toByte()
                    rgba[offset + 1] = (pixel ushr 8).toByte()
                    rgba[offset + 2] = pixel.toByte()
                    rgba[offset + 3] = (pixel ushr 24).toByte()
                }
                val previewFile = File(context.cacheDir, "exif-preview-$orientation.jpg")
                source.copyTo(previewFile, overwrite = true)
                val preview = runBlocking { RssImageLoader.loadBitmap(context, previewFile.path, Int.MAX_VALUE) }
                assertTrue("preview orientation=$orientation failed", preview != null)
                assertEquals(Bitmap.Config.RGB_565, preview!!.config)
                assertEquals(64, preview.width)
                assertEquals(32, preview.height)
                hashes.put(JSONObject().put("orientation", orientation)
                    .put("inputSha256", sha256(source.readBytes()))
                    .put("rgbaSha256", sha256(rgba))
                    .put("previewRgbaSha256", sha256(rgbaBytes(preview))))
                previewFile.delete()
                assertEquals("orientation=$orientation width", width, image.width)
                assertEquals("orientation=$orientation height", height, image.height)
                for (corner in 0..3) {
                    val x = if (corner % 2 == 0) width / 4 else 3 * width / 4
                    val y = if (corner < 2) height / 4 else 3 * height / 4
                    val actual = image.getPixel(x, y)
                    val wanted = colors[expected[orientation - 1][corner]]
                    for (shift in intArrayOf(16, 8, 0)) {
                        assertTrue("orientation=$orientation corner=$corner channel=$shift",
                            kotlin.math.abs(((actual ushr shift) and 255) - ((wanted ushr shift) and 255)) <= 35)
                    }
                }
            }
            File(context.getExternalFilesDir(null), "coil-exif-hashes.json").writeText(hashes.toString())
        } finally {
            loader.shutdown()
            source.delete()
        }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

    private fun rgbaBytes(bitmap: Bitmap): ByteArray {
        val bytes = ByteArray(bitmap.width * bitmap.height * 4)
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val pixel = bitmap.getPixel(x, y)
            val offset = (y * bitmap.width + x) * 4
            bytes[offset] = (pixel ushr 16).toByte()
            bytes[offset + 1] = (pixel ushr 8).toByte()
            bytes[offset + 2] = pixel.toByte()
            bytes[offset + 3] = (pixel ushr 24).toByte()
        }
        return bytes
    }

    private fun rgbaRegion(bitmap: Bitmap, x0: Int, y0: Int, width: Int, height: Int): ByteArray {
        val bytes = ByteArray(width * height * 4)
        for (y in 0 until height) for (x in 0 until width) {
            val pixel = bitmap.getPixel(x0 + x, y0 + y)
            val offset = (y * width + x) * 4
            bytes[offset] = (pixel ushr 16).toByte()
            bytes[offset + 1] = (pixel ushr 8).toByte()
            bytes[offset + 2] = pixel.toByte()
            bytes[offset + 3] = (pixel ushr 24).toByte()
        }
        return bytes
    }
}
