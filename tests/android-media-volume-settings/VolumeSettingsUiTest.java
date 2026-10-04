package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.app.*;
import android.content.*;
import android.graphics.*;
import android.os.*;
import android.view.*;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
/** Production volume rows in an isolated package; captures are not a native pixel oracle. */
public final class VolumeSettingsUiTest {
 @Test public void captureProductionVolumeSettings()throws Exception {
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();assertEquals("dev.podjs.tests.volumesettings",ctx.getPackageName());
  Activity activity=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try{PodRuntimeView view=null;long end=SystemClock.uptimeMillis()+30000;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);JSONObject proof=new JSONObject();
   for(String stage:new String[]{"control-on","control-off","guard-unavailable","guard-on","guard-off","unlimited","mute","ten","hundred"}){
    awaitStage(ctx,stage,20000);SystemClock.sleep(500);
    if(stage.equals("control-on")){
     JSONObject all=new JSONObject(new String(java.nio.file.Files.readAllBytes(new File(ctx.getFilesDir(),"podjs/podjs-kv.json").toPath()),StandardCharsets.UTF_8));
     JSONArray cases=all.getJSONArray("volume-settings-policy");Class<?> policy=new dalvik.system.PathClassLoader(InstrumentationRegistry.getArguments().getString("nativeReferenceApk"),ClassLoader.getSystemClassLoader()).loadClass("com.lightningstudio.watchrss.data.settings.MediaPlaybackStartVolumeLimitKt");
     for(int c=0;c<cases.length();c++){JSONObject item=cases.getJSONObject(c);Integer value=item.isNull("value")?null:item.getInt("value");
      for(String key:new String[]{"previous","next","formatted"}){String method=key.equals("formatted")?"formatMediaPlaybackStartVolumeLimitPercent":key+"MediaPlaybackStartVolumeLimitPercent";Object actual=policy.getMethod(method,Integer.class).invoke(null,value);assertEquals(item.toString(),actual,item.isNull(key)?null:item.get(key));}
     }proof.put("nativePolicyCases",cases);
    }Bitmap frame=bitmap(i,view);assertNotNull(frame);
    try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"volume-"+stage+".png"))){assertTrue(frame.compress(Bitmap.CompressFormat.PNG,100,out));}
    proof.put(stage,result(ctx));frame.recycle();new File(ctx.getFilesDir(),"podjs/files/volume-advance-"+stage).createNewFile();
   }
   awaitStage(ctx,"done",15000);proof.put("result",result(ctx)).put("noSyntheticInput",true).put("passed",true);assertEquals("passed",result(ctx).getString("state"));try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"volume-ui-proof.json"))){out.write(proof.toString().getBytes(StandardCharsets.UTF_8));}
  }finally{i.runOnMainSync(activity::finish);}
 }
 private static JSONObject result(Context ctx)throws Exception{File file=new File(ctx.getFilesDir(),"podjs/podjs-kv.json");if(!file.isFile())return new JSONObject();return new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)).optJSONObject("volume-settings-result");}
 private static void awaitStage(Context ctx,String stage,long timeout)throws Exception{long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject r=result(ctx);if(r!=null){assertNotEquals(r.toString(),"failed",r.optString("state"));if(stage.equals(r.optString("stage")))return;}SystemClock.sleep(100);}throw new AssertionError("No stage "+stage+": "+result(ctx));}
 private static PodRuntimeView find(View view){if(view instanceof PodRuntimeView)return (PodRuntimeView)view;if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int j=0;j<group.getChildCount();j++){PodRuntimeView found=find(group.getChildAt(j));if(found!=null)return found;}}return null;}
 private static Bitmap bitmap(Instrumentation i,TextureView view){Bitmap[] value=new Bitmap[1];i.runOnMainSync(()->value[0]=view.getBitmap());return value[0];}
 private static boolean awake(Instrumentation i,Activity a){boolean[] value=new boolean[1];i.runOnMainSync(()->value[0]=(a.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)!=0);return value[0];}
 private static String semantics(Instrumentation i,PodRuntimeView view)throws Exception{String[] result=new String[1];i.runOnMainSync(()->{try{Field h=PodRuntimeView.class.getDeclaredField("host");h.setAccessible(true);long host=h.getLong(view);assertTrue(host!=0);Method enabled=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilityEnabled",long.class,boolean.class),frame=PodRuntimeView.class.getDeclaredMethod("nativeFrame",long.class),snapshot=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilitySnapshot",long.class,long[].class);enabled.setAccessible(true);frame.setAccessible(true);snapshot.setAccessible(true);Field flag=PodRuntimeView.class.getDeclaredField("accessibilityEnabled");flag.setAccessible(true);boolean original=flag.getBoolean(view);try{enabled.invoke(null,host,false);enabled.invoke(null,host,true);frame.invoke(null,host);byte[] bytes=(byte[])snapshot.invoke(null,host,new long[3]);assertNotNull(bytes);result[0]=new String(bytes,StandardCharsets.UTF_8);}finally{enabled.invoke(null,host,original);}}catch(Exception e){throw new AssertionError(e);}});return result[0];}
}
