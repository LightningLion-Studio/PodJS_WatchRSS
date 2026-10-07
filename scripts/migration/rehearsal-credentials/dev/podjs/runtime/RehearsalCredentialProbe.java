package dev.podjs.runtime;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.os.Process;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.file.Files;
import java.util.Properties;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.assertTrue;

/** Read-only app-specific probe, supplied via podTestSourceDir. No key creation/repair. */
public final class RehearsalCredentialProbe {
    @Test public void migratedCredentialsMatchNativeSeed() throws Exception {
        Context c = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue("isolated_package", "com.lightningstudio.watchrss.podjs.rehearsal".equals(c.getPackageName()));
        assertTrue("debug_only", (c.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        assertTrue("podjs1000", c.getPackageManager().getPackageInfo(c.getPackageName(), 0).getLongVersionCode() == 1000);
        assertTrue("active", "ACTIVE".equals(PodTakeover.status(c).getString("phase")));
        Properties active = new Properties();
        try (java.io.FileInputStream in = new java.io.FileInputStream(new File(c.getFilesDir(), "package-takeover/active"))) { active.load(in); }
        String generation = active.getProperty("generation");
        assertTrue("generation", generation != null && generation.matches("[A-Za-z0-9_-]+"));
        File backup = new File(c.getFilesDir(), ".podjs-takeover-backup/" + generation + "/data");
        File marker = new File(backup, "files/recovery-rehearsal/seed.json");
        JSONObject seed = new JSONObject(new String(Files.readAllBytes(marker.toPath()), java.nio.charset.StandardCharsets.UTF_8));
        assertTrue("fixture_marker", "t5-synthetic-accounts-v1".equals(seed.getString("fixture")));
        assertTrue("same_seed_uid", seed.getInt("uid") == Process.myUid());
        String[] names = {"watchrss_account_state", "bili_account_store", "douyin_account_store"};
        byte[][] before = new byte[names.length][];
        for (int i = 0; i < names.length; i++) before[i] = Files.readAllBytes(new File(backup, "shared_prefs/" + names[i] + ".xml").toPath());
        java.security.KeyStore keys = java.security.KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        assertTrue("native_master_present", keys.containsAlias("_androidx_security_master_key_"));
        assertTrue("podjs_target_present", keys.containsAlias("podjs.secure.v1"));
        try (PodDeviceServices services = new PodDeviceServices(c)) {
            JSONObject watch = new JSONObject(get(services, "state_json"));
            assertTrue("watch_matches", "t5-rehearsal-user".equals(watch.getString("userId"))
                && "t5-fake-watch-access".equals(watch.getString("watchAccessToken"))
                && "t5-fake-watch-refresh".equals(watch.getString("watchRefreshToken")));
            JSONObject bili = new JSONObject(get(services, "watchrss.bili.session.v1"));
            assertTrue("bili_matches", "t5-fake-bili-session".equals(bili.getJSONObject("cookies").getString("SESSDATA"))
                && "t5-fake-bili-csrf".equals(bili.getJSONObject("cookies").getString("bili_jct"))
                && "t5-fake-bili-refresh".equals(bili.getString("refreshToken")));
            assertTrue("douyin_matches", "sessionid=t5-fake-douyin-session; csrf_session_id=t5-fake-douyin-csrf".equals(get(services, "douyin.cookie")));
        }
        for (int i = 0; i < names.length; i++) assertTrue("backup_ciphertext_unchanged", java.util.Arrays.equals(before[i], Files.readAllBytes(new File(backup, "shared_prefs/" + names[i] + ".xml").toPath())));
        Bundle report = new Bundle(); report.putString("stage", "podjs1000"); report.putInt("uid", Process.myUid());
        report.putBoolean("watchMatches", true); report.putBoolean("biliMatches", true); report.putBoolean("douyinMatches", true);
        InstrumentationRegistry.getInstrumentation().sendStatus(0, report);
    }

    private static String get(PodDeviceServices services, String key) throws Exception {
        JSONObject result = services.execute("secure.get", new JSONObject().put("key", key));
        assertTrue("secure_value_present", result.getBoolean("exists"));
        return result.getString("value");
    }
}
