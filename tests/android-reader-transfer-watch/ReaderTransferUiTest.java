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
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.*;
/** Observes received resources and production UI. Does not supply any media bytes. */
public final class ReaderTransferUiTest {
 static final String[] STAGES={"baseline","font","handoff","partial","image","video","stopped"};
 @Test public void receivedPhoneAssetsActuallyRender()throws Exception{
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();assertEquals("dev.podjs.tests.readertransfer",ctx.getPackageName());
  File variants=new File(ctx.getFilesDir(),"podjs/files/reader_assets/variants");assertTrue(variants.mkdirs()||variants.isDirectory());
  for(String stage:STAGES)Files.write(new File(variants,"receipt-"+stage+".json").toPath(),"pending".getBytes(StandardCharsets.UTF_8));
  Activity activity=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try{PodRuntimeView view=null;long deadline=SystemClock.uptimeMillis()+30000;while((view=ReaderTransferDevice.find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<deadline)SystemClock.sleep(100);assertNotNull(view);PodRuntimeView pod=view;
   await(ctx,"idle",60000);JSONObject initial=kv(ctx).getJSONObject("watchrss.reader-presets");Map<String,Bitmap> frames=new HashMap<>();JSONObject proof=new JSONObject();
   Files.write(new File(ctx.getFilesDir(),"transfer-listener-ready.json").toPath(),"true".getBytes(StandardCharsets.UTF_8));
   for(String stage:STAGES){await(ctx,stage.equals("stopped")?"idle":stage,180000);SystemClock.sleep(2800);await(ctx,stage.equals("stopped")?"idle":stage,15000);
    Bitmap frame=ReaderTransferDevice.bitmap(i,pod);assertNotNull(frame);ReaderTransferDevice.save(ctx,"transfer-"+stage+".png",frame);frames.put(stage,frame);
    if(stage.equals("partial")){File partial=new File(ctx.getFilesDir(),"podjs/files/reader_assets/backgrounds/image.png.part"),target=new File(ctx.getFilesDir(),"podjs/files/reader_assets/backgrounds/image.png");assertEquals(1048576,partial.length());assertFalse(target.exists());proof.put("partialBytes",partial.length()).put("targetAbsentUntilComplete",true);}
    if(stage.equals("video")){JSONObject state=ReaderTransferDevice.one(i,pod);assertTrue(state.getBoolean("muted"));long count=state.getLong("frames");SystemClock.sleep(650);Bitmap next=ReaderTransferDevice.bitmap(i,pod);int moving=ReaderTransferDevice.changed(frame,next,80);next.recycle();assertTrue("received clip is static",moving>1000);assertTrue(ReaderTransferDevice.one(i,pod).getLong("frames")>count);proof.put("videoChangedPixels",moving).put("video",state);}
    if(stage.equals("stopped")){assertEquals(0,ReaderTransferDevice.states(i,pod).length());JSONObject state=kv(ctx).getJSONObject("reader-transfer-state");for(String key:new String[]{"active","cached","queued"})assertEquals(0,state.getJSONObject("text").getInt(key));assertEquals(0,state.getJSONArray("mediaOwners").length());JSONObject last=kv(ctx).getJSONObject("watchrss.reader-presets");for(Iterator<String> keys=initial.keys();keys.hasNext();){String key=keys.next();if(!key.equals("assets"))assertEquals(key,initial.get(key).toString(),last.get(key).toString());}proof.put("presetStorageUnchanged",true).put("resourcesReleased",true);}
    Files.write(new File(variants,"receipt-"+stage+".json").toPath(),"done".getBytes(StandardCharsets.UTF_8));
   }
   int font=ReaderTransferDevice.changed(frames.get("baseline"),frames.get("font"),80),image=ReaderTransferDevice.changed(frames.get("font"),frames.get("image"),80);assertTrue("received font unused",font>1500);assertTrue("received image unused",image>10000);
   assertEquals(0,ReaderTransferDevice.changed(frames.get("font"),frames.get("handoff"),80));assertEquals(0,ReaderTransferDevice.changed(frames.get("font"),frames.get("partial"),80));
   JSONObject hashes=new JSONObject();for(String path:new String[]{"fonts/reader-serif.otf","backgrounds/image.png","backgrounds/clip.mp4","variants/clip.mp4","variants/poster.png"}){File file=new File(ctx.getFilesDir(),"podjs/files/reader_assets/"+path);assertTrue(file.isFile());hashes.put(path,new JSONObject().put("sha256",ReaderTransferDevice.hash(file)).put("bytes",file.length()));assertFalse(new File(file.getPath()+".part").exists());assertFalse(new File(file.getPath()+".part.meta").exists());}
   proof.put("fontChangedPixels",font).put("imageChangedPixels",image).put("handoffChangedPixels",0).put("partialChangedPixels",0).put("receivedFiles",hashes).put("noSyntheticInput",true).put("passed",true);
   Files.write(new File(ctx.getFilesDir(),"transfer-ui-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));for(Bitmap frame:frames.values())frame.recycle();
   // Keep production listener alive for the phone's final marker read and session completion.
   long finishDeadline=SystemClock.uptimeMillis()+180000;File finished=new File(variants,"phone-finished.json");while(!finished.isFile()&&SystemClock.uptimeMillis()<finishDeadline)SystemClock.sleep(100);assertTrue("Phone did not finish roundtrip verification",finished.isFile());SystemClock.sleep(2000);
  }finally{i.runOnMainSync(activity::finish);}
 }
 static JSONObject kv(Context ctx)throws Exception{File f=new File(ctx.getFilesDir(),"podjs/podjs-kv.json");return f.isFile()?new JSONObject(new String(Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8)):new JSONObject();}
 static void await(Context ctx,String stage,long timeout)throws Exception{long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject s=kv(ctx).optJSONObject("reader-transfer-state");if(s!=null){assertFalse(s.toString(),s.has("error"));JSONObject text=s.optJSONObject("text");if(stage.equals(s.optString("stage"))&&s.optBoolean("ready")&&text!=null&&text.optInt("active",-1)==0&&text.optInt("queued",-1)==0)return;}SystemClock.sleep(100);}throw new AssertionError("No settled stage "+stage+": "+kv(ctx).optJSONObject("reader-transfer-state"));}
}
