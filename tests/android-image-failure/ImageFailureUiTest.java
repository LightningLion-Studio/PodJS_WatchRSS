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
import org.junit.Test;

/** Static missing-local-image state; does not generate touch input. */
public final class ImageFailureUiTest {
    @Test public void captureMissingLocalImage() throws Exception {
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Context context=instrumentation.getTargetContext();
        assertEquals("dev.podjs.tests.imagefailure",context.getPackageName());
        File source=new File(context.getFilesDir(),"podjs/files/missing-local-image-preview.jpg");
        assertFalse(source.exists());
        Activity activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            PodRuntimeView view=null;long deadline=SystemClock.uptimeMillis()+20000;
            while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<deadline)SystemClock.sleep(100);
            assertNotNull(view);
            SystemClock.sleep(2000);
            PodRuntimeView renderer=view;Bitmap[] frame=new Bitmap[1];
            instrumentation.runOnMainSync(()->frame[0]=renderer.getBitmap());
            assertNotNull(frame[0]);assertEquals(466,frame[0].getWidth());assertEquals(466,frame[0].getHeight());
            try(FileOutputStream out=new FileOutputStream(new File(context.getExternalFilesDir(null),"podjs-image-preview-missing-local.png"))){assertTrue(frame[0].compress(Bitmap.CompressFormat.PNG,100,out));}
            frame[0].recycle();
        }finally{instrumentation.runOnMainSync(activity::finish);}
    }
    private static PodRuntimeView find(View view){
        if(view instanceof PodRuntimeView)return (PodRuntimeView)view;
        if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int i=0;i<group.getChildCount();i++){PodRuntimeView found=find(group.getChildAt(i));if(found!=null)return found;}}
        return null;
    }
}
