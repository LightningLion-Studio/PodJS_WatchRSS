package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.app.*;
import android.content.*;
import android.graphics.*;
import android.media.AudioManager;
import android.os.*;
import android.view.*;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
/** All mutation is confined to the owned fixture; no synthetic input. */
public final class ReaderBackgroundUiTest {
 @Test public void backgroundsRenderWithStableVideoOwnershipAndNativeImageReference()throws Exception{
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();assertEquals("dev.podjs.tests.readerbackgrounds",ctx.getPackageName());prepareFiles(ctx,i.getContext());
  AudioManager audio=(AudioManager)ctx.getSystemService(Context.AUDIO_SERVICE);int volume=audio.getStreamVolume(AudioManager.STREAM_MUSIC);
  Activity activity=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try{PodRuntimeView pod=null;long end=SystemClock.uptimeMillis()+30000;while((pod=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(pod);PodRuntimeView view=pod;
   ReaderBackgroundNativeReference nativeReference=new ReaderBackgroundNativeReference(InstrumentationRegistry.getArguments().getString("nativeReferenceApk"));
   JSONObject proof=new JSONObject();Map<String,Bitmap> frames=new HashMap<>();String videoOwner=null;int videoHandle=-1;
   for(String stage:new String[]{"image-crop","image-fit","image-transform","image-blur","image-missing","video-start","video-update","video-pause","video-resume","video-nonloop","video-broken","preview-image","preview-transfer","preview-alternate","article-image"}){
    awaitStage(ctx,stage,45000);SystemClock.sleep(2500);awaitTextIdle(ctx);
    if(stage.startsWith("video-")&&!stage.equals("video-broken")){
     JSONObject s=awaitVideo(i,view,stage.equals("video-pause")?0:3);String id=s.getString("id");
     if(stage.equals("video-start")){videoOwner=id;videoHandle=s.getInt("texture");Bitmap first=bitmap(i,view);SystemClock.sleep(650);Bitmap second=bitmap(i,view);int changing=changed(first,second,0);assertTrue("video frames remain static",changing>1000);proof.put("movingVideoChangedPixels",changing);first.recycle();second.recycle();}
     else{assertEquals("appearance restarted video owner",videoOwner,id);assertEquals(videoHandle,s.getInt("texture"));}
     assertEquals(1,s.getInt("playerGeneration"));assertTrue(s.getBoolean("muted"));
     if(stage.equals("video-nonloop")){SystemClock.sleep(4500);JSONObject ended=one(i,view);assertEquals(4,ended.getInt("playbackState"));assertFalse(ended.getBoolean("loop"));proof.put("nonloopEnded",true);}
     if(stage.equals("video-update"))assertEquals(1.5,s.getDouble("speed"),.0001);
     if(stage.equals("video-pause")){long position=s.getLong("positionMs"),count=s.getLong("frames");SystemClock.sleep(700);JSONObject later=one(i,view);assertTrue(Math.abs(later.getLong("positionMs")-position)<100);assertEquals(count,later.getLong("frames"));proof.put("inactivePaused",true);}
     if(stage.equals("video-resume")){
      long count=s.getLong("frames");SystemClock.sleep(700);assertTrue(one(i,view).getLong("frames")>count);i.runOnMainSync(()->view.setLifecycle(1));SystemClock.sleep(400);JSONObject paused=one(i,view);SystemClock.sleep(650);JSONObject later=one(i,view);assertTrue(Math.abs(later.getLong("positionMs")-paused.getLong("positionMs"))<100);assertEquals(paused.getLong("frames"),later.getLong("frames"));i.runOnMainSync(()->view.setLifecycle(0));SystemClock.sleep(700);assertTrue(one(i,view).getLong("frames")>later.getLong("frames"));proof.put("lifecyclePausedAndResumed",true);
     }
     proof.put(stage,s);
    }
    Bitmap frame=bitmap(i,view);assertNotNull(frame);save(ctx,"background-"+stage+".png",frame);frames.put(stage,frame);
    if(stage.startsWith("image-")){
     JSONObject preset=result(ctx).getJSONObject("nativePreset");File image=stage.equals("image-missing")?null:new File(ctx.getFilesDir(),"podjs/files/reader_assets/variants/pattern.png");
     Bitmap expected=nativeReference.compose(i,activity,preset,image,frame.getWidth(),frame.getHeight());save(ctx,"background-native-"+stage+".png",expected);proof.put(stage+"NativeChangedPixels",changed(frame,expected,0)).put(stage+"NativeMaxChannelDelta",maximum(frame,expected));assertEquals(stage+" differs from installed native renderer",0,changed(frame,expected,0));expected.recycle();
    }
    if(stage.equals("video-broken")){JSONObject s=one(i,view);assertEquals("error",s.getString("state"));assertEquals(0,s.getLong("playerGeneration"));proof.put("brokenVideoPosterFallback",true);}
    if(stage.startsWith("preview-"))assertTrue(semantics(i,view).contains(stage.equals("preview-transfer")?"资源文件传输中":"预设实时预览"));
    if(stage.equals("article-image"))assertTrue(semantics(i,view).contains("阅读背景验证"));
    Files.write(new File(ctx.getFilesDir(),"background-ui-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
    new File(ctx.getFilesDir(),"podjs/files/background-advance-"+stage).createNewFile();
   }
   int transfer=changed(frames.get("preview-image"),frames.get("preview-transfer"),80);assertEquals("handoff changed retained image",0,transfer);assertTrue(changed(frames.get("preview-image"),frames.get("preview-alternate"),80)>10000);
   awaitStage(ctx,"done",15000);assertEquals("passed",result(ctx).getString("state"));assertTrue(result(ctx).getBoolean("presetStorageUnchanged"));assertEquals(0,states(i,view).length());assertEquals(volume,audio.getStreamVolume(AudioManager.STREAM_MUSIC));
   proof.put("result",result(ctx)).put("noSyntheticInput",true).put("transferChangedPixels",transfer).put("nativeSessionCountAfterExit",0).put("systemVolumeUnchanged",true);
   Files.write(new File(ctx.getFilesDir(),"background-ui-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));for(Bitmap frame:frames.values())frame.recycle();
  }finally{i.runOnMainSync(activity::finish);}
 }
 static void awaitTextIdle(Context ctx)throws Exception{long end=SystemClock.uptimeMillis()+15000;while(SystemClock.uptimeMillis()<end){JSONObject text=result(ctx).optJSONObject("text");if(text!=null&&text.optInt("active")==0&&text.optInt("queued")==0)return;SystemClock.sleep(100);}throw new AssertionError("Text still loading: "+result(ctx));}
 static JSONObject one(Instrumentation i,PodRuntimeView view)throws Exception{JSONArray all=states(i,view);assertEquals(all.toString(),1,all.length());return all.getJSONObject(0);}
 static JSONObject awaitVideo(Instrumentation i,PodRuntimeView view,int minimum)throws Exception{long end=SystemClock.uptimeMillis()+12000;JSONObject last=null;while(SystemClock.uptimeMillis()<end){JSONArray all=states(i,view);if(all.length()==1){last=all.getJSONObject(0);if(last.getLong("frames")>=minimum)return last;}SystemClock.sleep(200);}throw new AssertionError("Video did not produce frames: "+last);}
 static JSONArray states(Instrumentation i,PodRuntimeView view)throws Exception{JSONArray[] output={new JSONArray()};Throwable[] error={null};i.runOnMainSync(()->{try{Field a=PodRuntimeView.class.getDeclaredField("services");a.setAccessible(true);Object services=a.get(view);Field b=PodServices.class.getDeclaredField("mediaSurfaces");b.setAccessible(true);Object surface=b.get(services);Field c=PodMediaSurfaceServices.class.getDeclaredField("sessions");c.setAccessible(true);for(Object entry:((Map<?,?>)c.get(surface)).values()){PodMediaSurfaceServices.Session session=(PodMediaSurfaceServices.Session)entry;Field playerField=session.getClass().getDeclaredField("player");playerField.setAccessible(true);Object player=playerField.get(session);if(player!=null)assertEquals(0,((Number)Class.forName("androidx.media3.common.Player").getMethod("getVolume").invoke(player)).floatValue(),0);JSONObject state=session.state();if(player!=null)state.put("playbackState",((Number)Class.forName("androidx.media3.common.Player").getMethod("getPlaybackState").invoke(player)).intValue());output[0].put(state);}}catch(Throwable e){error[0]=e;}});if(error[0]!=null)throw new AssertionError(error[0]);return output[0];}
 static void prepareFiles(Context ctx,Context tests)throws Exception{File base=new File(ctx.getFilesDir(),"podjs/files/reader_assets/backgrounds"),variant=new File(ctx.getFilesDir(),"podjs/files/reader_assets/variants");assertTrue(base.mkdirs()||base.isDirectory());assertTrue(variant.mkdirs()||variant.isDirectory());
  for(boolean alt:new boolean[]{false,true}){Bitmap bitmap=Bitmap.createBitmap(200,120,Bitmap.Config.ARGB_8888);int[] pixels=new int[200*120];for(int y=0;y<120;y++)for(int x=0;x<200;x++){int r=x*255/199,g=y*255/119,b=((x/20+y/15)%2)*180+30;pixels[y*200+x]=Color.rgb(alt?255-r:r,alt?255-g:g,b);}bitmap.setPixels(pixels,0,200,0,0,200,120);String name=alt?"alternate.png":"pattern.png";saveFile(new File(base,name),bitmap);Files.copy(new File(base,name).toPath(),new File(variant,name).toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);bitmap.recycle();}
  try(InputStream in=tests.getAssets().open("background-clip.mp4")){Files.copy(in,new File(variant,"clip.mp4").toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);}Files.write(new File(variant,"broken.mp4").toPath(),new byte[]{1,2,3,4});
 }
 static void save(Context ctx,String name,Bitmap bitmap)throws Exception{saveFile(new File(ctx.getFilesDir(),name),bitmap);}
 static void saveFile(File file,Bitmap bitmap)throws Exception{try(FileOutputStream out=new FileOutputStream(file)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}}
 static int changed(Bitmap a,Bitmap b,int y0){assertEquals(a.getWidth(),b.getWidth());assertEquals(a.getHeight(),b.getHeight());int count=0;for(int y=y0;y<a.getHeight();y++)for(int x=0;x<a.getWidth();x++)if(a.getPixel(x,y)!=b.getPixel(x,y))count++;return count;}
 static int maximum(Bitmap a,Bitmap b){int delta=0;for(int y=0;y<a.getHeight();y++)for(int x=0;x<a.getWidth();x++){int p=a.getPixel(x,y),q=b.getPixel(x,y);for(int shift:new int[]{0,8,16,24})delta=Math.max(delta,Math.abs(((p>>>shift)&255)-((q>>>shift)&255)));}return delta;}
 static JSONObject result(Context ctx)throws Exception{File file=new File(ctx.getFilesDir(),"podjs/podjs-kv.json");if(!file.isFile())return new JSONObject();String text=new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8);JSONObject all=new JSONObject(text);Object value=all.opt("reader-background-result");if(value instanceof String)return new JSONObject((String)value);return value instanceof JSONObject?(JSONObject)value:new JSONObject();}
 static void awaitStage(Context ctx,String stage,long timeout)throws Exception{long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject r=result(ctx);assertNotEquals(r.toString(),"failed",r.optString("state"));if(stage.equals(r.optString("stage")))return;SystemClock.sleep(100);}throw new AssertionError("No stage "+stage+": "+result(ctx));}
 static PodRuntimeView find(View v){if(v instanceof PodRuntimeView)return (PodRuntimeView)v;if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++){PodRuntimeView found=find(((ViewGroup)v).getChildAt(i));if(found!=null)return found;}return null;}
 static Bitmap bitmap(Instrumentation i,PodRuntimeView v){Bitmap[] result={null};i.runOnMainSync(()->result[0]=v.getBitmap());return result[0];}
 static String semantics(Instrumentation i,PodRuntimeView view)throws Exception{String[] result={null};i.runOnMainSync(()->{try{Field h=PodRuntimeView.class.getDeclaredField("host");h.setAccessible(true);long host=h.getLong(view);Method enabled=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilityEnabled",long.class,boolean.class),frame=PodRuntimeView.class.getDeclaredMethod("nativeFrame",long.class),snapshot=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilitySnapshot",long.class,long[].class);enabled.setAccessible(true);frame.setAccessible(true);snapshot.setAccessible(true);Field flag=PodRuntimeView.class.getDeclaredField("accessibilityEnabled");flag.setAccessible(true);boolean original=flag.getBoolean(view);try{enabled.invoke(null,host,false);enabled.invoke(null,host,true);frame.invoke(null,host);result[0]=new String((byte[])snapshot.invoke(null,host,new long[3]),StandardCharsets.UTF_8);}finally{enabled.invoke(null,host,original);}}catch(Exception e){throw new AssertionError(e);}});return result[0];}
}
