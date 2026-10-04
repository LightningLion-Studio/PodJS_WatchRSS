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
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.lightningstudio.watchrss.BeianActivity
import com.lightningstudio.watchrss.BuildConfig
import com.lightningstudio.watchrss.InfoActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs

/**
 * Real InfoActivity/InfoScreen/LegalDocumentRepository, with only the build-time backend isolated.
 * Scroll and click are direct Compose semantics callbacks, never injected touch/key/focus input.
 * Scroll outcomes are measurements, not assertions: fast/slow network scheduling can differ.
 * Activity.recreate and the Android Bundle are observed; this suite does NOT test process death.
 */
@RunWith(AndroidJUnit4::class)
class InfoRestorationReferenceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val listMatcher = SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)

    @Test fun staticBodyRecreation() = scenario("static") { server, lifecycle, proof ->
        val first = launch(InfoActivity.createIntent(context, TITLE, body("STATIC")), lifecycle)
        awaitBody("STATIC")
        scrollToMiddle()
        val before = snapshot(first, "static-before")
        val second = recreate(first, lifecycle)
        awaitBody("STATIC")
        val after = snapshot(second, "static-after")
        assertEquals(0, server.requestCount)
        recordComparison(proof, before, after)
        proof.put("recreation", lifecycle.recreationProof(first, second))
    }

    @Test fun slowRemoteBodyRecreation() = scenario("slow") { server, lifecycle, proof ->
        server.enqueue(body("SLOW"))
        val delayed = server.enqueue(body("SLOW"), gated = true)
        val first = launch(remoteIntent("slow"), lifecycle)
        awaitBody("SLOW")
        scrollToMiddle()
        val before = snapshot(first, "slow-before")
        val second = recreate(first, lifecycle)
        server.awaitRequest(2)
        waitUntil("slow request must remove the InfoScreen list") { listNodes().isEmpty() }
        assertTrue(progressNodesPresent())
        proof.put("loading", capture(second, "slow-loading"))
        proof.put("loadingListAbsent", listNodes().isEmpty())
        delayed.release()
        awaitBody("SLOW")
        val after = snapshot(second, "slow-after")
        assertEquals(2, server.requestCount)
        recordComparison(proof, before, after)
        proof.put("recreation", lifecycle.recreationProof(first, second))
    }

    @Test fun fastRemoteBodyRecreation() = scenario("fast") { server, lifecycle, proof ->
        server.enqueue(body("FAST"))
        server.enqueue(body("FAST"))
        val first = launch(remoteIntent("fast"), lifecycle)
        awaitBody("FAST")
        scrollToMiddle()
        val before = snapshot(first, "fast-before")
        // The server responds immediately. The Compose test clock still controls recomposition.
        val second = recreate(first, lifecycle)
        val request = server.awaitRequest(2)
        request.awaitCompletion()
        awaitBody("FAST")
        val after = snapshot(second, "fast-after")
        assertEquals(2, server.requestCount)
        recordComparison(proof, before, after)
        proof.put("recreation", lifecycle.recreationProof(first, second))
            .put("fastResponsePolicy", "immediate HTTP response observed under the Compose test clock")
    }

    @Test fun beianCoverAndReturn() = scenario("beian-cover") { server, lifecycle, proof ->
        server.enqueue(body("COVER"))
        val first = launch(remoteIntent("beian-cover"), lifecycle)
        awaitBody("COVER")
        // Four leading list items, 32 paragraph items, then the real beian item.
        invokeScrollToIndex(4 + PARAGRAPHS)
        compose.onNodeWithText(BEIAN_LABEL, useUnmergedTree = true).assertExists()
        val before = snapshot(first, "beian-cover-before")
        proof.put("before", before)
        val click = compose.onNodeWithText(BEIAN_LABEL, useUnmergedTree = true)
            .fetchSemanticsNode().config[SemanticsActions.OnClick].action
        onMain { assertEquals(true, click?.invoke()) }
        val covered = awaitResumed(lifecycle, BeianActivity::class.java)
        SystemClock.sleep(2300)
        proof.put("beianCapture", capture(covered, "beian-cover-visible"))
        proof.put("beianActivityClass", covered.javaClass.name)
        onMain { covered.finish() }
        val returned = awaitResumed(lifecycle, InfoActivity::class.java)
        assertSame("Cover/return must retain the original InfoActivity", first, returned)
        waitUntil("Info list must return after Beian finishes") { listNodes().size == 1 }
        proof.put("returnedBeforeOverlayWait", snapshot(returned, "beian-cover-returned-before-wait"))
            .put("returnedActivityStateBeforeOverlayWait", onMain { activityState(returned, lifecycle) })
        waitUntil("Real window focus must clear the native navigation overlay") {
            onMain { returned.hasWindowFocus() } && !progressNodesPresent()
        }
        SystemClock.sleep(250)
        val after = snapshot(returned, "beian-cover-returned")
        assertEquals("Covering Info must not re-run its network effect", 1, server.requestCount)
        recordComparison(proof, before, after)
        proof.put("sameInfoActivityOnReturn", true)
            .put("infoActivityIdentity", System.identityHashCode(first))
            .put("requestCountBeforeCover", 1)
            .put("requestCountAfterReturn", server.requestCount)
    }

    @Test fun lateOldRequestAfterRecreation() = scenario("late-old") { server, lifecycle, proof ->
        val oldPlan = server.enqueue(body("OLD-RESPONSE"), gated = true)
        val newPlan = server.enqueue(body("NEW-RESPONSE"), gated = true)
        val first = launch(remoteIntent("late-old"), lifecycle)
        val oldRequest = server.awaitRequest(1)
        waitUntil("First request must be showing loading") { listNodes().isEmpty() && progressNodesPresent() }
        proof.put("firstLoading", capture(first, "late-old-first-loading"))
        val second = recreate(first, lifecycle)
        val newRequest = server.awaitRequest(2)
        assertFalse("Old request must still be gated when new request arrives", oldRequest.completed.get())
        newPlan.release()
        newRequest.awaitCompletion()
        awaitBody("NEW-RESPONSE")
        val beforeOldResponse = snapshot(second, "late-old-new-response")
        proof.put("newDocumentBeforeOldResponse", beforeOldResponse)
            .put("recreationBeforeOldResponse", onMain { lifecycle.recreationProof(first, second) })
        assertFalse("Old request must remain pending until its explicit late release", oldRequest.completed.get())
        oldPlan.release()
        proof.put("oldRequestReleasedAtMillis", oldPlan.releasedAt)
        oldRequest.awaitCompletion()
        compose.waitForIdle()
        SystemClock.sleep(300)
        awaitBody("NEW-RESPONSE")
        assertTrue("Late old response must not become the visible document", textNodes("OLD-RESPONSE").isEmpty())
        val afterOldResponse = snapshot(second, "late-old-after-old-response")
        assertEquals(2, server.requestCount)
        recordComparison(proof, beforeOldResponse, afterOldResponse)
        proof.put("recreation", lifecycle.recreationProof(first, second))
            .put("oldResponseReleasedAfterNewDocumentVisible", true)
            .put("newDocumentCapturedAtMillis", beforeOldResponse.getJSONObject("capture").getLong("capturedAtMillis"))
            .put("oldRequestReleasedAtMillis", oldPlan.releasedAt)
            .put("newDocumentStillVisible", true)
            .put("postOldResponseObservationMillis", 300)
    }

    private fun scenario(
        name: String,
        run: (GateServer, LifecycleObservations, JSONObject) -> Unit,
    ) {
        val proof = JSONObject()
            .put("scenario", name)
            .put("testClass", javaClass.name)
            .put("targetPackage", context.packageName)
            .put("activityClass", InfoActivity::class.java.name)
            .put("productionBuildBranch", !BuildConfig.DEBUG)
            .put("backendUrl", BuildConfig.WATCHRSS_BACKEND_URL)
            .put("clonedComposable", false)
            .put("physicalInputInjected", false)
            .put("focusInputInjected", false)
            .put("networkScope", "only loopback fixture; real production OkHttp fetch")
            .put("userRecordsSeeded", false)
            .put("scrollOutcomeAsserted", false)
            .put("composeTestClockAutoAdvance", compose.mainClock.autoAdvance)
            .put("timingScope", "real Android Activity/network lifecycle; Compose test clock, not unrestricted production frame scheduling")
            .put("processDeathTested", false)
            .put("pidBefore", android.os.Process.myPid())
            .put("passed", false)
        val lifecycle = LifecycleObservations()
        val application = context.applicationContext as Application
        var server: GateServer? = null
        try {
            assertEquals("com.lightningstudio.watchrss.onboardingreference", context.packageName)
            assertEquals(context.packageName, BuildConfig.APPLICATION_ID)
            assertEquals(BACKEND, BuildConfig.WATCHRSS_BACKEND_URL)
            assertFalse(BuildConfig.DEBUG)
            server = GateServer()
            onMain { application.registerActivityLifecycleCallbacks(lifecycle) }
            run(server, lifecycle, proof)
            assertTrue("Loopback server errors: " + server.failures(), server.failures().isEmpty())
            proof.put("passed", true)
        } catch (error: Throwable) {
            proof.put("failure", error.javaClass.name + ": " + error.message)
            try {
                proof.put("failureObservation", failureObservation(name, lifecycle))
            } catch (diagnosticError: Throwable) {
                proof.put("failureObservationError", diagnosticError.javaClass.name + ": " + diagnosticError.message)
            }
            throw error
        } finally {
            onMain {
                lifecycle.activities.reversed().forEach {
                    if (!it.isDestroyed && !it.isFinishing) it.finish()
                }
            }
            instrumentation.waitForIdleSync()
            onMain { application.unregisterActivityLifecycleCallbacks(lifecycle) }
            server?.close()
            proof.put("requests", server?.proof() ?: JSONArray())
                .put("serverFailures", JSONArray(server?.failures() ?: emptyList<String>()))
                .put("lifecycle", onMain { JSONArray(lifecycle.events) })
                .put("pidAfter", android.os.Process.myPid())
            File(context.getExternalFilesDir(null), "native-info-$name-proof.json").writeText(proof.toString(2))
        }
    }

    private fun remoteIntent(name: String): Intent = InfoActivity.createRemoteIntent(
        context, TITLE, InfoActivity.WATCH_USER_AGREEMENT_PATH + "?reference=" + name
    )

    private fun launch(intent: Intent, lifecycle: LifecycleObservations): InfoActivity {
        val activity = instrumentation.startActivitySync(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as InfoActivity
        assertSame(activity, awaitResumed(lifecycle, InfoActivity::class.java))
        return activity
    }

    private fun recreate(first: InfoActivity, lifecycle: LifecycleObservations): InfoActivity {
        onMain { first.recreate() }
        val second = awaitResumed(lifecycle, InfoActivity::class.java, differentFrom = first)
        assertNotSame(first, second)
        return second
    }

    private fun <T : Activity> awaitResumed(
        lifecycle: LifecycleObservations,
        type: Class<T>,
        differentFrom: Activity? = null,
    ): T {
        val end = SystemClock.uptimeMillis() + 12_000
        while (SystemClock.uptimeMillis() < end) {
            val activity = onMain { lifecycle.resumed }
            if (type.isInstance(activity) && activity !== differentFrom) {
                instrumentation.waitForIdleSync()
                return type.cast(activity)!!
            }
            SystemClock.sleep(20)
        }
        throw AssertionError("Expected resumed " + type.name)
    }

    private fun awaitBody(marker: String) {
        waitUntil("Document $marker must be visible") { listNodes().size == 1 && textNodes(marker).isNotEmpty() }
    }

    private fun waitUntil(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 8_000
        var lastFailure: Throwable? = null
        while (SystemClock.uptimeMillis() < deadline) {
            try {
                if (condition()) return
            } catch (error: Throwable) {
                lastFailure = error
            }
            SystemClock.sleep(20)
        }
        throw AssertionError(message, lastFailure)
    }

    private fun listNodes() = compose.onAllNodes(listMatcher, useUnmergedTree = true).fetchSemanticsNodes()
    private fun textNodes(marker: String) = compose.onAllNodesWithText(
        marker, substring = true, useUnmergedTree = true
    ).fetchSemanticsNodes()

    private fun progressNodesPresent() = compose.onAllNodes(
        SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo), useUnmergedTree = true
    ).fetchSemanticsNodes().isNotEmpty()

    private fun invokeScrollToIndex(index: Int) {
        val action = listNodes().single().config[SemanticsActions.ScrollToIndex].action
        onMain { assertEquals(true, action?.invoke(index)) }
        compose.waitForIdle()
    }

    private fun scrollToMiddle() {
        invokeScrollToIndex(12)
        val action = listNodes().single().config[SemanticsActions.ScrollBy].action
        onMain { assertEquals(true, action?.invoke(0f, 37f)) }
        compose.waitForIdle()
        assertTrue("A nonzero scroll is required for a restoration observation", scrollAxis() > 0f)
    }

    private fun scrollAxis(): Float {
        val range = listNodes().single().config[SemanticsProperties.VerticalScrollAxisRange]
        return onMain { range.value() }
    }

    private fun snapshot(activity: Activity, name: String): JSONObject {
        compose.waitForIdle()
        val list = listNodes().single()
        val range = list.config[SemanticsProperties.VerticalScrollAxisRange]
        val text = compose.onAllNodes(
            SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), useUnmergedTree = true
        ).fetchSemanticsNodes()
        val observation = onMain {
            JSONObject().put("scrollAxis", range.value().toDouble())
                .put("scrollAxisMax", range.maxValue().toString())
                .put("activityIdentity", System.identityHashCode(activity))
                .put("activityClass", activity.javaClass.name)
                .put("texts", JSONArray(text.map { node ->
                    val bounds = node.boundsInRoot
                    JSONObject()
                        .put("text", node.config[SemanticsProperties.Text].joinToString("\n") { it.text })
                        .put("left", bounds.left.toDouble()).put("top", bounds.top.toDouble())
                        .put("right", bounds.right.toDouble()).put("bottom", bounds.bottom.toDouble())
                }))
        }
        return observation.put("capture", capture(activity, name))
    }

    private fun recordComparison(proof: JSONObject, before: JSONObject, after: JSONObject) {
        val delta = after.getDouble("scrollAxis") - before.getDouble("scrollAxis")
        proof.put("before", before).put("after", after)
            .put("observedScrollDelta", delta)
            .put("observedScrollUnchanged", abs(delta) < 0.0001)
            .put("observedPixelsEqual", before.getJSONObject("capture").getString("pixelSha256") ==
                after.getJSONObject("capture").getString("pixelSha256"))
    }

    /** Read-only failure evidence is collected before cleanup; it never changes the failed condition. */
    private fun failureObservation(name: String, lifecycle: LifecycleObservations): JSONObject {
        val observation = JSONObject().put("observedAtMillis", SystemClock.uptimeMillis())
        val current = onMain { lifecycle.resumed }
        observation.put("resumedActivity", onMain {
            current?.let { activityState(it, lifecycle) } ?: JSONObject.NULL
        }).put("activities", onMain {
            JSONArray(lifecycle.activities.map { activityState(it, lifecycle) })
        })
        // PixelCopy comes before semantic synchronization so the failing frame is retained directly.
        if (current != null && !onMain { current.isDestroyed }) {
            try {
                observation.put("capture", capture(current, "$name-failure", synchronizeCompose = false))
            } catch (error: Throwable) {
                observation.put("captureError", error.javaClass.name + ": " + error.message)
            }
        }
        try {
            val nodes = compose.onAllNodes(SemanticsMatcher("all nodes") { true }, useUnmergedTree = true)
                .fetchSemanticsNodes()
            val semanticObservation = onMain {
                val descriptions = nodes.map { describeNode(it, includeAncestors = true) }
                JSONObject().put("nodeCount", nodes.size)
                    .put("allNodes", JSONArray(descriptions))
                    .put("roots", JSONArray(nodes.filter { it.parent == null }.map { describeNode(it, false) }))
                    .put("rootIds", JSONArray(nodes.map { rootId(it) }.distinct()))
                    .put("lists", JSONArray(nodes.filter {
                        it.config.contains(SemanticsActions.ScrollToIndex)
                    }.map { describeNode(it, true) }))
                    .put("texts", JSONArray(nodes.filter {
                        it.config.contains(SemanticsProperties.Text)
                    }.map { describeNode(it, true) }))
                    .put("progressNodes", JSONArray(nodes.filter {
                        it.config.contains(SemanticsProperties.ProgressBarRangeInfo)
                    }.map { describeNode(it, true) }))
            }
            observation.put("semantics", semanticObservation)
        } catch (error: Throwable) {
            observation.put("semanticsError", error.javaClass.name + ": " + error.message)
        }
        observation.put("finishedAtMillis", SystemClock.uptimeMillis())
        return observation
    }

    private fun activityState(activity: Activity, lifecycle: LifecycleObservations): JSONObject {
        val decor = activity.window.decorView
        return JSONObject().put("class", activity.javaClass.name)
            .put("identity", System.identityHashCode(activity))
            .put("isRecordedResumed", lifecycle.resumed === activity)
            .put("hasWindowFocus", activity.hasWindowFocus())
            .put("decorHasWindowFocus", decor.hasWindowFocus())
            .put("decorAttached", decor.isAttachedToWindow)
            .put("decorShown", decor.isShown)
            .put("decorVisibility", decor.visibility)
            .put("windowVisibility", decor.windowVisibility)
            .put("width", decor.width).put("height", decor.height)
            .put("windowFlags", activity.window.attributes.flags)
            .put("isFinishing", activity.isFinishing).put("isDestroyed", activity.isDestroyed)
    }

    private fun rootId(node: SemanticsNode): Int {
        var root = node
        while (root.parent != null) root = root.parent!!
        return root.id
    }

    private fun describeNode(node: SemanticsNode, includeAncestors: Boolean): JSONObject {
        val bounds = node.boundsInRoot
        val config = node.config
        val description = JSONObject().put("id", node.id).put("rootId", rootId(node))
            .put("parentId", node.parent?.id ?: JSONObject.NULL)
            .put("boundsInRoot", JSONObject().put("left", bounds.left.toDouble())
                .put("top", bounds.top.toDouble()).put("right", bounds.right.toDouble())
                .put("bottom", bounds.bottom.toDouble()))
            .put("config", config.toString())
        if (config.contains(SemanticsProperties.Text)) {
            description.put("text", config[SemanticsProperties.Text].joinToString("\n") { it.text })
        }
        if (config.contains(SemanticsProperties.ContentDescription)) {
            description.put("contentDescription", JSONArray(config[SemanticsProperties.ContentDescription]))
        }
        if (config.contains(SemanticsProperties.ProgressBarRangeInfo)) {
            description.put("progress", config[SemanticsProperties.ProgressBarRangeInfo].toString())
        }
        if (config.contains(SemanticsProperties.VerticalScrollAxisRange)) {
            val range = config[SemanticsProperties.VerticalScrollAxisRange]
            description.put("scrollAxis", range.value().toString())
                .put("scrollAxisMax", range.maxValue().toString())
        }
        if (includeAncestors) {
            val ancestors = mutableListOf<JSONObject>()
            var parent = node.parent
            while (parent != null) {
                ancestors.add(describeNode(parent, includeAncestors = false))
                parent = parent.parent
            }
            description.put("ancestors", JSONArray(ancestors))
        }
        return description
    }

    private fun capture(activity: Activity, name: String, synchronizeCompose: Boolean = true): JSONObject {
        if (synchronizeCompose) compose.waitForIdle()
        instrumentation.waitForIdleSync()
        val bitmap = onMain {
            val decor = activity.window.decorView
            assertTrue(decor.isAttachedToWindow)
            assertTrue(decor.width > 0 && decor.height > 0)
            Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        }
        try {
            val code = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
            val latch = CountDownLatch(1)
            onMain {
                PixelCopy.request(activity.window, bitmap, {
                    code.set(it)
                    latch.countDown()
                }, Handler(Looper.getMainLooper()))
            }
            assertTrue("PixelCopy timed out", latch.await(5, TimeUnit.SECONDS))
            assertEquals(PixelCopy.SUCCESS, code.get())
            val file = File(context.getExternalFilesDir(null), "native-info-$name.png")
            FileOutputStream(file).use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            val pixels = ByteBuffer.allocate(bitmap.byteCount)
            bitmap.copyPixelsToBuffer(pixels)
            return JSONObject().put("file", file.name).put("method", "window PixelCopy")
                .put("capturedAtMillis", SystemClock.uptimeMillis())
                .put("width", bitmap.width).put("height", bitmap.height)
                .put("pixelSha256", sha256(pixels.array()))
                .put("pngSha256", sha256(file.readBytes()))
        } finally {
            bitmap.recycle()
        }
    }

    private fun <T> onMain(block: () -> T): T {
        val value = AtomicReference<T>()
        val failure = AtomicReference<Throwable>()
        instrumentation.runOnMainSync {
            try { value.set(block()) } catch (error: Throwable) { failure.set(error) }
        }
        failure.get()?.let { throw it }
        return value.get()
    }

    private class LifecycleObservations : Application.ActivityLifecycleCallbacks {
        val activities = mutableListOf<Activity>()
        val events = mutableListOf<JSONObject>()
        val restored = mutableSetOf<Activity>()
        val saved = mutableSetOf<Activity>()
        val destroyed = mutableSetOf<Activity>()
        var resumed: Activity? = null

        private fun record(activity: Activity, event: String, state: Bundle? = null) {
            if (activity !is InfoActivity && activity !is BeianActivity) return
            events.add(JSONObject().put("event", event).put("activity", activity.javaClass.name)
                .put("identity", System.identityHashCode(activity)).put("atMillis", SystemClock.uptimeMillis())
                .put("hasWindowFocus", activity.hasWindowFocus())
                .put("decorAttached", activity.window.decorView.isAttachedToWindow)
                .put("bundlePresent", state != null)
                .put("bundleKeys", JSONArray(state?.keySet()?.sorted() ?: emptyList<String>())))
        }

        fun recreationProof(first: Activity, second: Activity): JSONObject {
            // Called from the instrumentation thread after idle; all callbacks have already completed.
            assertTrue("Old Activity saved state", saved.contains(first))
            assertTrue("New Activity received system Bundle", restored.contains(second))
            assertTrue("Old Activity destroyed", destroyed.contains(first))
            return JSONObject().put("firstIdentity", System.identityHashCode(first))
                .put("secondIdentity", System.identityHashCode(second))
                .put("instanceChanged", first !== second).put("savedBundleObserved", true)
                .put("restoredBundleObserved", true).put("oldDestroyed", true)
                .put("mechanism", "real Activity.recreate; system-owned Bundle")
        }

        override fun onActivityCreated(activity: Activity, state: Bundle?) {
            if (activity is InfoActivity || activity is BeianActivity) {
                activities.add(activity)
                if (state != null) restored.add(activity)
            }
            record(activity, "created", state)
        }
        override fun onActivityResumed(activity: Activity) { resumed = activity; record(activity, "resumed") }
        override fun onActivityPaused(activity: Activity) {
            if (resumed === activity) resumed = null
            record(activity, "paused")
        }
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {
            saved.add(activity)
            record(activity, "saved", state)
        }
        override fun onActivityDestroyed(activity: Activity) {
            destroyed.add(activity)
            if (resumed === activity) resumed = null
            record(activity, "destroyed")
        }
        override fun onActivityStarted(activity: Activity) { record(activity, "started") }
        override fun onActivityStopped(activity: Activity) { record(activity, "stopped") }
    }

    private class ResponsePlan(val body: String, gated: Boolean) {
        val gate = CountDownLatch(if (gated) 1 else 0)
        val gateRequested = gated
        @Volatile var releasedAt = if (gated) 0L else SystemClock.uptimeMillis()
        fun release() {
            if (gate.count > 0) releasedAt = SystemClock.uptimeMillis()
            gate.countDown()
        }
    }

    private class RequestObservation(val number: Int, val path: String, val plan: ResponsePlan) {
        val receivedAt = SystemClock.uptimeMillis()
        val completed = AtomicBoolean(false)
        private val completion = CountDownLatch(1)
        @Volatile var responseAt = 0L
        @Volatile var responseSent = false
        @Volatile var failure: String? = null
        fun finish() { completed.set(true); completion.countDown() }
        fun awaitCompletion() {
            assertTrue("Request $number did not finish", completion.await(8, TimeUnit.SECONDS))
            assertNull("Request $number failed before a real response was sent", failure)
            assertTrue("Request $number completed without sending its response", responseSent)
        }
        fun proof() = JSONObject().put("number", number).put("path", path)
            .put("gated", plan.gateRequested).put("receivedAtMillis", receivedAt)
            .put("releasedAtMillis", plan.releasedAt)
            .put("responseAtMillis", responseAt).put("responseSent", responseSent)
            .put("completed", completed.get()).put("failure", failure ?: JSONObject.NULL)
            .put("bodySha256", sha256(plan.body.toByteArray(Charsets.UTF_8)))
    }

    /** Concurrent connections are essential: the old blocked fetch must not serialize the new one. */
    private class GateServer : Closeable {
        private val closed = AtomicBoolean(false)
        private val socket = ServerSocket()
        private val plans = LinkedBlockingQueue<ResponsePlan>()
        private val requests = Collections.synchronizedList(mutableListOf<RequestObservation>())
        private val serverErrors = Collections.synchronizedList(mutableListOf<String>())
        private val receivedCount = AtomicInteger(0)
        private val clients = Collections.synchronizedList(mutableListOf<Socket>())
        private val pool = Executors.newCachedThreadPool { runnable ->
            Thread(runnable, "native-info-loopback").apply { isDaemon = true }
        }
        val requestCount get() = receivedCount.get()

        init {
            try {
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT))
            } catch (error: Throwable) {
                socket.close()
                pool.shutdownNow()
                throw AssertionError("Cannot bind isolated reference backend 127.0.0.1:$PORT", error)
            }
            pool.execute {
                while (!closed.get()) {
                    try {
                        val client = socket.accept()
                        clients.add(client)
                        pool.execute { serve(client) }
                    } catch (error: Throwable) {
                        if (!closed.get()) serverErrors.add("accept: " + error.javaClass.name + ": " + error.message)
                    }
                }
            }
        }

        fun enqueue(body: String, gated: Boolean = false): ResponsePlan = ResponsePlan(body, gated).also(plans::add)

        fun awaitRequest(number: Int): RequestObservation {
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (SystemClock.uptimeMillis() < deadline) {
                synchronized(requests) { requests.getOrNull(number - 1) }?.let { return it }
                SystemClock.sleep(10)
            }
            throw AssertionError("Loopback request $number missing; observed $requestCount requests at port $PORT")
        }

        private fun serve(client: Socket) {
            var observed: RequestObservation? = null
            try {
                client.soTimeout = 12_000
                val reader = client.getInputStream().bufferedReader(Charsets.US_ASCII)
                val requestLine = reader.readLine() ?: throw AssertionError("Missing HTTP request line")
                val parts = requestLine.split(' ')
                val receivedNumber = receivedCount.incrementAndGet()
                assertEquals("GET", parts.firstOrNull())
                val path = parts.getOrNull(1) ?: throw AssertionError("Missing request path")
                assertTrue("Unexpected non-legal request: $path", path.startsWith(InfoActivity.WATCH_USER_AGREEMENT_PATH + "?reference="))
                var headerCount = 0
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    assertTrue("Too many request headers", ++headerCount < 100)
                }
                val plan = plans.poll(1, TimeUnit.SECONDS) ?: throw AssertionError("No response planned for $path")
                observed = synchronized(requests) {
                    RequestObservation(receivedNumber, path, plan).also(requests::add)
                }
                assertTrue("Response gate exceeded 10 seconds for $path", plan.gate.await(10, TimeUnit.SECONDS))
                val bytes = plan.body.toByteArray(Charsets.UTF_8)
                val output = client.getOutputStream()
                observed.responseAt = SystemClock.uptimeMillis()
                output.write(("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n" +
                    "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII))
                output.write(bytes)
                output.flush()
                observed.responseSent = true
            } catch (error: Throwable) {
                observed?.failure = error.javaClass.name + ": " + error.message
                if (!closed.get()) serverErrors.add(error.javaClass.name + ": " + error.message)
            } finally {
                observed?.finish()
                runCatching { client.close() }
                clients.remove(client)
            }
        }

        fun proof() = JSONArray(synchronized(requests) { requests.map { it.proof() } })
        fun failures() = synchronized(serverErrors) { serverErrors.toList() }

        override fun close() {
            closed.set(true)
            socket.close()
            synchronized(requests) { requests.forEach { it.plan.release() } }
            synchronized(clients) { clients.toList() }.forEach { runCatching { it.close() } }
            pool.shutdownNow()
            pool.awaitTermination(2, TimeUnit.SECONDS)
        }
    }

    private companion object {
        const val PORT = 38679
        const val BACKEND = "http://127.0.0.1:38679"
        const val TITLE = "原生协议恢复对照"
        const val BEIAN_LABEL = "浙ICP备2024111886号-5A"
        const val PARAGRAPHS = 32
        fun body(marker: String) = (1..PARAGRAPHS).joinToString("\n\n") {
            "$marker 第${it.toString().padStart(2, '0')}段。此内容仅用于隔离协议页面的生命周期与滚动验证。"
        }
        fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
    }
}
