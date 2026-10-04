package dev.podjs.androidwatch;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.platform.app.InstrumentationRegistry;
import dev.podjs.runtime.PodRuntimeView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import org.json.JSONObject;
import org.junit.Test;

/** Static sampled-image fixture; no touch or gesture input is generated. */
public final class VeryLargeImageUiTest {
    @Test public void captureSampledFitPreview() throws Exception {
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Context context=instrumentation.getTargetContext();
        assertEquals("dev.podjs.tests.verylargeimage",context.getPackageName());
        File source=new File(context.getFilesDir(),"podjs/files/very-large.jpg");
        assertTrue(source.getParentFile().exists()||source.getParentFile().mkdirs());
        int width=4096,height=2048;int[] colors=new int[width*height];
        for(int y=0;y<height;y++)for(int x=0;x<width;x++)colors[y*width+x]=0xff000000|(((x*17+y*3)&255)<<16)|(((x*5+y*11)&255)<<8)|((x*7+y*13)&255);
        Bitmap fixture=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);
        fixture.setPixels(colors,0,width,0,0,width,height);
        try(FileOutputStream out=new FileOutputStream(source)){assertTrue(fixture.compress(Bitmap.CompressFormat.JPEG,95,out));}finally{fixture.recycle();}
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(source.toPath()));
        StringBuilder sha=new StringBuilder();for(byte value:digest)sha.append(String.format(java.util.Locale.ROOT,"%02x",value&255));
        Files.write(new File(context.getExternalFilesDir(null),"podjs-very-large-source.sha256").toPath(),(sha+"\n").getBytes(StandardCharsets.UTF_8));
        Files.deleteIfExists(new File(context.getFilesDir(),"podjs/podjs-kv.json").toPath());
        Activity activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            PodRuntimeView view=null;long deadline=SystemClock.uptimeMillis()+60000;
            while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<deadline)SystemClock.sleep(100);
            assertNotNull("PodJS view missing",view);
            while(SystemClock.uptimeMillis()<deadline){
                JSONObject result=state(context);
                assertNotEquals("image decode failed: "+result,"failed",result.optString("state"));
                if(result.optString("state").equals("tiles-ready")){assertEquals(width,result.getInt("width"));assertEquals(height,result.getInt("height"));break;}
                SystemClock.sleep(100);
            }
            assertEquals("tiles-ready",state(context).optString("state"));
            Files.write(new File(context.getExternalFilesDir(null),"podjs-very-large-timing.json").toPath(),state(context).toString().getBytes(StandardCharsets.UTF_8));
            SystemClock.sleep(200);
            PodRuntimeView texture=view;Bitmap[] frame=new Bitmap[1];
            instrumentation.runOnMainSync(()->frame[0]=texture.getBitmap());
            assertNotNull("renderer frame unavailable",frame[0]);
            assertEquals(466,frame[0].getWidth());assertEquals(466,frame[0].getHeight());
            try(FileOutputStream out=new FileOutputStream(new File(context.getExternalFilesDir(null),"podjs-very-large-fit.png"))){assertTrue(frame[0].compress(Bitmap.CompressFormat.PNG,100,out));}
            frame[0].recycle();
        }finally{instrumentation.runOnMainSync(activity::finish);source.delete();}
    }

    private static JSONObject state(Context context) throws Exception {
        File file=new File(context.getFilesDir(),"podjs/podjs-kv.json");if(!file.isFile())return new JSONObject();
        JSONObject root=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
        JSONObject result=root.optJSONObject("very-large-image-result");return result==null?new JSONObject():result;
    }
    private static PodRuntimeView find(View view){
        if(view instanceof PodRuntimeView)return (PodRuntimeView)view;
        if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int i=0;i<group.getChildCount();i++){PodRuntimeView found=find(group.getChildAt(i));if(found!=null)return found;}}
        return null;
    }
}
