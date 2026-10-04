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

/** Captures the production saved-list surface without injecting input. */
public final class SavedListUiTest {
    @Test public void captureSavedList() throws Exception {
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Context context=instrumentation.getTargetContext();
        assertEquals("dev.podjs.tests.savedlist",context.getPackageName());
        Activity activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            PodRuntimeView view=null;long deadline=SystemClock.uptimeMillis()+20000;
            while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<deadline)SystemClock.sleep(100);
            assertNotNull(view);
            PodRuntimeView renderer=view;Bitmap[] frame=new Bitmap[1];
            long renderDeadline=SystemClock.uptimeMillis()+12000;
            do {
                if(frame[0]!=null)frame[0].recycle();
                instrumentation.runOnMainSync(()->frame[0]=renderer.getBitmap());
                if(frame[0]!=null&&hasInk(frame[0],40,160))break;
                SystemClock.sleep(200);
            } while(SystemClock.uptimeMillis()<renderDeadline);
            assertNotNull(frame[0]);assertEquals(466,frame[0].getWidth());assertEquals(466,frame[0].getHeight());
            assertTrue("saved list header never rendered",hasInk(frame[0],40,160));
            try(FileOutputStream out=new FileOutputStream(new File(context.getExternalFilesDir(null),"podjs-saved-list.png"))){assertTrue(frame[0].compress(Bitmap.CompressFormat.PNG,100,out));}
            frame[0].recycle();
        }finally{instrumentation.runOnMainSync(activity::finish);}
    }
    private static boolean hasInk(Bitmap bitmap,int top,int bottom){
        for(int y=top;y<bottom;y+=4)for(int x=40;x<bitmap.getWidth()-40;x+=4){
            int pixel=bitmap.getPixel(x,y);
            if(((pixel>>16)&255)>75&&((pixel>>8)&255)>75&&(pixel&255)>75)return true;
        }
        return false;
    }
    private static PodRuntimeView find(View view){
        if(view instanceof PodRuntimeView)return (PodRuntimeView)view;
        if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int i=0;i<group.getChildCount();i++){PodRuntimeView found=find(group.getChildAt(i));if(found!=null)return found;}}
        return null;
    }
}
