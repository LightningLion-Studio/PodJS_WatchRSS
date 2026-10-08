package dev.podjs.takeover

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.Process
import androidx.test.platform.app.InstrumentationRegistry
import com.lightningstudio.watchrss.WatchRssApplication
import com.lightningstudio.watchrss.data.account.WatchAccountState
import com.lightningstudio.watchrss.data.account.WatchAccountStore
import com.lightningstudio.watchrss.data.account.WatchTelemetryConfig
import com.lightningstudio.watchrss.sdk.bili.BiliAccount
import com.lightningstudio.watchrss.sdk.bili.EncryptedBiliAccountStore
import com.lightningstudio.watchrss.sdk.douyin.EncryptedDouyinCookieStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore

/** Only synthetic credentials in the installed isolated package's own UID.
 * These tests never load a production account or copy/export a Keystore key. */
class T6bCredentialsTest {
    private fun context(code: Long): Context {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "com.lightningstudio.watchrss.podjs.rehearsal")
        check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        check(context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode == code)
        return context
    }

    private fun watch() = WatchAccountState(
        userId = "t5-rehearsal-user", phoneMasked = "000****0000",
        installId = "t5-rehearsal-install", watchDeviceToken = "t5-fake-watch-access",
        tokenExpiresAtMillis = 4102444800000L, watchRefreshToken = "t5-fake-watch-refresh",
        refreshTokenExpiresAtMillis = 4102444800000L,
        backendBaseUrl = "https://rehearsal.invalid", posthogHost = "https://rehearsal.invalid",
        posthogProjectApiKey = "t5-fake-project", updatedAtMillis = 1700000000000L,
        telemetryConfig = WatchTelemetryConfig(anonymousEnabled = false, diagnosticsEnabled = false)
    )

    private fun bili() = BiliAccount(
        cookies = mapOf("SESSDATA" to "t5-fake-bili-session", "bili_jct" to "t5-fake-bili-csrf"),
        refreshToken = "t5-fake-bili-refresh", updatedAtMillis = 1700000000000L,
        cookieRefreshCheckedAtMillis = 1700000000000L
    )

    private val douyin = "sessionid=t5-fake-douyin-session; csrf_session_id=t5-fake-douyin-csrf"
    private val stores = listOf("watchrss_account_state", "bili_account_store", "douyin_account_store")

    private suspend fun verify(context: Context) {
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertTrue("native_master_present", keys.containsAlias("_androidx_security_master_key_"))
        val files = stores.map { File(context.applicationInfo.dataDir, "shared_prefs/$it.xml") }
        assertTrue("three_ciphertext_files_present", files.all { it.isFile && it.length() > 0 })
        val before = files.map { it.readBytes() }
        // New instances and the default store names match the production callers.
        assertTrue("watch_matches", WatchAccountStore(context).read() == watch())
        assertTrue("bili_matches", EncryptedBiliAccountStore(context).read() == bili())
        assertTrue("douyin_matches", EncryptedDouyinCookieStore(context).readCookie() == douyin)
        assertTrue("native_read_did_not_repair_ciphertext", files.indices.all {
            before[it].contentEquals(files[it].readBytes())
        })
    }

    private fun report(stage: String) {
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
            putString("stage", stage)
            putInt("uid", Process.myUid())
            putBoolean("watchMatches", true)
            putBoolean("biliMatches", true)
            putBoolean("douyinMatches", true)
        })
    }

    @Test fun seedNative40() = runBlocking {
        val context = context(40)
        val marker = File(context.applicationInfo.dataDir, "recovery-rehearsal/seed.json")
        check(!marker.exists()) { "fixture_already_seeded" }
        val watchStore = WatchAccountStore(context)
        val biliStore = EncryptedBiliAccountStore(context)
        val douyinStore = EncryptedDouyinCookieStore(context)
        check(watchStore.read() == null && biliStore.read() == null && douyinStore.readCookie() == null) {
            "fixture_requires_empty_accounts"
        }
        // Open the real native Room v18 builder/callback, not a fabricated SQLite header.
        // Reuse the application's container: a second container could duplicate DataStore instances.
        (context.applicationContext as WatchRssApplication).container.rssRepository.observeChannels().first()
        watchStore.save(watch())
        biliStore.write(bili())
        douyinStore.writeCookie(douyin)
        // Native Bili/Douyin writers use apply(). An empty commit drains pending disk writes.
        stores.forEach { check(context.getSharedPreferences(it, Context.MODE_PRIVATE).edit().commit()) }
        verify(context)
        check(marker.parentFile!!.mkdirs() || marker.parentFile!!.isDirectory)
        FileOutputStream(marker).use {
            it.write(JSONObject().put("fixture", "t5-synthetic-accounts-v1")
                .put("uid", Process.myUid()).toString().toByteArray(Charsets.UTF_8))
            it.fd.sync()
        }
        report("seed40")
    }

    @Test fun verifyRecovered900000() = runBlocking {
        val context = context(900000)
        val marker = JSONObject(File(context.applicationInfo.dataDir, "recovery-rehearsal/seed.json").readText())
        assertTrue("fixture_marker", marker.getString("fixture") == "t5-synthetic-accounts-v1")
        assertTrue("same_seed_uid", marker.getInt("uid") == Process.myUid())
        verify(context)
        report("recovery900000")
    }
}
