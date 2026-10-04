package dev.podjs.reference

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.content.res.Resources
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import android.view.PixelCopy
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.lightningstudio.watchrss.BeianActivity
import com.lightningstudio.watchrss.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.security.MessageDigest
import java.util.IdentityHashMap
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Observes the unmodified production Activity. No seek, state writes, input or image resampling. */
@RunWith(AndroidJUnit4::class)
class BeianAnimationReferenceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val runId = UUID.randomUUID().toString()
    private val runNonce = InstrumentationRegistry.getArguments().getString("beianAnimationRunNonce").orEmpty()
    private val samples = JSONArray()
    private val ticks = JSONArray()
    private var originClockMs: Long? = null
    private var originStartNs: Long? = null
    private var transitionIdentity: Int? = null

    @Test fun captureProductionBeianEntryAtObservedComposePhases() {
        val proof = JSONObject()
            .put("schemaVersion", 1).put("state", "running").put("runId", runId).put("runNonce", runNonce)
            .put("test", "dev.podjs.reference.BeianAnimationReferenceTest#captureProductionBeianEntryAtObservedComposePhases")
            .put("packageName", context.packageName).put("pid", Process.myPid())
            .put("productionActivityClass", BeianActivity::class.java.name)
            .put("productionBuildBranch", true).put("clonedComposable", false)
            .put("physicalInputInjected", false).put("focusInputInjected", false)
            .put("productionStateOrTransitionWritten", false).put("transitionSeekCalled", false)
            .put("imageTransformations", "none: full Window PixelCopy, original dimensions")
            .put("samples", samples).put("startupAndPhaseTicks", ticks)
            .put("requestedPlayTimesMs", JSONArray(listOf(0, 250, 500, 980, 1500, 1650)))
            .put("phaseOriginContract", "Observed production Transition first running frame: current=false, target=true, start!=Long.MIN_VALUE, playTime=0. The preceding withFrameNanos only changes entered and is not the origin.")
            .put("terminalTimeContract", "Compose resets startTime to Long.MIN_VALUE and playTime to zero at completion; the separately retained origin and elapsed test clock remain in every terminal sample.")
            .put("limitations", JSONArray(listOf(
                "Internal observation is pinned to Compose 1.7.1 and the unminified isolated reference APK; absent APIs produce an unsupported proof and a failing test.",
                "OwnedLayer getters observe applied Compose/backend properties, not independent GPU execution of each effect.",
                "SDK below 31 cannot establish native RenderEffect blur even when a Compose BlurEffect object is present.",
                "Frame commit and PixelCopy establish submitted window pixels, not physical panel visibility or final user acceptance.",
                "No physical interaction, process death, phone-camera scan or Pod cross-renderer equality is asserted here."
            )))
        val app = context.applicationContext as Application
        val lifecycle = OwnedLifecycle(runId)
        var registered = false
        var baseline: JSONObject? = null
        var failure: Throwable? = null
        val previousAutoAdvance = compose.mainClock.autoAdvance
        try {
            assertTrue("Pass a unique non-empty beianAnimationRunNonce argument", runNonce.isNotBlank())
            assertEquals("com.lightningstudio.watchrss.onboardingreference", context.packageName)
            assertEquals(context.packageName, BuildConfig.APPLICATION_ID)
            assertFalse(BuildConfig.DEBUG)
            requireSupported(Build.VERSION.SDK_INT >= 29, "Frame commit evidence requires API 29+")
            baseline = onMain { globalConditions() }
            proof.put("globalBefore", baseline)
            compose.mainClock.autoAdvance = false
            proof.put("autoAdvanceDisabledBeforeLaunch", !compose.mainClock.autoAdvance)
            onMain { app.registerActivityLifecycleCallbacks(lifecycle) }
            registered = true
            val activity = instrumentation.startActivitySync(
                BeianActivity.createIntent(context)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(RUN_EXTRA, runId)
            ) as BeianActivity
            assertTrue("Owned Activity did not resume", lifecycle.resumed.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            onMain {
                assertTrue(lifecycle.owned.any { it === activity })
                assertEquals(BeianActivity::class.java, activity.javaClass)
                requireSupported(activity.window.decorView.isHardwareAccelerated, "Frame commit callback needs hardware rendering")
            }
            compose.waitForIdle()
            proof.put("activityIdentity", System.identityHashCode(activity))
            proof.put("activityResources", onMain { resourceConditions(activity.resources) })
            proof.put("textMetrics", textMetrics())

            // With autoAdvance disabled before launch, no test frame has been supplied yet.
            // If a different clock has already advanced this animation, do not invent an initial phase.
            val initial = observe()
            assertInitial(initial)
            capturePhase(activity, "initial", null, proof)

            var zero: JSONObject? = null
            for (attempt in 0 until MAX_ORIGIN_FRAMES) {
                compose.mainClock.advanceTimeByFrame()
                compose.waitForIdle()
                val observed = observe()
                ticks.put(JSONObject().put("purpose", "find-real-transition-origin").put("observation", observed))
                val tr = observed.getJSONObject("transition")
                if (tr.getBoolean("isRunning")) {
                    assertEquals("The first observed running frame must be the true zero frame", 0L, tr.getLong("playTimeNanos"))
                    assertEquals(false, tr.get("currentState"))
                    assertEquals(true, tr.get("targetState"))
                    assertNotEquals(Long.MIN_VALUE, tr.getLong("startTimeNanos"))
                    zero = observed
                    break
                }
                assertFalse("Transition completed without an observable running zero frame", tr.get("currentState") == true)
            }
            requireSupported(zero != null, "Production transition did not expose a running zero frame within $MAX_ORIGIN_FRAMES test frames")
            val observedZero = zero ?: throw UnsupportedObservation("Missing observed transition origin")
            originClockMs = observedZero.getLong("mainClockTimeMs")
            originStartNs = observedZero.getJSONObject("transition").getLong("startTimeNanos")
            proof.put("originMainClockTimeMs", originClockMs).put("originStartTimeNanos", originStartNs)
                .put("observedOrigin", observedZero)
            capturePhase(activity, "origin-0000ms", 0, proof)

            for (requested in listOf(250L, 500L, 980L, 1500L, 1650L)) {
                var reached = false
                for (frame in 0 until MAX_PHASE_FRAMES) {
                    val observed = observe()
                    val tr = observed.getJSONObject("transition")
                    if (tr.getBoolean("isRunning")) {
                        assertEquals("Transition must retain its observed origin", originStartNs!!, tr.getLong("startTimeNanos"))
                        if (tr.getLong("playTimeNanos") >= requested * 1_000_000L) {
                            reached = true
                            break
                        }
                    } else if (tr.get("currentState") == true && tr.get("targetState") == true) {
                        assertTrue("An intermediate phase was missed", requested * 1_000_000L >= tr.getLong("totalDurationNanos"))
                        reached = true
                        break
                    } else {
                        throw AssertionError("Production transition stopped before reaching requested phase $requested")
                    }
                    compose.mainClock.advanceTimeByFrame()
                    compose.waitForIdle()
                    ticks.put(JSONObject().put("purpose", "advance-to-observed-playtime")
                        .put("requestedPlayTimeMs", requested).put("observation", observe()))
                }
                assertTrue("Requested phase $requested was not reached within a bounded frame budget", reached)
                capturePhase(activity, "request-${requested.toString().padStart(4, '0')}ms", requested, proof)
            }
            val last = observe().getJSONObject("transition")
            assertFalse("Last sample must be terminal", last.getBoolean("isRunning"))
            assertEquals(true, last.get("currentState"))
            assertEquals(true, last.get("targetState"))
            assertEquals(Long.MIN_VALUE, last.getLong("startTimeNanos"))
            assertEquals(0L, last.getLong("playTimeNanos"))
            assertValues(last, mapOf(ALPHA to 1f, SCALE to 1f, BLUR to 0f, OVERLAY to 0f, BIAS to 0f))
            proof.put("state", "passed").put("allPairedFrozenCapturesExactlyEqual", true)
        } catch (error: Throwable) {
            failure = error
            proof.put("state", if (error is UnsupportedObservation) "unsupported" else "failed")
                .put("errorClass", error.javaClass.name).put("error", error.message ?: "")
                .put("errorStack", error.stackTraceToString())
        } finally {
            val cleanupErrors = JSONArray()
            fun cleanup(action: () -> Unit) {
                try { action() } catch (error: Throwable) {
                    cleanupErrors.put(error.stackTraceToString())
                    if (failure == null) failure = error else failure!!.addSuppressed(error)
                }
            }
            cleanup {
                val destroyed = onMain {
                    lifecycle.beginCleanup().also {
                        lifecycle.owned.forEach { owned -> if (!owned.isFinishing && !owned.isDestroyed) owned.finish() }
                    }
                }
                assertTrue("Owned Activity destruction was not observed", destroyed.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            }
            cleanup { instrumentation.waitForIdleSync() }
            cleanup { if (registered) onMain { app.unregisterActivityLifecycleCallbacks(lifecycle) } }
            cleanup { compose.mainClock.autoAdvance = previousAutoAdvance }
            cleanup {
                val after = onMain { globalConditions() }
                proof.put("globalAfter", after)
                val unchanged = baseline?.toString() == after.toString()
                proof.put("globalConditionsUnchanged", unchanged)
                if (baseline != null) assertTrue("Test must not alter global resources or animation/font settings", unchanged)
            }
            cleanup {
                proof.put("lifecycle", lifecycle.events).put("cleanupErrors", cleanupErrors)
                    .put("mainClockAutoAdvanceRestored", compose.mainClock.autoAdvance == previousAutoAdvance)
                    .put("ownedActivitiesAfterCleanup", onMain { JSONArray(lifecycle.owned.map {
                        JSONObject().put("identity", System.identityHashCode(it)).put("isFinishing", it.isFinishing)
                            .put("isDestroyed", it.isDestroyed).put("destroyCallbackObserved", lifecycle.destroyed.contains(it))
                    }) })
            }
            if (failure != null && proof.optString("state") == "passed") proof.put("state", "failed-during-cleanup")
            try {
                writeProofAtomically(proof)
            } catch (error: Throwable) {
                if (failure == null) failure = error else failure!!.addSuppressed(error)
            }
        }
        failure?.let { throw AssertionError("Native animation evidence is ${proof.optString("state")}; see native-beian-animation-proof.json", it) }
    }

    private fun capturePhase(activity: BeianActivity, label: String, requested: Long?, proof: JSONObject) {
        compose.waitForIdle()
        val before = observe()
        val sample = JSONObject().put("label", label).put("requestedPlayTimeMs", requested ?: JSONObject.NULL)
            .put("mainClockTimeMs", before.getLong("mainClockTimeMs"))
            .put("originMainClockTimeMs", originClockMs ?: JSONObject.NULL)
            .put("originStartTimeNanos", originStartNs ?: JSONObject.NULL)
            .put("elapsedClockSinceOriginMs", originClockMs?.let { before.getLong("mainClockTimeMs") - it } ?: JSONObject.NULL)
            .put("transition", before.getJSONObject("transition"))
            .put("observationBeforeCapture", before)
        samples.put(sample)
        val captures = JSONArray()
        sample.put("captures", captures)
        var first: Bitmap? = null
        var second: Bitmap? = null
        try {
            val one = captureCommittedFrame(activity, label, 1, phaseSignature(before), captures)
            first = one
            val two = captureCommittedFrame(activity, label, 2, phaseSignature(before), captures)
            second = two
            val equal = one.sameAs(two)
            sample.put("pairedPixelsExactlyEqual", equal)
            assertTrue("Frozen phase $label produced different submitted frames; both raw captures retained", equal)
            val after = observe()
            assertEquals("No test-clock/transition change is allowed during PixelCopy", phaseSignature(before), phaseSignature(after))
            sample.put("observationAfterCapture", after)
            proof.put("lastCompletedSample", label)
        } finally {
            first?.recycle()
            second?.recycle()
        }
    }

    private fun captureCommittedFrame(activity: BeianActivity, label: String, index: Int, expectedPhase: String, captures: JSONArray): Bitmap {
        val committed = CountDownLatch(1)
        val commitUptimeNs = AtomicReference<Long>()
        val callback = Runnable { commitUptimeNs.set(SystemClock.elapsedRealtimeNanos()); committed.countDown() }
        val requestUptimeNs = SystemClock.elapsedRealtimeNanos()
        onMain {
            val decor = activity.window.decorView
            assertTrue(decor.isAttachedToWindow && decor.width > 0 && decor.height > 0)
            requireSupported(decor.isHardwareAccelerated, "Hardware rendering was lost")
            decor.viewTreeObserver.registerFrameCommitCallback(callback)
            decor.invalidate()
        }
        try {
            assertTrue("No verified frame commit for $label/$index", committed.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
        } finally {
            onMain { if (activity.window.decorView.viewTreeObserver.isAlive) activity.window.decorView.viewTreeObserver.unregisterFrameCommitCallback(callback) }
        }
        val submitted = observe()
        assertEquals("Commit must preserve the frozen phase", expectedPhase, phaseSignature(submitted))
        assertAppliedLayer(submitted)
        val bitmap = onMain { Bitmap.createBitmap(activity.window.decorView.width, activity.window.decorView.height, Bitmap.Config.ARGB_8888) }
        val complete = CountDownLatch(1)
        val result = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
        val copyLock = Any()
        var copySubmitted = false
        var copyFinished = false
        var recycleOnCallback = false
        val filename = "native-beian-animation-${runId.take(8)}-$label-$index.png"
        val record = JSONObject().put("file", filename).put("method", "Window PixelCopy after hardware frame-commit callback")
            .put("frameCommitRequestedAtElapsedRealtimeNanos", requestUptimeNs)
            .put("frameCommittedAtElapsedRealtimeNanos", commitUptimeNs.get())
            .put("submittedObservation", submitted).put("width", bitmap.width).put("height", bitmap.height)
        captures.put(record)
        try {
            onMain {
                PixelCopy.request(activity.window, bitmap, { code ->
                    synchronized(copyLock) {
                        result.set(code)
                        copyFinished = true
                        if (recycleOnCallback) bitmap.recycle()
                    }
                    complete.countDown()
                }, Handler(Looper.getMainLooper()))
                synchronized(copyLock) { copySubmitted = true }
            }
            assertTrue("PixelCopy callback timeout", complete.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            record.put("pixelCopyResult", result.get()).put("pixelCopyCompletedAtElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos())
            assertEquals(PixelCopy.SUCCESS, result.get())
            val file = File(context.getExternalFilesDir(null), filename)
            file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            record.put("pngSha256", sha256(file.readBytes())).put("pixelSha256ArgbBigEndian", pixelHash(bitmap))
            assertEquals("PixelCopy must preserve the frozen phase", expectedPhase, phaseSignature(observe()))
            return bitmap
        } catch (error: Throwable) {
            // A timed-out PixelCopy may still own this destination. Its callback
            // performs deferred disposal instead of writing into a recycled bitmap.
            synchronized(copyLock) {
                if (!copySubmitted || copyFinished) bitmap.recycle() else recycleOnCallback = true
            }
            throw error
        }
    }

    /** Synchronization is outside the main-thread read. No observer invokes a layer lambda or setter. */
    private fun observe(): JSONObject {
        val node = compose.onNodeWithContentDescription(QR_DESCRIPTION, useUnmergedTree = true).fetchSemanticsNode()
        return onMain {
            val info = node.layoutInfo
            assertTrue(info.isAttached && info.isPlaced && !info.isDeactivated)
            val candidates = mutableListOf<Pair<Any, Any>>()
            val modifiers = JSONArray()
            val layers = JSONArray()
            val seenLayers = IdentityHashMap<Any, Boolean>()
            for ((index, entry) in info.getModifierInfo().withIndex()) {
                modifiers.put(JSONObject().put("index", index).put("class", entry.modifier.javaClass.name)
                    .put("ownedLayerClass", entry.extra?.javaClass?.name ?: JSONObject.NULL))
                entry.extra?.let { layer -> if (seenLayers.put(layer, true) == null) layers.put(layerSnapshot(layer)) }
                if (entry.modifier.javaClass.simpleName != "BlockGraphicsLayerElement") continue
                val block = call(entry.modifier, "getBlock") ?: throw UnsupportedObservation("GraphicsLayer block is null")
                val parents = IdentityHashMap<Any, Boolean>()
                val labels = mutableSetOf<String>()
                for (field in instanceFields(block.javaClass)) {
                    field.isAccessible = true
                    val value = field.get(block) ?: continue
                    if (value.javaClass.name != ANIMATION_STATE_CLASS) continue
                    val label = call(value, "getLabel") as? String ?: continue
                    if (label != ALPHA && label != SCALE) continue
                    labels.add(label)
                    val parentField = instanceFields(value.javaClass).singleOrNull { it.type.name == TRANSITION_CLASS }
                        ?: throw UnsupportedObservation("Cannot identify TransitionAnimationState parent")
                    parentField.isAccessible = true
                    val parent = parentField.get(value) ?: throw UnsupportedObservation("Transition parent is null")
                    if (call(parent, "getLabel") == TRANSITION_LABEL) parents[parent] = true
                }
                if (labels == setOf(ALPHA, SCALE) && parents.size == 1) {
                    // graphicsLayer.measure places its child with this block.
                    // entry.extra belongs to the current node's outer placement,
                    // so it cannot establish ownership of this block's layer.
                    val child = callPrefix(entry.coordinates, "getWrapped\$")
                        ?: throw UnsupportedObservation("Entry graphics layer has no wrapped child coordinator")
                    requireSupported(call(child, "getLayerBlock") === block, "Wrapped child's layer block is not the observed production entry block")
                    val layer = call(child, "getLayer")
                        ?: throw UnsupportedObservation("Production entry block's wrapped child has no actual OwnedLayer")
                    candidates.add(parents.keys.single() to layer)
                }
            }
            requireSupported(candidates.size == 1, "Expected exactly one production QR alpha/scale block; found ${candidates.size}; modifiers=$modifiers")
            val (transition, outerLayer) = candidates.single()
            val id = System.identityHashCode(transition)
            transitionIdentity?.let { assertEquals("Production Transition identity changed", it, id) }
            transitionIdentity = id
            val tr = transitionSnapshot(transition)
            JSONObject().put("mainClockTimeMs", compose.mainClock.currentTime)
                .put("autoAdvance", compose.mainClock.autoAdvance)
                .put("observedAtElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos())
                .put("transition", tr).put("outerEntryOwnedLayer", layerSnapshot(outerLayer))
                .put("allOwnedLayers", layers).put("modifierChain", modifiers)
                .put("qrLayout", JSONObject().put("widthPx", info.width).put("heightPx", info.height)
                    .put("density", info.density.density.toDouble()).put("fontScale", info.density.fontScale.toDouble())
                    .put("semanticsBoundsInRoot", rect(node.boundsInRoot)).put("semanticsBoundsInWindow", rect(node.boundsInWindow)))
        }
    }

    private fun transitionSnapshot(transition: Any): JSONObject {
        val states = call(transition, "getAnimations") as? List<*> ?: throw UnsupportedObservation("Transition animations unavailable")
        val values = JSONObject()
        val labels = mutableSetOf<String>()
        for (state in states) {
            requireSupported(state != null, "Null animation state")
            val label = call(state!!, "getLabel") as? String ?: throw UnsupportedObservation("Animation label unavailable")
            assertTrue("Duplicate transition animation label", labels.add(label))
            val value = call(state, "getValue") as? Number ?: throw UnsupportedObservation("Non-numeric animation value")
            assertTrue("Animation value must be finite", value.toDouble().isFinite())
            values.put(label, JSONObject().put("value", value.toDouble()).put("stateClass", state.javaClass.name)
                .put("durationNanos", callPrefix(state, "getDurationNanos\$"))
                .put("isFinished", callPrefix(state, "isFinished\$")))
        }
        requireSupported(labels == EXPECTED_LABELS, "Wrong production animation set: $labels")
        return JSONObject().put("class", transition.javaClass.name).put("identity", System.identityHashCode(transition))
            .put("label", call(transition, "getLabel")).put("startTimeNanos", callPrefix(transition, "getStartTimeNanos\$"))
            .put("playTimeNanos", call(transition, "getPlayTimeNanos")).put("isRunning", call(transition, "isRunning"))
            .put("currentState", call(transition, "getCurrentState")).put("targetState", call(transition, "getTargetState"))
            .put("totalDurationNanos", call(transition, "getTotalDurationNanos")).put("animations", values)
    }

    private fun layerSnapshot(layer: Any): JSONObject {
        val target = when (layer.javaClass.simpleName) {
            "GraphicsLayerOwnerLayer" -> fieldValue(layer, "graphicsLayer")
            "RenderNodeLayer" -> fieldValue(layer, "renderNode")
            "ViewLayer" -> layer
            else -> throw UnsupportedObservation("Unsupported actual OwnedLayer ${layer.javaClass.name}")
        }
        val result = JSONObject().put("ownedLayerClass", layer.javaClass.name).put("ownedLayerIdentity", System.identityHashCode(layer))
            .put("propertyObjectClass", target.javaClass.name)
        for (name in listOf("getAlpha", "getScaleX", "getScaleY")) {
            val value = call(target, name) as? Number ?: throw UnsupportedObservation("Missing actual layer property $name")
            assertTrue(value.toDouble().isFinite())
            result.put(name.removePrefix("get").replaceFirstChar { it.lowercase() }, value.toDouble())
        }
        result.put("additionalProperties", optionalLayerProperties(target))
        if (layer.javaClass.simpleName == "GraphicsLayerOwnerLayer") {
            result.put("topLeftPackedIntOffset", packedInts((callPrefix(target, "getTopLeft-") as Number).toLong()))
                .put("sizePackedIntSize", packedInts((callPrefix(target, "getSize-") as Number).toLong()))
                .put("pivotPackedFloatOffset", packedFloats((callPrefix(target, "getPivotOffset-") as Number).toLong()))
            val impl = callPrefix(target, "getImpl\$") ?: throw UnsupportedObservation("GraphicsLayer backend is null")
            result.put("backendClass", impl.javaClass.name)
            if (impl.javaClass.simpleName == "GraphicsLayerV29") {
                val actualNode = fieldValue(impl, "renderNode")
                result.put("androidRenderNode", JSONObject().put("class", actualNode.javaClass.name)
                    .put("properties", optionalLayerProperties(actualNode)))
            }
        }
        val effectMethod = findMethod(target, "getRenderEffect")
        result.put("renderEffectGetterAvailable", effectMethod != null)
        result.put("renderEffect", effectMethod?.invoke(target)?.let { effectSnapshot(it, 0) } ?: JSONObject.NULL)
        result.put("effectReadScope", "Stored Compose/backend property; no asAndroidRenderEffect call and no independent GPU-effect claim")
        return result
    }

    private fun optionalLayerProperties(target: Any): JSONObject {
        val values = JSONObject()
        val availability = JSONObject()
        for (name in listOf("getAlpha", "getScaleX", "getScaleY", "getTranslationX", "getTranslationY", "getRotationX", "getRotationY", "getRotationZ", "getPivotX", "getPivotY", "getLeft", "getTop", "getRight", "getBottom", "getWidth", "getHeight", "getClip", "getClipToBounds", "getClipToOutline")) {
            val method = findMethod(target, name)
            availability.put(name, method != null)
            method?.let { values.put(name.removePrefix("get").replaceFirstChar { it.lowercase() }, it.invoke(target) ?: JSONObject.NULL) }
        }
        return JSONObject().put("values", values).put("getterAvailability", availability)
    }

    private fun packedInts(bits: Long): JSONObject = JSONObject().put("packedHex", java.lang.Long.toHexString(bits))
        .put("first", (bits shr 32).toInt()).put("second", bits.toInt())

    private fun packedFloats(bits: Long): JSONObject {
        val first = java.lang.Float.intBitsToFloat((bits shr 32).toInt())
        val second = java.lang.Float.intBitsToFloat(bits.toInt())
        return JSONObject().put("packedHex", java.lang.Long.toHexString(bits))
            .put("bothFinite", first.isFinite() && second.isFinite())
            .put("first", if (first.isFinite()) first.toDouble() else JSONObject.NULL)
            .put("second", if (second.isFinite()) second.toDouble() else JSONObject.NULL)
            .put("unspecifiedOrNonFinitePreserved", !first.isFinite() || !second.isFinite())
    }

    private fun effectSnapshot(effect: Any, depth: Int): JSONObject {
        val result = JSONObject().put("class", effect.javaClass.name).put("identity", System.identityHashCode(effect))
            .put("platformEffectCacheInspected", false)
            .put("fieldObservationScope", "Declared Compose subtype values only; the RenderEffect base platform cache is not inspected")
        if (depth >= 3) return result.put("childrenTruncated", true)
        // On API 30, enumerating the RenderEffect base fields or even BlurEffect
        // methods resolves the absent android.graphics.RenderEffect class. Read
        // only the known Compose 1.7.1 subtype fields, never its superclass/cache.
        val fieldNames = when (effect.javaClass.name) {
            "androidx.compose.ui.graphics.BlurEffect" -> listOf("radiusX", "radiusY", "edgeTreatment", "renderEffect")
            else -> return result.put("composeSubtypeFieldsAvailable", false)
                .put("metadataUnavailableReason", "No safe declared-field reader for this effect subtype")
        }
        result.put("composeSubtypeFieldsAvailable", true)
        for (name in fieldNames) {
            val field = effect.javaClass.getDeclaredField(name)
            field.isAccessible = true
            val value = field.get(effect)
            result.put(field.name, when (value) {
                null -> JSONObject.NULL
                is Number, is Boolean, is String -> value
                else -> if (value.javaClass.name.startsWith("androidx.compose.ui.graphics.")) effectSnapshot(value, depth + 1) else value.javaClass.name
            })
        }
        return result
    }

    private fun assertInitial(observed: JSONObject) {
        assertFalse(observed.getBoolean("autoAdvance"))
        val tr = observed.getJSONObject("transition")
        assertFalse("Initial production transition already ran", tr.getBoolean("isRunning"))
        assertEquals(false, tr.get("currentState"))
        assertEquals(false, tr.get("targetState"))
        assertEquals(Long.MIN_VALUE, tr.getLong("startTimeNanos"))
        assertEquals(0L, tr.getLong("playTimeNanos"))
        assertValues(tr, mapOf(ALPHA to .12f, SCALE to 1.16f, BLUR to 18f, OVERLAY to .24f, BIAS to 58f))
    }

    private fun assertValues(transition: JSONObject, expected: Map<String, Float>) {
        for ((name, value) in expected) assertEquals(name, value.toDouble(), transition.getJSONObject("animations").getJSONObject(name).getDouble("value"), 0.000001)
    }

    private fun assertAppliedLayer(observed: JSONObject) {
        val values = observed.getJSONObject("transition").getJSONObject("animations")
        val layer = observed.getJSONObject("outerEntryOwnedLayer")
        assertEquals("Actual owned-layer alpha must match the production State", values.getJSONObject(ALPHA).getDouble("value"), layer.getDouble("alpha"), 0.000001)
        for (axis in listOf("scaleX", "scaleY")) assertEquals("Actual owned-layer $axis must match the production State", values.getJSONObject(SCALE).getDouble("value"), layer.getDouble(axis), 0.000001)
    }

    private fun phaseSignature(observed: JSONObject): String = JSONObject()
        .put("clock", observed.getLong("mainClockTimeMs")).put("autoAdvance", observed.getBoolean("autoAdvance"))
        .put("transition", observed.getJSONObject("transition")).toString()

    private fun textMetrics(): JSONObject {
        val result = JSONObject()
        for ((role, text) in listOf("title" to "工信部备案", "subtitle" to "beian.miit.gov.cn")) {
            val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode()
            result.put(role, onMain {
                val layouts = mutableListOf<TextLayoutResult>()
                assertEquals(true, node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts))
                assertEquals(1, layouts.size)
                val layout = layouts.single()
                val style = layout.layoutInput.style
                JSONObject().put("text", text).put("method", "Production SemanticsActions.GetTextLayoutResult")
                    .put("widthPx", layout.size.width).put("heightPx", layout.size.height)
                    .put("firstBaselinePx", layout.firstBaseline.toDouble()).put("lastBaselinePx", layout.lastBaseline.toDouble())
                    .put("boundsInRoot", rect(node.boundsInRoot)).put("boundsInWindow", rect(node.boundsInWindow))
                    .put("density", layout.layoutInput.density.density.toDouble()).put("fontScale", layout.layoutInput.density.fontScale.toDouble())
                    .put("fontSize", style.fontSize.toString()).put("lineHeight", style.lineHeight.toString())
                    .put("fontSizePxViaLayoutDensity", with(layout.layoutInput.density) { style.fontSize.toPx() }.toDouble())
                    .put("fontWeight", style.fontWeight?.weight ?: JSONObject.NULL).put("fontFamily", style.fontFamily?.toString() ?: JSONObject.NULL)
                    .put("resolvedTypefacePerGlyphMeasured", false)
            })
        }
        return result
    }

    private fun globalConditions(): JSONObject = JSONObject()
        .put("target", resourceConditions(context.resources))
        .put("application", resourceConditions(context.applicationContext.resources))
        .put("system", resourceConditions(Resources.getSystem()))
        .put("settingsSystemFontScale", Settings.System.getString(context.contentResolver, Settings.System.FONT_SCALE) ?: JSONObject.NULL)
        .put("animatorDurationScale", Settings.Global.getString(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE) ?: JSONObject.NULL)

    private fun resourceConditions(resources: Resources): JSONObject {
        val c = resources.configuration
        val m = resources.displayMetrics
        return JSONObject().put("configuration", c.toString()).put("fontScale", c.fontScale.toDouble())
            .put("density", m.density.toDouble()).put("densityDpi", m.densityDpi).put("scaledDensity", m.scaledDensity.toDouble())
            .put("widthPixels", m.widthPixels).put("heightPixels", m.heightPixels)
            .put("screenRound", c.isScreenRound).put("sdkInt", Build.VERSION.SDK_INT)
    }

    private fun rect(r: Rect): JSONObject = JSONObject().put("left", r.left.toDouble()).put("top", r.top.toDouble()).put("right", r.right.toDouble()).put("bottom", r.bottom.toDouble())
    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun pixelHash(bitmap: Bitmap): String {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        val digest = MessageDigest.getInstance("SHA-256")
        for (p in pixels) digest.update(byteArrayOf((p ushr 24).toByte(), (p ushr 16).toByte(), (p ushr 8).toByte(), p.toByte()))
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun writeProofAtomically(proof: JSONObject) {
        val directory = context.getExternalFilesDir(null) ?: throw IllegalStateException("External evidence directory unavailable")
        val destination = File(directory, "native-beian-animation-proof.json")
        val temporary = File.createTempFile("native-beian-animation-", ".pending", directory)
        try {
            FileOutputStream(temporary).use { it.write(proof.toString(2).toByteArray(Charsets.UTF_8)); it.fd.sync() }
            check(temporary.renameTo(destination)) { "Atomic proof replacement failed; prior proof is not this runNonce" }
        } finally {
            temporary.delete()
        }
    }

    private fun instanceFields(type: Class<*>): List<Field> = generateSequence(type) { it.superclass }
        .takeWhile { it != Any::class.java }.flatMap { it.declaredFields.asSequence() }
        .filterNot { Modifier.isStatic(it.modifiers) }.toList()

    private fun fieldValue(receiver: Any, name: String): Any {
        val field = instanceFields(receiver.javaClass).singleOrNull { it.name == name }
            ?: throw UnsupportedObservation("Missing ${receiver.javaClass.name}.$name")
        field.isAccessible = true
        return field.get(receiver) ?: throw UnsupportedObservation("Null ${receiver.javaClass.name}.$name")
    }

    private fun findMethod(receiver: Any, name: String): Method? {
        val method = receiver.javaClass.methods.firstOrNull { it.name == name && it.parameterCount == 0 }
            ?: generateSequence(receiver.javaClass) { it.superclass }.flatMap { it.declaredMethods.asSequence() }
                .firstOrNull { it.name == name && it.parameterCount == 0 }
        method?.isAccessible = true
        return method
    }

    private fun call(receiver: Any, name: String): Any? = (findMethod(receiver, name)
        ?: throw UnsupportedObservation("Missing getter ${receiver.javaClass.name}.$name")).invoke(receiver)

    private fun callPrefix(receiver: Any, prefix: String): Any? {
        val methods = receiver.javaClass.methods.filter { it.name.startsWith(prefix) && it.parameterCount == 0 }
        requireSupported(methods.size == 1, "Expected one ${receiver.javaClass.name} getter starting $prefix")
        methods.single().isAccessible = true
        return methods.single().invoke(receiver)
    }

    private fun requireSupported(condition: Boolean, message: String) { if (!condition) throw UnsupportedObservation(message) }
    private class UnsupportedObservation(message: String) : RuntimeException(message)

    private fun <T> onMain(block: () -> T): T {
        val value = AtomicReference<T>()
        val error = AtomicReference<Throwable>()
        instrumentation.runOnMainSync { try { value.set(block()) } catch (caught: Throwable) { error.set(caught) } }
        error.get()?.let { throw it }
        return value.get()
    }

    private class OwnedLifecycle(private val runId: String) : Application.ActivityLifecycleCallbacks {
        val owned = mutableListOf<Activity>()
        val destroyed = mutableSetOf<Activity>()
        val events = JSONArray()
        val resumed = CountDownLatch(1)
        private val cleanupPending = mutableSetOf<Activity>()
        private var cleanupDestroyed: CountDownLatch? = null
        fun beginCleanup(): CountDownLatch {
            cleanupPending.addAll(owned.filterNot { destroyed.contains(it) })
            return CountDownLatch(cleanupPending.size).also { cleanupDestroyed = it }
        }
        private fun isOwned(a: Activity) = a is BeianActivity && a.intent.getStringExtra(RUN_EXTRA) == runId
        private fun record(a: Activity, event: String, state: Bundle? = null) {
            if (isOwned(a)) events.put(JSONObject().put("activityIdentity", System.identityHashCode(a)).put("event", event)
                .put("atElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos()).put("bundlePresent", state != null))
        }
        override fun onActivityCreated(a: Activity, state: Bundle?) { if (isOwned(a)) owned.add(a); record(a, "created", state) }
        override fun onActivityStarted(a: Activity) { record(a, "started") }
        override fun onActivityResumed(a: Activity) { record(a, "resumed"); if (isOwned(a)) resumed.countDown() }
        override fun onActivityPaused(a: Activity) { record(a, "paused") }
        override fun onActivityStopped(a: Activity) { record(a, "stopped") }
        override fun onActivitySaveInstanceState(a: Activity, state: Bundle) { record(a, "saved", state) }
        override fun onActivityDestroyed(a: Activity) {
            record(a, "destroyed")
            if (isOwned(a)) destroyed.add(a)
            if (cleanupPending.remove(a)) cleanupDestroyed?.countDown()
        }
    }

    private companion object {
        const val QR_DESCRIPTION = "备案查询二维码，扫描后可在手机浏览器中打开备案查询页面"
        const val RUN_EXTRA = "dev.podjs.reference.beian-animation-run"
        const val TRANSITION_CLASS = "androidx.compose.animation.core.Transition"
        const val ANIMATION_STATE_CLASS = "androidx.compose.animation.core.Transition\$TransitionAnimationState"
        const val TRANSITION_LABEL = "QrCodePanelImageEntry"
        const val ALPHA = "QrCodePanelImageAlpha"
        const val SCALE = "QrCodePanelImageScale"
        const val BLUR = "QrCodePanelImageBlur"
        const val OVERLAY = "QrCodePanelImageBrightnessOverlay"
        const val BIAS = "QrCodePanelImageBrightnessBias"
        val EXPECTED_LABELS = setOf(ALPHA, SCALE, BLUR, OVERLAY, BIAS)
        const val TIMEOUT_SECONDS = 10L
        const val MAX_ORIGIN_FRAMES = 16
        const val MAX_PHASE_FRAMES = 512
    }
}
