package dev.podjs.reference

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.PixelCopy
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontListFontFamily
import com.lightningstudio.watchrss.BuildConfig
import com.lightningstudio.watchrss.InfoActivity
import com.lightningstudio.watchrss.R
import com.lightningstudio.watchrss.WatchRssApplication
import com.lightningstudio.watchrss.data.reader.ReaderPresetCodec
import com.lightningstudio.watchrss.data.reader.ReaderTypographyRole
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs

/**
 * Independent static-document reference using the production InfoActivity, InfoScreen and preset.
 * The default fixture is byte-for-byte the old STATIC body. No user input or preset writes occur.
 * Direct Compose callbacks scroll; Activity.recreate supplies the real Android saved-state Bundle.
 * Scroll-axis values are opaque LazyList semantic coordinates, NEVER cumulative document pixels.
 */
@RunWith(AndroidJUnit4::class)
class InformationDocumentReferenceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val listMatcher = SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)

    @Test fun staticDocumentTopMiddleBottomAndRecreation() = scenario("static", staticBody()) { lifecycle, proof ->
        var activity = launch(staticBody(), lifecycle)
        awaitDocument("STATIC")
        proof.put("top", snapshot(activity, "static-top"))

        // Keep the old semantic anchor, not its opaque scrollAxis number (e.g. 6037).
        scrollToIndex(12)
        scrollBy(37f)
        val middle = snapshot(activity, "static-middle")
        assertTrue("Middle observation requires nonzero scrolling", middle.getDouble("scrollAxis") > 0)
        proof.put("middleAnchor", JSONObject().put("scrollToIndex", 12).put("scrollByPx", 37))
            .put("middle", middle)
        val middleFirst = activity
        activity = recreate(activity, lifecycle)
        awaitDocument("STATIC")
        val middleRestored = snapshot(activity, "static-middle-recreated")
        proof.put("middleRecreated", middleRestored)
            .put("middleRecreation", onMain { lifecycle.recreationProof(middleFirst, activity) })
            .put("middleComparison", comparison(middle, middleRestored))

        // 4 leading items, 32 paragraphs, beian, bottom spacer: last valid item index is 37.
        scrollToIndex(4 + PARAGRAPHS + 1)
        val bottom = snapshot(activity, "static-bottom")
        assertTrue("Bottom must include paragraph 32", textNodes("STATIC 第32段").isNotEmpty())
        assertTrue("Bottom must include the actual beian footer", textNodes(BEIAN_LABEL).isNotEmpty())
        proof.put("bottomAnchor", JSONObject().put("scrollToIndex", 4 + PARAGRAPHS + 1))
            .put("bottom", bottom)
        val bottomFirst = activity
        activity = recreate(activity, lifecycle)
        awaitDocument("STATIC")
        val bottomRestored = snapshot(activity, "static-bottom-recreated")
        proof.put("bottomRecreated", bottomRestored)
            .put("bottomRecreation", onMain { lifecycle.recreationProof(bottomFirst, activity) })
            .put("bottomComparison", comparison(bottom, bottomRestored))
        // Capture both locations and attach their results before any equality assertion can fail.
        assertRestoration("middle", proof.getJSONObject("middleComparison"))
        assertRestoration("bottom", proof.getJSONObject("bottomComparison"))
    }

    /** Supplementary role case has a separate body and receipt; it is not the STATIC baseline. */
    @Test fun supplementaryBodyCodeQuoteLayouts() = scenario("roles", ROLE_BODY, ROLES_TITLE) { lifecycle, proof ->
        val activity = launch(ROLE_BODY, lifecycle, ROLES_TITLE)
        awaitDocument("普通正文角色。")
        proof.put("top", snapshot(activity, "roles-top"))
        val samples = JSONArray()
        listOf("普通正文角色。", "https://example.org/watchrss/reference", "• 引用角色段落。").forEachIndexed { index, marker ->
            scrollToIndex(4 + index)
            assertTrue("Role $marker must be composed", textNodes(marker).isNotEmpty())
            samples.put(snapshot(activity, "roles-$index"))
        }
        proof.put("roleSamples", samples).put("recreationTested", false)
    }

    private fun scenario(name: String, content: String, title: String = TITLE, run: (LifecycleObservations, JSONObject) -> Unit) {
        val lifecycle = LifecycleObservations()
        val application = context.applicationContext as Application
        val proof = JSONObject().put("scenario", name).put("testClass", javaClass.name)
            .put("targetPackage", context.packageName).put("activityClass", InfoActivity::class.java.name)
            .put("title", title).put("content", content)
            .put("contentSha256", sha256(content.toByteArray(Charsets.UTF_8)))
            .put("productionBuildBranch", !BuildConfig.DEBUG).put("clonedComposable", false)
            .put("physicalInputInjected", false).put("focusInputInjected", false)
            .put("presetWrites", false).put("userRecordsSeededByTest", false)
            .put("documentFetch", "none: real static-content Intent branch")
            .put("scrollAxisUnit", "opaque Compose LazyList semantic coordinate; not cumulative pixels")
            .put("geometryUnit", "actual Compose root/window/layout pixels")
            .put("restorationEqualityAsserted", name == "static")
            .put("composeTestClockAutoAdvance", compose.mainClock.autoAdvance)
            .put("pidBefore", android.os.Process.myPid()).put("processDeathTested", false)
            .put("limitations", JSONArray(listOf(
                "Native recreation equality is asserted after all comparison evidence is attached; cross-renderer equality is not tested here.",
                "Real Activity and system Bundle; Compose test clock, not unrestricted production scheduling.",
                "Actual text layout metrics do not identify the final fallback font for every glyph.",
                "Semantics bounds can be clipped; line boxes are local TextLayoutResult coordinates.",
                "Round-screen clipping, physical scrolling and final visual acceptance are not tested."
            ))).put("passed", false)
        try {
            assertEquals("com.lightningstudio.watchrss.onboardingreference", context.packageName)
            assertEquals(context.packageName, BuildConfig.APPLICATION_ID)
            assertFalse(BuildConfig.DEBUG)
            onMain { application.registerActivityLifecycleCallbacks(lifecycle) }
            run(lifecycle, proof)
            proof.put("passed", true)
        } catch (error: Throwable) {
            proof.put("failure", error.javaClass.name + ": " + error.message)
            val current = onMain { lifecycle.resumed }
            if (current != null && !onMain { current.isDestroyed }) {
                try { proof.put("failureCapture", capture(current, "$name-failure", false)) }
                catch (captureError: Throwable) { proof.put("failureCaptureError", captureError.toString()) }
            }
            throw error
        } finally {
            try {
                onMain {
                    lifecycle.activities.reversed().forEach { if (!it.isDestroyed && !it.isFinishing) it.finish() }
                }
                instrumentation.waitForIdleSync()
            } finally {
                onMain { application.unregisterActivityLifecycleCallbacks(lifecycle) }
                proof.put("lifecycle", onMain { JSONArray(lifecycle.events) })
                    .put("pidAfter", android.os.Process.myPid())
                File(context.getExternalFilesDir(null), "native-information-document-$name-proof.json")
                    .writeText(proof.toString(2))
            }
        }
    }

    private fun launch(content: String, lifecycle: LifecycleObservations, title: String = TITLE): InfoActivity {
        val intent = InfoActivity.createIntent(context, title, content).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = instrumentation.startActivitySync(intent) as InfoActivity
        assertSame(activity, awaitResumed(lifecycle))
        return activity
    }

    private fun recreate(first: InfoActivity, lifecycle: LifecycleObservations): InfoActivity {
        onMain { first.recreate() }
        val second = awaitResumed(lifecycle, first)
        assertNotSame(first, second)
        return second
    }

    private fun awaitResumed(lifecycle: LifecycleObservations, differentFrom: Activity? = null): InfoActivity {
        var found: InfoActivity? = null
        waitUntil("Expected real InfoActivity resume") {
            found = onMain { lifecycle.resumed as? InfoActivity }
            found != null && found !== differentFrom
        }
        instrumentation.waitForIdleSync()
        return found!!
    }

    private fun awaitDocument(marker: String) {
        waitUntil("Document $marker must be composed") { listNodes().size == 1 && textNodes(marker).isNotEmpty() }
        compose.waitForIdle()
    }

    private fun waitUntil(message: String, condition: () -> Boolean) {
        val end = SystemClock.uptimeMillis() + 12_000
        var failure: Throwable? = null
        while (SystemClock.uptimeMillis() < end) {
            try { if (condition()) return } catch (error: Throwable) { failure = error }
            SystemClock.sleep(20)
        }
        throw AssertionError(message, failure)
    }

    private fun listNodes() = compose.onAllNodes(listMatcher, useUnmergedTree = true).fetchSemanticsNodes()
    private fun textNodes(marker: String) = compose.onAllNodesWithText(
        marker, substring = true, useUnmergedTree = true
    ).fetchSemanticsNodes()

    private fun scrollToIndex(index: Int) {
        val callback = listNodes().single().config[SemanticsActions.ScrollToIndex].action
        onMain { assertEquals(true, callback?.invoke(index)) }
        compose.waitForIdle()
    }

    private fun scrollBy(px: Float) {
        val callback = listNodes().single().config[SemanticsActions.ScrollBy].action
        onMain { assertEquals(true, callback?.invoke(0f, px)) }
        compose.waitForIdle()
    }

    private fun snapshot(activity: Activity, name: String): JSONObject {
        compose.waitForIdle()
        val list = listNodes().single()
        val texts = compose.onAllNodes(
            SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), useUnmergedTree = true
        ).fetchSemanticsNodes()
        val metrics = onMain { texts.map { textMetrics(it, list.boundsInRoot) }.sortedBy { it.getString("text") } }
        val geometry = JSONArray(metrics.filter { it.getBoolean("isActuallyVisible") }.map {
            JSONObject().put("text", it.getString("text")).put("role", it.getString("role"))
                .put("boundsInRoot", it.getJSONObject("boundsInRoot"))
                .put("boundsInWindow", it.getJSONObject("boundsInWindow"))
                .put("layouts", JSONArray((0 until it.getJSONArray("layouts").length()).map { index ->
                    val layout = it.getJSONArray("layouts").getJSONObject(index)
                    JSONObject().put("width", layout.getInt("width")).put("height", layout.getInt("height"))
                        .put("lines", layout.getJSONArray("lines"))
                }))
        })
        val observation = onMain {
            val axis = list.config[SemanticsProperties.VerticalScrollAxisRange]
            JSONObject().put("activityIdentity", System.identityHashCode(activity))
                .put("scrollAxis", axis.value().toDouble()).put("scrollAxisMax", axis.maxValue().toString())
                .put("reverseScrolling", axis.reverseScrolling)
                .put("listBoundsInRoot", rect(list.boundsInRoot))
                .put("listBoundsInWindow", rect(list.boundsInWindow))
                .put("texts", JSONArray(metrics)).put("semanticGeometry", geometry)
                .put("semanticGeometryFilter", "Require node.layoutInfo and every parentInfo ancestor to be placed, attached and not deactivated, plus positive-area boundsInRoot intersecting the current LazyColumn viewport. All raw text nodes and placement chains remain in texts; placement identities are not part of geometry equality.")
                .put("semanticGeometrySha256", sha256(geometry.toString().toByteArray(Charsets.UTF_8)))
        }
        return observation.put("conditions", conditions(activity)).put("capture", capture(activity, name))
    }

    /** Reads the repository currently used by InfoActivity, without changing selection or assets. */
    private fun conditions(activity: Activity): JSONObject {
        val repository = (activity.application as WatchRssApplication).container.readerPresetRepository
        val preset = repository.activePreset.value
        val selection = repository.selection.value
        val roles = linkedMapOf("BODY" to preset.body)
        ReaderTypographyRole.values().forEach { roles[it.name] = preset.resolvedStyle(it) }
        val fontFiles = JSONArray(repository.fonts.value.map { asset ->
            val file = repository.fontFile(asset.id)
            JSONObject().put("id", asset.id).put("displayName", asset.displayName)
                .put("familyName", asset.familyName).put("fileName", asset.fileName)
                .put("recordSha256", asset.sha256).put("recordByteCount", asset.byteCount)
                .put("faceCount", asset.faceCount).put("metadataJson", asset.metadataJson)
                .put("fileExists", file?.isFile == true).put("actualByteCount", file?.length() ?: 0L)
                .put("actualSha256", if (file?.isFile == true) sha256(file.readBytes()) else JSONObject.NULL)
        })
        val packagedFont = activity.resources.openRawResource(R.font.watch_sans).use { it.readBytes() }
        val resources = activity.resources
        return JSONObject().put("readMethod", "InfoActivity application AppContainer.readerPresetRepository live StateFlow values")
            .put("observedAtMillis", SystemClock.uptimeMillis())
            .put("preset", JSONObject(ReaderPresetCodec.encode(preset)))
            .put("selection", JSONObject().put("mode", selection.mode.name)
                .put("lightPresetId", selection.lightPresetId ?: JSONObject.NULL)
                .put("darkPresetId", selection.darkPresetId ?: JSONObject.NULL)
                .put("darkFollowsLight", selection.darkFollowsLight))
            .put("availablePresetIds", JSONArray(repository.presets.value.map { it.id }))
            .put("presetRecordCount", repository.presetRecords.value.size)
            .put("fontAssets", fontFiles)
            .put("roleResolvedSpecs", JSONObject().apply { roles.forEach { (role, style) ->
                put(role, JSONObject(ReaderPresetCodec.encode(preset.copy(body = style))).getJSONObject("body"))
            } })
            .put("packagedWatchSans", JSONObject().put("resourceName", resources.getResourceName(R.font.watch_sans))
                .put("byteCount", packagedFont.size).put("sha256", sha256(packagedFont)))
            .put("resourceDensity", resources.displayMetrics.density.toDouble())
            .put("resourceScaledDensity", resources.displayMetrics.scaledDensity.toDouble())
            .put("configurationFontScale", resources.configuration.fontScale.toDouble())
            .put("screenRound", resources.configuration.isScreenRound)
            .put("uiMode", resources.configuration.uiMode)
            .put("activityThemeSourceContract", "InfoActivity calls WatchRSSTheme() (dark default); ReaderBackgroundSurface and reader text use the live preset above")
            .put("contentDensitySourceContract", "InfoActivity overrides density to 2f and retains base fontScale; actual per-node density and fontScale are in texts.layouts")
            .put("layoutMeasurement", "production TextLayoutResult, list and text bounds; no default-derived pixel dimensions")
            .put("stateFlowReadScope", "current values observed at each snapshot; no database seeding or preset stabilization writes")
    }

    private fun textMetrics(node: SemanticsNode, viewport: Rect): JSONObject {
        val text = node.config[SemanticsProperties.Text].joinToString("\n") { it.text }
        val bounds = node.boundsInRoot
        val positiveBoundsArea = bounds.right > bounds.left && bounds.bottom > bounds.top
        val intersectsViewport = positiveBoundsArea &&
            bounds.right > viewport.left && bounds.left < viewport.right &&
            bounds.bottom > viewport.top && bounds.top < viewport.bottom
        // Bounds can survive LazyColumn item reuse even when the item is no longer placed.
        // Compose 1.7.1 checkIsDisplayed also checks isPlaced along the entire parentInfo chain.
        // Record each signal before invoking the text-layout action, all on the main thread.
        val placementChain = generateSequence(node.layoutInfo) { it.parentInfo }.mapIndexed { depth, info ->
            JSONObject().put("depth", depth).put("semanticsId", info.semanticsId)
                .put("isPlaced", info.isPlaced).put("isAttached", info.isAttached)
                .put("isDeactivated", info.isDeactivated).put("width", info.width).put("height", info.height)
        }.toList()
        val allPlaced = placementChain.all { it.getBoolean("isPlaced") }
        val allAttached = placementChain.all { it.getBoolean("isAttached") }
        val anyDeactivated = placementChain.any { it.getBoolean("isDeactivated") }
        val visible = allPlaced && allAttached && !anyDeactivated && intersectsViewport
        val exclusions = JSONArray()
        placementChain.forEach { entry ->
            listOf("isPlaced" to false, "isAttached" to false, "isDeactivated" to true).forEach { (signal, rejectedValue) ->
                if (entry.getBoolean(signal) == rejectedValue) {
                    exclusions.put(JSONObject().put("source", "layoutInfo ancestor chain")
                        .put("depth", entry.getInt("depth")).put("semanticsId", entry.getInt("semanticsId"))
                        .put("signal", signal).put("value", rejectedValue))
                }
            }
        }
        if (!positiveBoundsArea) exclusions.put(JSONObject().put("source", "boundsInRoot").put("reason", "non-positive area"))
        if (positiveBoundsArea && !intersectsViewport) exclusions.put(JSONObject().put("source", "boundsInRoot").put("reason", "outside LazyColumn viewport"))
        val results = mutableListOf<TextLayoutResult>()
        val hasLayout = node.config.contains(SemanticsActions.GetTextLayoutResult)
        val layoutActionSucceeded = hasLayout && node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(results) == true
        if (visible) {
            assertTrue("Visible production text must expose layout metrics: $text", hasLayout)
            assertTrue("Visible production text layout action must succeed: $text", layoutActionSucceeded)
            assertTrue("Visible production text must return at least one layout: $text", results.isNotEmpty())
        }
        return JSONObject().put("text", text).put("role", role(text))
            .put("boundsInRoot", rect(bounds)).put("boundsInWindow", rect(node.boundsInWindow))
            .put("positiveBoundsArea", positiveBoundsArea).put("intersectsViewport", intersectsViewport)
            .put("placementChain", JSONArray(placementChain)).put("allLayoutAncestorsPlaced", allPlaced)
            .put("allLayoutAncestorsAttached", allAttached).put("anyLayoutAncestorDeactivated", anyDeactivated)
            .put("isActuallyVisible", visible).put("visibilityExclusionReasons", exclusions)
            .put("hasTextLayoutAction", hasLayout)
            .put("textLayoutActionSucceeded", layoutActionSucceeded).put("layouts", JSONArray(results.map { layout ->
                val style = layout.layoutInput.style
                JSONObject().put("text", layout.layoutInput.text.text)
                    .put("method", "production SemanticsActions.GetTextLayoutResult")
                    .put("width", layout.size.width).put("height", layout.size.height)
                    .put("density", layout.layoutInput.density.density.toDouble())
                    .put("fontScale", layout.layoutInput.density.fontScale.toDouble())
                    .put("fontSize", style.fontSize.toString()).put("lineHeight", style.lineHeight.toString())
                    .put("fontSizePxViaLayoutDensity", with(layout.layoutInput.density) { style.fontSize.toPx() }.toDouble())
                    .put("letterSpacing", style.letterSpacing.toString())
                    .put("fontWeight", style.fontWeight?.weight ?: JSONObject.NULL)
                    .put("fontStyle", style.fontStyle?.toString() ?: JSONObject.NULL)
                    .put("fontSynthesis", style.fontSynthesis?.toString() ?: JSONObject.NULL)
                    .put("fontFamily", style.fontFamily?.toString() ?: JSONObject.NULL)
                    .put("fontFamilyEntries", JSONArray((style.fontFamily as? FontListFontFamily)?.fonts?.map { font ->
                        JSONObject().put("weight", font.weight.weight).put("style", font.style.toString())
                            .put("descriptor", font.toString())
                    } ?: emptyList<JSONObject>()))
                    .put("colorArgb", style.color.toArgb().toLong() and 0xffffffffL)
                    .put("textAlign", style.textAlign.toString()).put("platformStyle", style.platformStyle.toString())
                    .put("resolvedTypefacePerGlyphMeasured", false)
                    .put("lines", JSONArray((0 until layout.lineCount).map { line ->
                        JSONObject().put("index", line).put("start", layout.getLineStart(line))
                            .put("end", layout.getLineEnd(line)).put("left", layout.getLineLeft(line).toDouble())
                            .put("right", layout.getLineRight(line).toDouble()).put("top", layout.getLineTop(line).toDouble())
                            .put("bottom", layout.getLineBottom(line).toDouble())
                            .put("baseline", layout.getLineBaseline(line).toDouble())
                    }))
            }))
    }

    private fun comparison(before: JSONObject, after: JSONObject): JSONObject {
        val delta = after.getDouble("scrollAxis") - before.getDouble("scrollAxis")
        return JSONObject().put("semanticScrollCoordinateDelta", delta)
            .put("semanticScrollCoordinateUnchanged", abs(delta) < 0.0001)
            .put("semanticGeometryEqual", before.getString("semanticGeometrySha256") == after.getString("semanticGeometrySha256"))
            .put("pixelsEqual", before.getJSONObject("capture").getString("pixelSha256") == after.getJSONObject("capture").getString("pixelSha256"))
            .put("presetEqual", before.getJSONObject("conditions").getJSONObject("preset").toString() == after.getJSONObject("conditions").getJSONObject("preset").toString())
            .put("configurationFontScaleEqual", before.getJSONObject("conditions").getDouble("configurationFontScale") == after.getJSONObject("conditions").getDouble("configurationFontScale"))
    }

    private fun assertRestoration(location: String, result: JSONObject) {
        assertTrue("$location recreation must preserve its semantic scroll coordinate", result.getBoolean("semanticScrollCoordinateUnchanged"))
        assertTrue("$location recreation must preserve actual text geometry", result.getBoolean("semanticGeometryEqual"))
        assertTrue("$location recreation must preserve window pixels", result.getBoolean("pixelsEqual"))
        assertTrue("$location recreation must retain the preset", result.getBoolean("presetEqual"))
        assertTrue("$location recreation must retain fontScale", result.getBoolean("configurationFontScaleEqual"))
    }

    private fun capture(activity: Activity, name: String, synchronizeCompose: Boolean = true): JSONObject {
        if (synchronizeCompose) compose.waitForIdle()
        instrumentation.waitForIdleSync()
        val bitmap = onMain {
            val decor = activity.window.decorView
            assertTrue(decor.isAttachedToWindow && decor.width > 0 && decor.height > 0)
            Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        }
        try {
            val result = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
            val latch = CountDownLatch(1)
            onMain { PixelCopy.request(activity.window, bitmap, { result.set(it); latch.countDown() }, Handler(Looper.getMainLooper())) }
            assertTrue("PixelCopy timed out", latch.await(5, TimeUnit.SECONDS))
            assertEquals(PixelCopy.SUCCESS, result.get())
            val file = File(context.getExternalFilesDir(null), "native-information-document-$name.png")
            FileOutputStream(file).use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            val pixels = ByteBuffer.allocate(bitmap.byteCount)
            bitmap.copyPixelsToBuffer(pixels)
            return JSONObject().put("file", file.name).put("method", "window PixelCopy")
                .put("capturedAtMillis", SystemClock.uptimeMillis()).put("width", bitmap.width).put("height", bitmap.height)
                .put("pixelSha256", sha256(pixels.array())).put("pngSha256", sha256(file.readBytes()))
                .put("topLeftPixelArgb", bitmap.getPixel(0, 0).toLong() and 0xffffffffL)
        } finally { bitmap.recycle() }
    }

    private fun <T> onMain(block: () -> T): T {
        val value = AtomicReference<T>()
        val failure = AtomicReference<Throwable>()
        instrumentation.runOnMainSync { try { value.set(block()) } catch (error: Throwable) { failure.set(error) } }
        failure.get()?.let { throw it }
        return value.get()
    }

    private class LifecycleObservations : Application.ActivityLifecycleCallbacks {
        val activities = mutableListOf<Activity>()
        val events = mutableListOf<JSONObject>()
        private val saved = mutableSetOf<Activity>()
        private val restored = mutableSetOf<Activity>()
        private val destroyed = mutableSetOf<Activity>()
        var resumed: Activity? = null
        private fun record(activity: Activity, event: String, state: Bundle? = null) {
            if (activity !is InfoActivity) return
            events.add(JSONObject().put("event", event).put("activity", activity.javaClass.name)
                .put("identity", System.identityHashCode(activity)).put("atMillis", SystemClock.uptimeMillis())
                .put("bundlePresent", state != null).put("bundleKeys", JSONArray(state?.keySet()?.sorted() ?: emptyList<String>())))
        }
        fun recreationProof(first: Activity, second: Activity): JSONObject {
            assertTrue("Old Activity saved state", first in saved)
            assertTrue("New Activity received system Bundle", second in restored)
            assertTrue("Old Activity destroyed", first in destroyed)
            assertNotSame(first, second)
            return JSONObject().put("firstIdentity", System.identityHashCode(first)).put("secondIdentity", System.identityHashCode(second))
                .put("instanceChanged", true).put("savedBundleObserved", true).put("restoredBundleObserved", true)
                .put("oldDestroyed", true).put("mechanism", "real Activity.recreate; system-owned Bundle")
        }
        override fun onActivityCreated(activity: Activity, state: Bundle?) {
            if (activity is InfoActivity) { activities.add(activity); if (state != null) restored.add(activity) }
            record(activity, "created", state)
        }
        override fun onActivityResumed(activity: Activity) { resumed = activity; record(activity, "resumed") }
        override fun onActivityPaused(activity: Activity) { if (resumed === activity) resumed = null; record(activity, "paused") }
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) { saved.add(activity); record(activity, "saved", state) }
        override fun onActivityDestroyed(activity: Activity) { destroyed.add(activity); if (resumed === activity) resumed = null; record(activity, "destroyed") }
        override fun onActivityStarted(activity: Activity) { record(activity, "started") }
        override fun onActivityStopped(activity: Activity) { record(activity, "stopped") }
    }

    private companion object {
        const val TITLE = "原生协议恢复对照"
        const val BEIAN_LABEL = "浙ICP备2024111886号-5A"
        const val PARAGRAPHS = 32
        const val ROLES_TITLE = "协议阅读角色对照"
        const val ROLE_BODY = "普通正文角色。\n\nhttps://example.org/watchrss/reference\n\n• 引用角色段落。"
        fun staticBody() = (1..PARAGRAPHS).joinToString("\n\n") {
            "STATIC 第${it.toString().padStart(2, '0')}段。此内容仅用于隔离协议页面的生命周期与滚动验证。"
        }
        fun role(text: String) = when {
            text.replace("\n", "") in listOf(TITLE, ROLES_TITLE) -> "TITLE"
            text == BEIAN_LABEL -> "FOOTER"
            text.startsWith("https://") || text.startsWith("http://") -> "CODE"
            text.startsWith("•") -> "QUOTE"
            else -> "BODY"
        }
        fun rect(value: Rect) = JSONObject().put("left", value.left.toDouble()).put("top", value.top.toDouble())
            .put("right", value.right.toDouble()).put("bottom", value.bottom.toDouble())
        fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
