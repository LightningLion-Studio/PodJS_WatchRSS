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
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

/** Captures the production add-RSS input surface without injecting input. */
public final class AddRssUiTest {
    @Test public void captureInput() throws Exception {
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Context context=instrumentation.getTargetContext();
        assertEquals("dev.podjs.tests.addrss",context.getPackageName());
        Activity activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            PodRuntimeView view=null;long deadline=SystemClock.uptimeMillis()+20000;
            while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<deadline)SystemClock.sleep(100);
            assertNotNull(view);SystemClock.sleep(1500);
            PodRuntimeView renderer=view;Bitmap[] frame=new Bitmap[1];
            instrumentation.runOnMainSync(()->frame[0]=renderer.getBitmap());
            assertNotNull(frame[0]);assertEquals(466,frame[0].getWidth());assertEquals(466,frame[0].getHeight());
            try(FileOutputStream out=new FileOutputStream(new File(context.getExternalFilesDir(null),"podjs-add-rss-input.png"))){assertTrue(frame[0].compress(Bitmap.CompressFormat.PNG,100,out));}
            frame[0].recycle();
            byte[] semantics=semanticSnapshot(instrumentation,renderer);
            try(FileOutputStream out=new FileOutputStream(new File(context.getExternalFilesDir(null),"podjs-add-rss-input-semantics.json"))){out.write(semantics);}
        }finally{instrumentation.runOnMainSync(activity::finish);}
    }
    private static PodRuntimeView find(View view){
        if(view instanceof PodRuntimeView)return (PodRuntimeView)view;
        if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int i=0;i<group.getChildCount();i++){PodRuntimeView found=find(group.getChildAt(i));if(found!=null)return found;}}
        return null;
    }
    private static byte[] semanticSnapshot(Instrumentation instrumentation,PodRuntimeView view) throws Exception {
        Field hostField=PodRuntimeView.class.getDeclaredField("host");hostField.setAccessible(true);
        Field enabledField=PodRuntimeView.class.getDeclaredField("accessibilityEnabled");enabledField.setAccessible(true);
        java.lang.reflect.Method enable=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilityEnabled",long.class,boolean.class);
        java.lang.reflect.Method frame=PodRuntimeView.class.getDeclaredMethod("nativeFrame",long.class);
        java.lang.reflect.Method snapshot=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilitySnapshot",long.class,long[].class);
        enable.setAccessible(true);frame.setAccessible(true);snapshot.setAccessible(true);
        byte[][] result=new byte[1][];
        instrumentation.runOnMainSync(()->{try {
            long host=hostField.getLong(view);boolean original=enabledField.getBoolean(view);
            try {enable.invoke(null,host,false);enable.invoke(null,host,true);frame.invoke(null,host);result[0]=(byte[])snapshot.invoke(null,host,new long[3]);}
            finally {enable.invoke(null,host,original);}
        }catch(Exception error){throw new AssertionError(error);}});
        assertNotNull(result[0]);new org.json.JSONObject(new String(result[0],StandardCharsets.UTF_8));return result[0];
    }
}
