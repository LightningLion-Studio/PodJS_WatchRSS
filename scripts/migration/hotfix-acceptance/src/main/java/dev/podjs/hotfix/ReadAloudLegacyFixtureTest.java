package dev.podjs.hotfix;

import android.content.Context;
import android.os.Build;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** The published v1.2.0 writer API, used only on fresh anonymous task-owned emulator data. */
@RunWith(AndroidJUnit4.class)
public class ReadAloudLegacyFixtureTest {
 @Test public void writeHistoricalEncryptedCredentialSample()throws Exception {
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
  assertEquals("com.lightningstudio.watchrss",context.getPackageName());
  assertTrue(Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"));
  long code=context.getPackageManager().getPackageInfo(context.getPackageName(),0).getLongVersionCode();
  assertTrue("only the frozen native source APKs",code==41||code==46);
  File file=new File(context.getApplicationInfo().dataDir,"shared_prefs/read_aloud_secure_prefs.xml");assertFalse(file.exists());
  MasterKey key=new MasterKey.Builder(context.getApplicationContext()).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
  android.content.SharedPreferences prefs=EncryptedSharedPreferences.create(context.getApplicationContext(),"read_aloud_secure_prefs",key,
   EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
  String value="read-aloud-fixture-secret-v1";
  assertTrue(prefs.edit().putString("read_aloud_api_key",value).commit());
  assertEquals(value,prefs.getString("read_aloud_api_key",null));
  assertTrue(file.isFile());assertFalse(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8).contains(value));
  android.util.Log.i("TakeoverReadAloudFixture","encrypted historical sample ready; no credential contents logged");
 }
}
