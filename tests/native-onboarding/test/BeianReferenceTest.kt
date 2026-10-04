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
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontListFontFamily
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Captures the actual production Activity; never injects touch, key, or focus input. */
@RunWith(AndroidJUnit4::class)
class BeianReferenceTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    @Test fun captureNativeBeianAndSystemRecreation() {
        val context = instrumentation.targetContext
        assertEquals("com.lightningstudio.watchrss.onboardingreference", context.packageName)
        assertEquals(context.packageName, BuildConfig.APPLICATION_ID)
        assertFalse(BuildConfig.DEBUG)
        val application = context.applicationContext as Application
        val observations = LifecycleObservations()
        onMain { application.registerActivityLifecycleCallbacks(observations) }
        var initialBitmap: Bitmap? = null
        var recreatedBitmap: Bitmap? = null
        try {
            val initialActivity = instrumentation.startActivitySync(
                BeianActivity.createIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ) as BeianActivity
            awaitResumed(observations, expected = initialActivity)
            assertEquals(BeianActivity::class.java, initialActivity.javaClass)
            assertNativeSemantics()
            initialBitmap = captureAfterEntry(initialActivity, "native-beian-reference.png")
            val initialTextMetrics = captureTextMetrics()
            val firstIdentity = System.identityHashCode(initialActivity)

            // Android saves/restores the Activity Bundle and constructs a new real Activity.
            // Calling recreate on the main thread avoids any physical interaction or input synthesis.
            onMain { initialActivity.recreate() }
            val recreatedActivity = awaitResumed(observations, differentFrom = initialActivity)
            assertEquals(BeianActivity::class.java, recreatedActivity.javaClass)
            assertNotSame(initialActivity, recreatedActivity)
            assertNativeSemantics()
            recreatedBitmap = captureAfterEntry(recreatedActivity, "native-beian-recreated.png")
            val recreatedTextMetrics = captureTextMetrics()

            val systemState = onMain {
                assertTrue("Android must deliver onSaveInstanceState", observations.savedCount > 0)
                assertTrue("Android must restore a non-null Bundle", observations.restoredCount > 0)
                assertTrue("The old Activity must be destroyed", observations.destroyed.contains(initialActivity))
                JSONObject()
                    .put("savedInstanceStateCallbacks", observations.savedCount)
                    .put("restoredInstanceStateCallbacks", observations.restoredCount)
                    .put("savedBundleKeys", JSONArray(observations.savedKeys))
                    .put("restoredBundleKeys", JSONArray(observations.restoredKeys))
                    .put("oldActivityDestroyed", true)
            }
            File(context.getExternalFilesDir(null), "native-beian-proof.json").writeText(
                JSONObject()
                    .put("test", "dev.podjs.reference.BeianReferenceTest#captureNativeBeianAndSystemRecreation")
                    .put("packageName", context.packageName)
                    .put("productionActivityClass", BeianActivity::class.java.name)
                    .put("productionBuildBranch", true)
                    .put("clonedComposable", false)
                    .put("firstActivityIdentity", firstIdentity)
                    .put("recreatedActivityIdentity", System.identityHashCode(recreatedActivity))
                    .put("activityInstanceChanged", initialActivity !== recreatedActivity)
                    .put("systemRecreation", systemState)
                    .put("entryAnimationWaitMillis", ENTRY_WAIT_MS)
                    .put("windowCapture", "PixelCopy")
                    .put("width", initialBitmap.width)
                    .put("height", initialBitmap.height)
                    .put("recreatedPixelsEqual", initialBitmap.sameAs(recreatedBitmap))
                    .put("initialTextMetrics", initialTextMetrics)
                    .put("recreatedTextMetrics", recreatedTextMetrics)
                    .put("title", TITLE)
                    .put("titleContentDescription", TITLE_DESCRIPTION)
                    .put("qrContentDescription", QR_DESCRIPTION)
                    .put("pageContentDescription", PAGE_DESCRIPTION)
                    .put("subtitle", SUBTITLE)
                    .put("qrUrl", "https://beian.miit.gov.cn/")
                    .put("semanticsVerifiedBeforeAndAfterRecreate", true)
                    .put("physicalInputInjected", false)
                    .put("focusInputInjected", false)
                    .put("networkActionsRequested", false)
                    .put("userRecordsSeeded", false)
                    .put("scope", "isolated-package real Activity recreation; no process death claim")
                    .put("captures", JSONArray(listOf("native-beian-reference.png", "native-beian-recreated.png")))
                    .toString(2)
            )
        } finally {
            initialBitmap?.recycle()
            recreatedBitmap?.recycle()
            onMain {
                observations.current?.takeUnless { it.isFinishing || it.isDestroyed }?.finish()
                application.unregisterActivityLifecycleCallbacks(observations)
            }
            instrumentation.waitForIdleSync()
        }
    }

    private fun assertNativeSemantics() {
        compose.waitForIdle()
        compose.onNodeWithText(TITLE, useUnmergedTree = true).assertExists()
        compose.onNodeWithText(SUBTITLE, useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription(TITLE_DESCRIPTION, useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription(QR_DESCRIPTION, useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription(PAGE_DESCRIPTION, useUnmergedTree = true).assertExists()
    }

    private fun captureTextMetrics(): JSONObject = JSONObject()
        .put("title", textMetrics(TITLE))
        .put("subtitle", textMetrics(SUBTITLE))

    private fun textMetrics(text: String): JSONObject {
        val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode()
        val results = mutableListOf<TextLayoutResult>()
        val action = node.config[SemanticsActions.GetTextLayoutResult].action
        onMain { assertEquals(true, action?.invoke(results)) }
        assertEquals("Expected one real Text layout for $text", 1, results.size)
        return onMain {
            val layout = results.single()
            val style = layout.layoutInput.style
            val bounds = node.boundsInRoot
            val boundsInWindow = node.boundsInWindow
            val family = style.fontFamily
            JSONObject().put("text", layout.layoutInput.text.text)
                .put("method", "production node SemanticsActions.GetTextLayoutResult")
                .put("size", JSONObject().put("width", layout.size.width).put("height", layout.size.height))
                .put("firstBaseline", layout.firstBaseline.toDouble())
                .put("lastBaseline", layout.lastBaseline.toDouble())
                .put("firstBaselineInRoot", (bounds.top + layout.firstBaseline).toDouble())
                .put("density", layout.layoutInput.density.density.toDouble())
                .put("fontScale", layout.layoutInput.density.fontScale.toDouble())
                .put("requestedFontSize", style.fontSize.toString())
                .put("requestedLineHeight", style.lineHeight.toString())
                .put("requestedFontWeight", style.fontWeight?.weight ?: JSONObject.NULL)
                .put("requestedFontStyle", style.fontStyle?.toString() ?: JSONObject.NULL)
                .put("requestedFontFamily", family?.toString() ?: JSONObject.NULL)
                .put("requestedFontSynthesis", style.fontSynthesis?.toString() ?: JSONObject.NULL)
                .put("platformStyle", style.platformStyle?.toString() ?: JSONObject.NULL)
                .put("fontFamilyEntries", JSONArray((family as? FontListFontFamily)?.fonts?.map { font ->
                    JSONObject().put("requestedWeight", font.weight.weight)
                        .put("style", font.style.toString()).put("descriptor", font.toString())
                } ?: emptyList<JSONObject>()))
                .put("resolvedTypefaceWeightMeasured", false)
                .put("semanticsBoundsInRoot", JSONObject()
                    .put("left", bounds.left.toDouble()).put("top", bounds.top.toDouble())
                    .put("right", bounds.right.toDouble()).put("bottom", bounds.bottom.toDouble()))
                .put("semanticsBoundsInWindow", JSONObject()
                    .put("left", boundsInWindow.left.toDouble()).put("top", boundsInWindow.top.toDouble())
                    .put("right", boundsInWindow.right.toDouble()).put("bottom", boundsInWindow.bottom.toDouble()))
                .put("lines", JSONArray((0 until layout.lineCount).map { line ->
                    val top = layout.getLineTop(line)
                    val baseline = layout.getLineBaseline(line)
                    val bottom = layout.getLineBottom(line)
                    JSONObject().put("index", line)
                        .put("start", layout.getLineStart(line)).put("end", layout.getLineEnd(line))
                        .put("left", layout.getLineLeft(line).toDouble())
                        .put("right", layout.getLineRight(line).toDouble())
                        .put("top", top.toDouble()).put("bottom", bottom.toDouble())
                        .put("baseline", baseline.toDouble())
                        .put("lineTopMinusBaseline", (top - baseline).toDouble())
                        .put("lineBottomMinusBaseline", (bottom - baseline).toDouble())
                        .put("fontAscent", JSONObject.NULL).put("fontDescent", JSONObject.NULL)
                }))
                .put("fontAscentDescentNote", "Public TextLayoutResult exposes line boxes and baselines; derived line-box extents are not font ascent/descent.")
        }
    }

    private fun captureAfterEntry(activity: BeianActivity, filename: String): Bitmap {
        compose.waitForIdle()
        SystemClock.sleep(ENTRY_WAIT_MS)
        instrumentation.waitForIdleSync()
        val bitmap = onMain {
            val decor = activity.window.decorView
            assertTrue("Window must be attached", decor.isAttachedToWindow)
            assertTrue("Window must have real dimensions", decor.width > 0 && decor.height > 0)
            Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        }
        try {
            val result = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
            val latch = CountDownLatch(1)
            onMain {
                PixelCopy.request(activity.window, bitmap, {
                    result.set(it)
                    latch.countDown()
                }, Handler(Looper.getMainLooper()))
            }
            assertTrue("PixelCopy callback timeout", latch.await(10, TimeUnit.SECONDS))
            assertEquals(PixelCopy.SUCCESS, result.get())
            FileOutputStream(File(instrumentation.targetContext.getExternalFilesDir(null), filename)).use {
                assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
            }
            return bitmap
        } catch (error: Throwable) {
            bitmap.recycle()
            throw error
        }
    }

    private fun awaitResumed(
        observations: LifecycleObservations,
        expected: BeianActivity? = null,
        differentFrom: BeianActivity? = null,
    ): BeianActivity {
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (SystemClock.uptimeMillis() < deadline) {
            val resumed = onMain { observations.current }
            if (resumed != null && (expected == null || resumed === expected) && resumed !== differentFrom) {
                instrumentation.waitForIdleSync()
                return resumed
            }
            SystemClock.sleep(50)
        }
        throw AssertionError("The expected production BeianActivity did not resume")
    }

    private fun <T> onMain(block: () -> T): T {
        val value = AtomicReference<T>()
        instrumentation.runOnMainSync { value.set(block()) }
        return value.get()
    }

    private class LifecycleObservations : Application.ActivityLifecycleCallbacks {
        var current: BeianActivity? = null
        var savedCount = 0
        var restoredCount = 0
        var savedKeys = emptyList<String>()
        var restoredKeys = emptyList<String>()
        val destroyed = mutableListOf<BeianActivity>()

        override fun onActivityCreated(activity: Activity, state: Bundle?) {
            if (activity is BeianActivity && state != null) {
                restoredCount++
                restoredKeys = state.keySet().sorted()
            }
        }

        override fun onActivityResumed(activity: Activity) {
            if (activity is BeianActivity) current = activity
        }

        override fun onActivityPaused(activity: Activity) {
            if (current === activity) current = null
        }

        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {
            if (activity is BeianActivity) {
                savedCount++
                savedKeys = state.keySet().sorted()
            }
        }

        override fun onActivityDestroyed(activity: Activity) {
            if (activity is BeianActivity) destroyed.add(activity)
            if (current === activity) current = null
        }

        override fun onActivityStarted(activity: Activity) = Unit
        override fun onActivityStopped(activity: Activity) = Unit
    }

    private companion object {
        const val ENTRY_WAIT_MS = 2300L
        const val TITLE = "工信部备案"
        const val TITLE_DESCRIPTION = "标题：工信部备案"
        const val QR_DESCRIPTION = "备案查询二维码，扫描后可在手机浏览器中打开备案查询页面"
        const val PAGE_DESCRIPTION = "备案信息页面。使用手机扫描二维码访问工业和信息化部备案查询网站。"
        const val SUBTITLE = "beian.miit.gov.cn"
    }
}
