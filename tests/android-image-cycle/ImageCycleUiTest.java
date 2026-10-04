package dev.podjs.androidwatch;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Debug;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.platform.app.InstrumentationRegistry;
import dev.podjs.runtime.PodRuntimeView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Repeated image mounting is driven by fixture state, without touch input. */
public final class ImageCycleUiTest {
    @Test public void verifyRepeatedImageCleanup() throws Exception {
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Context context=instrumentation.getTargetContext();
        assertEquals("dev.podjs.tests.imagecycle",context.getPackageName());
        File root=new File(context.getFilesDir(),"podjs/files");assertTrue(root.exists()||root.mkdirs());
        File small=new File(root,"image-cycle-small.jpg"),large=new File(root,"image-cycle-large.jpg");
        createJpeg(small,2053,1027);createJpeg(large,4096,3072);
        Files.deleteIfExists(new File(context.getFilesDir(),"podjs/podjs-kv.json").toPath());
        Activity activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        JSONArray samples=new JSONArray();
        try {
            for(int cycle=0;cycle<6;cycle++){
                await(context,"ready",cycle,45000);
                JSONObject visible=sample(context,activity,cycle,"ready");samples.put(visible);
                await(context,"idle",cycle,15000);
                System.gc();SystemClock.sleep(250);
                JSONObject idle=sample(context,activity,cycle,"idle");samples.put(idle);
                assertEquals("decoded files after unmount at cycle "+cycle,0,idle.getInt("decodedFiles"));
            }
            await(context,"passed",5,10000);
            JSONObject report=new JSONObject().put("state","passed").put("samples",samples);
            Files.write(new File(context.getExternalFilesDir(null),"image-cycle-memory.json").toPath(),report.toString(2).getBytes(StandardCharsets.UTF_8));
        }finally{instrumentation.runOnMainSync(activity::finish);small.delete();large.delete();}
    }
    private static JSONObject await(Context context,String expected,int cycle,long timeoutMs) throws Exception {
        long deadline=SystemClock.uptimeMillis()+timeoutMs;
        while(SystemClock.uptimeMillis()<deadline){
            JSONObject state=state(context);if("failed".equals(state.optString("state")))fail("image cycle: "+state);
            if(expected.equals(state.optString("state"))&&state.optInt("index",-1)==cycle)return state;
            if("passed".equals(expected)&&"passed".equals(state.optString("state")))return state;
            SystemClock.sleep(50);
        }
        fail("timeout waiting for "+expected+" cycle "+cycle+": "+state(context));return new JSONObject();
    }
    private static JSONObject state(Context context) throws Exception {
        File file=new File(context.getFilesDir(),"podjs/podjs-kv.json");if(!file.isFile())return new JSONObject();
        JSONObject root=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
        JSONObject state=root.optJSONObject("image-cycle-result");return state==null?new JSONObject():state;
    }
    private static JSONObject sample(Context context,Activity activity,int cycle,String phase) throws Exception {
        Debug.MemoryInfo memory=new Debug.MemoryInfo();Debug.getMemoryInfo(memory);
        File images=new File(context.getFilesDir(),"podjs/files/images");
        File[] temporary=images.listFiles((dir,name)->name.startsWith("decoded-")&&name.endsWith(".rgba"));
        PodRuntimeView view=find(activity.getWindow().getDecorView());assertNotNull(view);
        java.lang.reflect.Field servicesField=PodRuntimeView.class.getDeclaredField("services");servicesField.setAccessible(true);
        Object services=servicesField.get(view);
        java.lang.reflect.Field imagesField=services.getClass().getDeclaredField("images");imagesField.setAccessible(true);
        Object imageService=imagesField.get(services);
        java.lang.reflect.Field epochField=imageService.getClass().getDeclaredField("decoderEpoch");epochField.setAccessible(true);
        java.lang.reflect.Field idleField=imageService.getClass().getDeclaredField("idleDecoders");idleField.setAccessible(true);
        return new JSONObject().put("cycle",cycle).put("phase",phase).put("pssKiB",memory.getTotalPss())
            .put("nativeHeapBytes",Debug.getNativeHeapAllocatedSize())
            .put("decodedFiles",temporary==null?0:temporary.length)
            .put("decoderEpoch",epochField.getLong(imageService))
            .put("idleDecoders",((java.util.ArrayDeque<?>)idleField.get(imageService)).size());
    }
    private static PodRuntimeView find(View view){
        if(view instanceof PodRuntimeView)return (PodRuntimeView)view;
        if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int i=0;i<group.getChildCount();i++){PodRuntimeView found=find(group.getChildAt(i));if(found!=null)return found;}}
        return null;
    }
    private static void createJpeg(File source,int width,int height) throws Exception {
        Bitmap bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);int[] row=new int[width];
        for(int y=0;y<height;y++){for(int x=0;x<width;x++)row[x]=Color.rgb((x*17+y*3)&255,(x*5+y*11)&255,(x*7+y*13)&255);bitmap.setPixels(row,0,width,0,y,width,1);}
        try(FileOutputStream out=new FileOutputStream(source)){assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG,95,out));}finally{bitmap.recycle();}
    }
}
