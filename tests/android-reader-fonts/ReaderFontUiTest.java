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
public final class ReaderFontUiTest {
 @Test public void customReaderAndPreviewFontsRenderAndRelease()throws Exception {
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();assertEquals("dev.podjs.tests.readerfonts",ctx.getPackageName());
  File fontRoot=new File(ctx.getFilesDir(),"podjs/files/reader_assets/fonts");assertTrue(fontRoot.mkdirs()||fontRoot.isDirectory());
  java.nio.file.Files.copy(new File("/system/fonts/NotoSerifCJK-Regular.ttc").toPath(),new File(fontRoot,"serif.ttc").toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
  java.nio.file.Files.copy(new File("/system/fonts/NotoSansCJK-Regular.ttc").toPath(),new File(fontRoot,"sans.ttc").toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
  Activity activity=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try{PodRuntimeView view=null;long end=SystemClock.uptimeMillis()+30000;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);PodRuntimeView texture=view;
   java.util.Map<String,Bitmap> frames=new java.util.HashMap<>();JSONObject proof=new JSONObject();
   for(String stage:new String[]{"preview-system","preview-serif","preview-transfer","preview-sans","preview-stopped","article-serif","article-system","article-missing"}){
    awaitStage(ctx,stage,45000);SystemClock.sleep(3000);String nodes=semantics(i,texture);boolean preview=stage.startsWith("preview-")&&!stage.equals("preview-stopped");
    if(preview)assertTrue(stage+" label",nodes.contains(stage.equals("preview-transfer")?"资源文件传输中":"预设实时预览"));
    if(stage.startsWith("article-"))assertTrue(stage+" title",nodes.contains("阅读字体的形状变化")||nodes.contains("阅读字体"));
    Bitmap frame=bitmap(i,texture);assertNotNull(frame);try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"font-"+stage+".png"))){assertTrue(frame.compress(Bitmap.CompressFormat.PNG,100,out));}frames.put(stage,frame);
    if(stage.equals("preview-system")||stage.equals("preview-serif")){JSONObject state=result(ctx);Bitmap nativeFrame=dev.podjs.runtime.ReaderNativePreviewReference.render(ctx,InstrumentationRegistry.getArguments().getString("nativeReferenceApk"),state.getJSONObject("nativePreset"),frame.getWidth(),frame.getHeight(),(float)(frame.getWidth()/state.getDouble("logicalWidth")));try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"font-native-"+stage+".png"))){assertTrue(nativeFrame.compress(Bitmap.CompressFormat.PNG,100,out));}int nativeChanged=changed(frame,nativeFrame);proof.put(stage+"NativeChangedPixels",nativeChanged);assertEquals(stage+" native preview paragraph pixels",0,nativeChanged);nativeFrame.recycle();}

    new File(ctx.getFilesDir(),"podjs/files/font-advance-"+stage).createNewFile();
   }
   int previewChanged=changed(frames.get("preview-system"),frames.get("preview-serif")),articleChanged=changed(frames.get("article-system"),frames.get("article-serif"));
   int transferChanged=changed(frames.get("preview-serif"),frames.get("preview-transfer")),fallbackChanged=changed(frames.get("article-system"),frames.get("article-missing"));
   assertTrue("custom preview font has no visible effect",previewChanged>1500);assertTrue("custom article font has no visible effect",articleChanged>1500);assertEquals("handoff altered the previous font",0,transferChanged);assertEquals("missing custom font differs from system fallback",0,fallbackChanged);
   awaitStage(ctx,"done",15000);assertFalse(awake(i,activity));JSONObject result=result(ctx);assertEquals("passed",result.getString("state"));assertTrue(result.getBoolean("presetStorageUnchanged"));proof.put("result",result).put("noSyntheticInput",true).put("previewChangedPixels",previewChanged).put("articleChangedPixels",articleChanged).put("transferChangedPixels",transferChanged).put("missingFontChangedPixels",fallbackChanged);
   try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"font-ui-proof.json"))){out.write(proof.toString().getBytes(StandardCharsets.UTF_8));}for(Bitmap frame:frames.values())frame.recycle();
  }finally{i.runOnMainSync(activity::finish);}
 }
 private static int changed(Bitmap a,Bitmap b){assertEquals(a.getWidth(),b.getWidth());assertEquals(a.getHeight(),b.getHeight());int count=0;for(int y=80;y<a.getHeight();y++)for(int x=0;x<a.getWidth();x++)if(a.getPixel(x,y)!=b.getPixel(x,y))count++;return count;}
 private static JSONObject result(Context ctx)throws Exception{File file=new File(ctx.getFilesDir(),"podjs/podjs-kv.json");if(!file.isFile())return new JSONObject();return new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)).optJSONObject("reader-font-result");}
 private static void awaitStage(Context ctx,String stage,long timeout)throws Exception{long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject r=result(ctx);if(r!=null){assertNotEquals(r.toString(),"failed",r.optString("state"));if(stage.equals(r.optString("stage")))return;}SystemClock.sleep(100);}throw new AssertionError("No stage "+stage+": "+result(ctx));}
 private static PodRuntimeView find(View view){if(view instanceof PodRuntimeView)return (PodRuntimeView)view;if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int j=0;j<group.getChildCount();j++){PodRuntimeView found=find(group.getChildAt(j));if(found!=null)return found;}}return null;}
 private static Bitmap bitmap(Instrumentation i,TextureView view){Bitmap[] value=new Bitmap[1];i.runOnMainSync(()->value[0]=view.getBitmap());return value[0];}
 private static boolean awake(Instrumentation i,Activity a){boolean[] value=new boolean[1];i.runOnMainSync(()->value[0]=(a.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)!=0);return value[0];}
 private static String semantics(Instrumentation i,PodRuntimeView view)throws Exception{String[] result=new String[1];i.runOnMainSync(()->{try{Field h=PodRuntimeView.class.getDeclaredField("host");h.setAccessible(true);long host=h.getLong(view);assertTrue(host!=0);Method enabled=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilityEnabled",long.class,boolean.class),frame=PodRuntimeView.class.getDeclaredMethod("nativeFrame",long.class),snapshot=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilitySnapshot",long.class,long[].class);enabled.setAccessible(true);frame.setAccessible(true);snapshot.setAccessible(true);Field flag=PodRuntimeView.class.getDeclaredField("accessibilityEnabled");flag.setAccessible(true);boolean original=flag.getBoolean(view);try{enabled.invoke(null,host,false);enabled.invoke(null,host,true);frame.invoke(null,host);byte[] bytes=(byte[])snapshot.invoke(null,host,new long[3]);assertNotNull(bytes);result[0]=new String(bytes,StandardCharsets.UTF_8);}finally{enabled.invoke(null,host,original);}}catch(Exception e){throw new AssertionError(e);}});return result[0];}
}
