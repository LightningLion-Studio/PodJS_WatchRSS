package dev.podjs.reference

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.PixelCopy
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.platform.app.InstrumentationRegistry
import com.lightningstudio.watchrss.BuildConfig
import com.lightningstudio.watchrss.data.network.InternetAvailabilityStatus
import com.lightningstudio.watchrss.ui.screen.OobeScreen
import com.lightningstudio.watchrss.ui.screen.PrivacyPolicyConsentScreen
import com.lightningstudio.watchrss.ui.testing.OobeTestTags
import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
import com.lightningstudio.watchrss.ui.viewmodel.OobeUiState
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Native production composables; semantic callbacks run only in this fixture. */
class OnboardingReferenceTest {
    @get:Rule val compose = createAndroidComposeRule<OnboardingReferenceActivity>()
    @Test fun captureNativeIntro() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("com.lightningstudio.watchrss.onboardingreference", context.packageName)
        assertFalse(BuildConfig.DEBUG)
        val state = mutableStateOf(OobeUiState())
        val privacy = mutableStateOf(false)
        var completions = 0
        val captured = JSONArray()
        compose.setContent {
            WatchRSSTheme {
                if (privacy.value) PrivacyPolicyConsentScreen({}, {}, {})
                else OobeScreen(state.value, { state.value = state.value.copy(introPage = it) },
                    { completions++ }, {}, {})
            }
        }
        fun capture(name: String) {
            compose.waitForIdle()
            SystemClock.sleep(500)
            val bitmap = Bitmap.createBitmap(466, 466, Bitmap.Config.ARGB_8888)
            val result = AtomicInteger(PixelCopy.ERROR_UNKNOWN)
            val latch = CountDownLatch(1)
            PixelCopy.request(compose.activity.window, bitmap, {
                result.set(it); latch.countDown()
            }, Handler(Looper.getMainLooper()))
            assertTrue(latch.await(10, TimeUnit.SECONDS))
            assertEquals(PixelCopy.SUCCESS, result.get())
            FileOutputStream(File(context.getExternalFilesDir(null), "native-onboarding-$name.png")).use {
                assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
            }
            bitmap.recycle()
            captured.put(name)
        }
        fun invoke(tag: String) {
            val click = compose.onNodeWithTag(tag).fetchSemanticsNode().config[SemanticsActions.OnClick].action
            compose.runOnIdle { assertEquals(true, click?.invoke()) }
        }
        capture("welcome")
        invoke(OobeTestTags.NEXT_BUTTON); capture("agreement")
        invoke(OobeTestTags.NEXT_BUTTON); capture("agreement-error")
        invoke(OobeTestTags.AGREEMENT_CHECKBOX); capture("agreement-checked")
        invoke(OobeTestTags.NEXT_BUTTON); capture("customization")
        compose.runOnIdle { state.value = state.value.copy(introPage = 3) }
        capture("network-checking")
        compose.runOnIdle { state.value = state.value.copy(internetAvailabilityStatus = InternetAvailabilityStatus.Unavailable) }
        capture("network-unavailable")
        invoke(OobeTestTags.CONTINUE_BUTTON); capture("offline-warning")
        invoke(OobeTestTags.OFFLINE_WARNING_CANCEL_BUTTON)
        compose.runOnIdle { state.value = state.value.copy(internetAvailabilityStatus = InternetAvailabilityStatus.Bluetooth) }
        capture("network-bluetooth")
        invoke(OobeTestTags.CONTINUE_BUTTON); capture("bluetooth-warning")
        compose.runOnIdle { state.value = state.value.copy(internetAvailabilityStatus = InternetAvailabilityStatus.Available) }
        capture("network-available")
        invoke(OobeTestTags.CONTINUE_BUTTON)
        compose.runOnIdle { assertEquals(1, completions); privacy.value = true }
        capture("privacy")
        File(context.getExternalFilesDir(null), "native-onboarding-proof.json").writeText(
            JSONObject().put("captured", captured).put("productionBuildBranch", true)
                .put("physicalInputInjected", false).put("consentPersisted", false)
                .put("completionRequests", completions).toString()
        )
    }
}
