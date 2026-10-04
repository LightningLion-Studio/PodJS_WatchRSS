package dev.podjs.androidwatch;

import android.util.Base64;
import androidx.test.platform.app.InstrumentationRegistry;
import dev.podjs.runtime.PodDeviceServices;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPOutputStream;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public final class GzipBytesTest {
 @Test public void smallBodyMatchesAndroidGzipAndRejectsOversize() throws Exception {
  byte[] plain=("第一章正文😀"+"字".repeat(4000)).getBytes(StandardCharsets.UTF_8);
  ByteArrayOutputStream expected=new ByteArrayOutputStream();
  try(GZIPOutputStream zipped=new GZIPOutputStream(expected)){zipped.write(plain);}
  try(PodDeviceServices host=new PodDeviceServices(InstrumentationRegistry.getInstrumentation().getTargetContext())){
   String encoded=Base64.encodeToString(plain,Base64.NO_WRAP);
   JSONObject result=host.execute("file.gzipBytes",new JSONObject().put("dataBase64",encoded));
   assertArrayEquals(expected.toByteArray(),Base64.decode(result.getString("dataBase64"),Base64.DEFAULT));
   byte[] tooLarge=new byte[65537];
   try {host.execute("file.gzipBytes",new JSONObject().put("dataBase64",Base64.encodeToString(tooLarge,Base64.NO_WRAP)));fail("oversize accepted");}
   catch(IllegalArgumentException expectedFailure){assertEquals("gzip_input_too_large",expectedFailure.getMessage());}
  }
 }
}
