package dev.podjs.androidwatch;
import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.view.*;
import android.widget.ImageView;
import androidx.test.platform.app.InstrumentationRegistry;
import dev.podjs.runtime.*;
import org.json.JSONObject;
import org.junit.Test;
import java.lang.reflect.Field;
import java.util.concurrent.*;
import static org.junit.Assert.*;
public final class PlayerBackdropTest {
 private Object field(Object o,String name)throws Exception{Field f=o.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(o);}
 private PodRuntimeView find(View v){if(v instanceof PodRuntimeView)return (PodRuntimeView)v;if(v instanceof ViewGroup)for(int n=0;n<((ViewGroup)v).getChildCount();n++){PodRuntimeView p=find(((ViewGroup)v).getChildAt(n));if(p!=null)return p;}return null;}
 private void call(PodVideoServices service,String method)throws Exception{CountDownLatch latch=new CountDownLatch(1);String[] error={null};service.dispatch(method,new JSONObject(),new PodVideoServices.Callback(){public void complete(JSONObject r){latch.countDown();}public void fail(String c,String m){error[0]=c+":"+m;latch.countDown();}});assertTrue(method,latch.await(8,TimeUnit.SECONDS));assertNull(error[0]);}
 @Test public void captureReplacesAndRecyclesSingleBackdrop()throws Exception{
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();Activity a=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try{Thread.sleep(1800);PodRuntimeView view=find(a.getWindow().getDecorView());assertNotNull(view);PodVideoServices service=(PodVideoServices)field(field(view,"services"),"video");
   call(service,"video.captureBackdrop");Bitmap first=(Bitmap)field(service,"backdropBitmap");assertNotNull(first);assertFalse(first.isRecycled());assertEquals(view.getWidth(),first.getWidth());
   call(service,"video.captureBackdrop");Bitmap second=(Bitmap)field(service,"backdropBitmap");assertTrue(first.isRecycled());assertNotNull(second);assertNotSame(first,second);assertFalse(second.isRecycled());
   ImageView bg=(ImageView)field(service,"backdrop");ViewGroup parent=(ViewGroup)view.getParent();assertTrue(parent.indexOfChild(bg)<parent.indexOfChild(view));
   call(service,"video.stop");assertTrue(second.isRecycled());assertNull(field(service,"backdropBitmap"));
  }finally{i.runOnMainSync(a::finish);}
 }
}
