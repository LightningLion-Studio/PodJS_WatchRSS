package dev.podjs.androidwatch;

import androidx.test.platform.app.InstrumentationRegistry;
import android.content.Context;
import dev.podjs.runtime.PodMediaServices;
import org.json.JSONObject;
import org.junit.Test;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

/** Readiness probe against the installed engine. It never sends tts.speak or changes system settings. */
public class SpeechEngineAvailabilityTest {
    @Test public void recordsActualLocalEngineReadinessWithoutSpeaking() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.lightningstudio.watchrss.podjs",context.getPackageName());
        PodMediaServices service=new PodMediaServices(context);
        CountDownLatch done=new CountDownLatch(1);JSONObject[] result=new JSONObject[1];
        try {
            service.dispatch("tts.init",new JSONObject().put("preferredOfflineLanguages",new org.json.JSONArray().put("zh-CN").put("zh").put("en")),new PodMediaServices.Callback(){
                public void complete(JSONObject value){result[0]=value;done.countDown();}
                public void fail(String code,String message){try{result[0]=new JSONObject().put("ok",false).put("code",code).put("message",message);}catch(Exception e){throw new AssertionError(e);}finally{done.countDown();}}
            });
            assertTrue("TTS initialization did not settle",done.await(30,TimeUnit.SECONDS));
            assertNotNull(result[0]);
            if(result[0].optBoolean("ok"))assertEquals("ready",result[0].getString("state"));
            else assertTrue("unexpected readiness failure",result[0].getString("code").startsWith("tts_"));
            result[0].put("speechRequested",false).put("realAudioVerified",false);
            java.nio.file.Files.write(new File(context.getFilesDir(),"watchrss-speech-engine-readiness.json").toPath(),result[0].toString().getBytes(StandardCharsets.UTF_8));
        } finally {service.close();}
    }
}
