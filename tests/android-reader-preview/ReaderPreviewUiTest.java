package dev.podjs.androidwatch;
import static org.junit.Assert.*;
import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.os.*;
import android.view.*;
import androidx.test.platform.app.InstrumentationRegistry;
import dev.podjs.runtime.PodRuntimeView;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
/** Owned fixture only. Observes actual UI and frames without synthesizing input. */
public final class ReaderPreviewUiTest {
 @Test public void previewPublishesFreezesStopsAndExpiresWithoutSaving()throws Exception {
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();assertEquals("dev.podjs.tests.readerpreview",ctx.getPackageName());
  Activity activity=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try{PodRuntimeView view=null;long end=SystemClock.uptimeMillis()+30000;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);PodRuntimeView texture=view;
   Bitmap delta=null;JSONObject proof=new JSONObject();
   for(String stage:new String[]{"full","delta","transfer","switched","stopped","before-expiry"}){
    awaitStage(ctx,stage,45000);SystemClock.sleep(1800);String nodes=semantics(i,texture);boolean showing=!stage.equals("stopped");assertEquals(stage+" label",showing,nodes.contains(stage.equals("transfer")?"资源文件传输中":"预设实时预览"));assertEquals(stage+" awake",showing,awake(i,activity));
    Bitmap frame=bitmap(i,texture);assertNotNull(frame);try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"preview-"+stage+".png"))){assertTrue(frame.compress(Bitmap.CompressFormat.PNG,100,out));}
    if(stage.equals("delta"))delta=frame.copy(Bitmap.Config.ARGB_8888,false);
    if(stage.equals("transfer")){assertNotNull(delta);int changed=0,total=0;for(int y=80;y<frame.getHeight();y++)for(int x=0;x<frame.getWidth();x++){total++;if(frame.getPixel(x,y)!=delta.getPixel(x,y))changed++;}proof.put("transferChangedPixels",changed).put("transferComparedPixels",total);assertTrue("transfer changed content: "+changed+"/"+total,changed<total*.005);delta.recycle();}
    frame.recycle();new File(ctx.getFilesDir(),"podjs/files/preview-advance-"+stage).createNewFile();
   }
   awaitStage(ctx,"expired",35000);SystemClock.sleep(600);assertFalse(semantics(i,texture).contains("预设实时预览"));assertFalse(awake(i,activity));JSONObject result=result(ctx);assertEquals("passed",result.getString("state"));assertTrue(result.getBoolean("presetsUnchanged"));proof.put("result",result).put("noSyntheticInput",true).put("keepAwakeReleased",true);
   try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"preview-ui-proof.json"))){out.write(proof.toString().getBytes(StandardCharsets.UTF_8));}
  }finally{i.runOnMainSync(activity::finish);}
 }
 private static JSONObject result(Context ctx)throws Exception{File file=new File(ctx.getFilesDir(),"podjs/podjs-kv.json");if(!file.isFile())return new JSONObject();return new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)).optJSONObject("reader-preview-result");}
 private static void awaitStage(Context ctx,String stage,long timeout)throws Exception{long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject r=result(ctx);if(r!=null){assertNotEquals(r.toString(),"failed",r.optString("state"));if(stage.equals(r.optString("stage")))return;}SystemClock.sleep(100);}throw new AssertionError("No stage "+stage+": "+result(ctx));}
 private static PodRuntimeView find(View view){if(view instanceof PodRuntimeView)return (PodRuntimeView)view;if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int j=0;j<group.getChildCount();j++){PodRuntimeView found=find(group.getChildAt(j));if(found!=null)return found;}}return null;}
 private static Bitmap bitmap(Instrumentation i,TextureView view){Bitmap[] value=new Bitmap[1];i.runOnMainSync(()->value[0]=view.getBitmap());return value[0];}
 private static boolean awake(Instrumentation i,Activity a){boolean[] value=new boolean[1];i.runOnMainSync(()->value[0]=(a.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)!=0);return value[0];}
 private static String semantics(Instrumentation i,PodRuntimeView view)throws Exception{String[] result=new String[1];i.runOnMainSync(()->{try{Field h=PodRuntimeView.class.getDeclaredField("host");h.setAccessible(true);long host=h.getLong(view);assertTrue(host!=0);Method enabled=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilityEnabled",long.class,boolean.class),frame=PodRuntimeView.class.getDeclaredMethod("nativeFrame",long.class),snapshot=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilitySnapshot",long.class,long[].class);enabled.setAccessible(true);frame.setAccessible(true);snapshot.setAccessible(true);Field flag=PodRuntimeView.class.getDeclaredField("accessibilityEnabled");flag.setAccessible(true);boolean original=flag.getBoolean(view);try{enabled.invoke(null,host,false);enabled.invoke(null,host,true);frame.invoke(null,host);byte[] bytes=(byte[])snapshot.invoke(null,host,new long[3]);assertNotNull(bytes);result[0]=new String(bytes,StandardCharsets.UTF_8);}finally{enabled.invoke(null,host,original);}}catch(Exception e){throw new AssertionError(e);}});return result[0];}
}
