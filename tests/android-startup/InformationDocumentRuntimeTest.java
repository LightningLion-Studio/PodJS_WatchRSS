package dev.podjs.runtime;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Application;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.PixelCopy;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Production InformationDocument, native text services and real recreation.
 * Commands use the component's public scroll handle; no physical input. */
public final class InformationDocumentRuntimeTest {
 private static final String RESULT="information-document-result", STATE="informationDocumentFixture";
 private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
 private final Context context=instrumentation.getTargetContext();
 private Activity activity;
 private PodRuntimeView view;
 private int run=1,sequence=0;
 private final Lifecycle lifecycle=new Lifecycle();

 @Test public void staticDocumentMatchesReferenceContentAndRestoresMiddleAndActualBottom() throws Exception {
  JSONObject proof=new JSONObject();
  try {
   JSONObject reference=reference();start("static");JSONObject first=awaitReady();
   assertEquals(reference.getString("title"),first.getString("title"));
   assertEquals(reference.getString("staticBody"),first.getString("content"));
   assertEquals(reference.getString("staticBodySha256"),sha(first.getString("content").getBytes(StandardCharsets.UTF_8)));
   assertEquals(0,first.getInt("scrollOffsetPx"));assertFalse(first.getBoolean("restoredAtLaunch"));
   awaitLabel(reference.getString("title"));awaitLabel(paragraph(reference,1));
   proof.put("top",observe("static-top"));

   // 6037 is a Compose LazyList semantic estimate, not physical scrollY.
   // Locate the same paragraph and reuse the reference's physical Y as the
   // Pod paragraph wrapper target. Native Text and this wrapper have different
   // semantic boxes, so this does not establish matching text-content tops.
   JSONObject anchor=reference.getJSONObject("nativeReference").getJSONObject("anchor");
   String anchorText=paragraph(reference,anchor.getInt("paragraph"));
   JSONObject anchorNode=null;
   for(int step=0;step<60;step++) {
    anchorNode=node(snapshot(),anchorText);
    if(anchorNode!=null&&anchorNode.getJSONObject("bounds").getInt("top")>0)break;
    JSONObject ready=awaitReady();command("offset",ready.getInt("scrollOffsetPx")+150);
   }
   assertNotNull("Native anchor paragraph never became visible",anchorNode);
   JSONObject beforeAlignment=awaitReady(),metrics=beforeAlignment.getJSONObject("metrics");
   double scaleX=metrics.getDouble("physicalWidth")/metrics.getDouble("logicalWidth");
   double scaleY=metrics.getDouble("physicalHeight")/metrics.getDouble("logicalHeight");
   assertTrue("Display conversion must be finite and positive",Double.isFinite(scaleX)&&scaleX>0&&Double.isFinite(scaleY)&&scaleY>0);
   // nativeAccessibilitySnapshot returns scene logical coordinates. Android's
   // accessibility provider normally converts them; this direct probe must do
   // that conversion before combining bounds with physical scroll offsets.
   double beforeTopLogical=anchorNode.getJSONObject("bounds").getDouble("top"),beforeTopPx=beforeTopLogical*scaleY;
   int beforeOffsetPx=beforeAlignment.getInt("scrollOffsetPx");
   int target=(int)Math.round(beforeOffsetPx+beforeTopPx-anchor.getInt("topPx"));
   JSONObject alignment=new JSONObject().put("paragraph",anchor.getInt("paragraph"))
    .put("anchorKind","Pod paragraph wrapper").put("nativeTextAnchorAligned",false)
    .put("boundsUnit","raw scene logical coordinates").put("scrollOffsetUnit","physical pixels")
    .put("metrics",metrics).put("scaleX",scaleX).put("scaleY",scaleY)
    .put("beforeBoundsLogical",new JSONObject(anchorNode.getJSONObject("bounds").toString()))
    .put("beforeTopLogical",beforeTopLogical).put("beforeTopPx",beforeTopPx).put("beforeScrollOffsetPx",beforeOffsetPx)
    .put("nativeTargetTopPx",anchor.getInt("topPx")).put("requestedScrollOffsetPx",target);
   proof.put("anchorAlignment",alignment);
   command("offset",target);anchorNode=node(awaitLabel(anchorText),anchorText);
   double afterTopLogical=anchorNode.getJSONObject("bounds").getDouble("top"),afterTopPx=afterTopLogical*scaleY;
   alignment.put("afterBoundsLogical",new JSONObject(anchorNode.getJSONObject("bounds").toString()))
    .put("afterTopLogical",afterTopLogical).put("afterTopPx",afterTopPx).put("afterRuntime",awaitReady());
   assertEquals("Pod paragraph wrapper top in physical pixels",(double)anchor.getInt("topPx"),afterTopPx,0.0);
   JSONObject middle=observe("static-middle-before");
   JSONObject middleRecreation=recreate();JSONObject middleAfter=observe("static-middle-after");
   assertRestored(middle,middleAfter,middleRecreation);
   proof.put("middleBefore",middle).put("middleAfter",middleAfter).put("middleRecreation",middleRecreation)
    .put("derivedMiddlePhysicalOffsetPx",target).put("legacyNativeReference",reference.getJSONObject("nativeReference"));

   command("bottom",0);JSONObject bottomResult=awaitReady();assertTrue("Actual clamped bottom required",bottomResult.getBoolean("atEnd"));
   assertTrue(bottomResult.getInt("scrollOffsetPx")>target);awaitLabel("浙ICP备2024111886号-5A");
   assertNull("First paragraph must be outside the bottom viewport",node(snapshot(),paragraph(reference,1)));
   JSONObject bottom=observe("static-bottom-before");JSONObject bottomRecreation=recreate();JSONObject bottomAfter=observe("static-bottom-after");
   assertRestored(bottom,bottomAfter,bottomRecreation);assertTrue(awaitReady().getBoolean("atEnd"));
   proof.put("bottomBefore",bottom).put("bottomAfter",bottomAfter).put("bottomRecreation",bottomRecreation)
    .put("state","passed").put("productionDocumentRecreationPixelsEqual",true).put("productionDocumentRecreationGeometryEqual",true)
    .put("nativePixelsCompared",false).put("nativeTextAnchorAligned",false).put("nativeTopAndBottomAvailableInLegacyProof",false)
    .put("nativeReferenceRuntimePresetVerified",false).put("processDeathVerified",false).put("physicalInputInjected",false);
  } catch(Throwable error) {recordFailure(proof,"static",error);throw error;}
  finally {writeProof("static",proof);finish();}
 }

 @Test public void bodyCodeAndQuoteUseProductionNativeRolesAndRestore() throws Exception {
  JSONObject proof=new JSONObject();
  try {
   JSONObject reference=reference();start("roles");JSONObject ready=awaitReady();
   assertEquals(reference.getString("rolesTitle"),ready.getString("title"));assertEquals(reference.getString("rolesBody"),ready.getString("content"));
   JSONArray blocks=ready.getJSONArray("blocks");assertEquals(3,blocks.length());
   String[] roles={"body","code","quote"};
   for(int n=0;n<roles.length;n++){assertEquals(roles[n],blocks.getJSONObject(n).getString("style"));awaitLabel(blocks.getJSONObject(n).getString("text"));}
   JSONObject before=observe("roles-before");JSONObject recreation=recreate();JSONObject after=observe("roles-after");assertRestored(before,after,recreation);
   proof.put("state","passed").put("before",before).put("after",after).put("recreation",recreation)
    .put("productionRoles",new JSONArray(roles)).put("nativePixelsCompared",false).put("nativeRoleReferenceAvailableInLegacyProof",false)
    .put("productionDocumentRecreationPixelsEqual",true).put("physicalInputInjected",false);
  } catch(Throwable error) {recordFailure(proof,"roles",error);throw error;}
  finally {writeProof("roles",proof);finish();}
 }

 private JSONObject reference() throws Exception {
  try(InputStream in=instrumentation.getContext().getAssets().open("information-document-reference.json")){
   java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[4096];int count;
   while((count=in.read(buffer))!=-1)out.write(buffer,0,count);return new JSONObject(out.toString("UTF-8"));
  }
 }
 private static String paragraph(JSONObject reference,int number)throws Exception{return reference.getString("staticBody").split("\n\n")[number-1];}
 private void start(String caseName)throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  JSONObject seed=new JSONObject().put("information-document-fixture",caseName)
   .put("information-document-sentinel",new JSONObject().put("keep","unchanged").put("revision",901));
  File kv=kv();kv.getParentFile().mkdirs();Files.write(kv.toPath(),seed.toString().getBytes(StandardCharsets.UTF_8));
  Files.deleteIfExists(commandFile().toPath());run=1;sequence=0;
  onMain(()->{((Application)context.getApplicationContext()).registerActivityLifecycleCallbacks(lifecycle);return null;});
  activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  findView();
 }
 private JSONObject awaitReady()throws Exception {
  long end=SystemClock.uptimeMillis()+75_000;JSONObject value=null;
  while(SystemClock.uptimeMillis()<end){
   value=read().optJSONObject(RESULT);
   if(value!=null&&value.optInt("run")==run){
    assertNotEquals("Fixture failed: "+value,"failed",value.optString("state"));
    if("ready".equals(value.optString("state"))&&value.optInt("commandSequence")==sequence){
     assertTrue(value.getBoolean("documentReady"));assertEquals("idle",value.getString("scrollerState"));
     assertEquals(0,value.getJSONArray("errors").length());assertEquals(0,value.getJSONObject("resources").getInt("active"));
     assertEquals(0,value.getJSONObject("resources").getInt("queued"));assertTrue(value.getBoolean("hostCheckpointVerified"));
     JSONObject text=value.getJSONObject("nativeTextStatus");assertTrue(text.getInt("cached")>0);
     assertEquals(text.getInt("cached"),text.getInt("ready"));assertEquals(0,text.getInt("pending"));assertEquals(0,text.getInt("failed"));
     assertEquals(0,text.getInt("active"));assertEquals(0,text.getInt("queued"));assertEquals(0,text.getJSONObject("totals").getInt("failed"));
     assertEquals(0,value.getJSONObject("initialTextStatus").getJSONObject("totals").getInt("failed"));
     assertTrue(text.getJSONObject("totals").getInt("succeeded")>=text.getInt("cached"));
     JSONArray entries=text.getJSONArray("entries");assertEquals(text.getInt("cached"),entries.length());
     for(int n=0;n<entries.length();n++){JSONObject entry=entries.getJSONObject(n);assertEquals("ready",entry.getString("status"));
      assertTrue(entry.getBoolean("uploaded"));assertEquals(entry.getInt("refs"),entry.getInt("readyListeners"));
      assertEquals(0,entry.getInt("pendingListeners"));assertEquals(0,entry.getInt("failedListeners"));}
     assertEquals(0,value.getInt("commandReplayCount"));assertTrue(value.getJSONObject("initialCommandScan").getBoolean("completed"));
     int loadedSequence=value.getJSONObject("loadedCheckpoint").getInt("commandSequence");JSONArray applied=value.getJSONArray("appliedCommandSequences");
     assertEquals(sequence-loadedSequence,applied.length());for(int n=0;n<applied.length();n++)assertEquals(loadedSequence+n+1,applied.getInt(n));
     assertEquals("unchanged",read().getJSONObject("information-document-sentinel").getString("keep"));
     JSONObject env=value.getJSONObject("environment");assertEquals(activity.getResources().getConfiguration().fontScale,env.getDouble("fontScale"),.00001);
     JSONObject body=value.getJSONObject("preset").getJSONObject("body");assertEquals(14,body.getDouble("fontSizeSp"),0);
     assertEquals(400,body.getInt("fontWeight"));assertEquals(0xfff2f2f2L,body.getLong("colorArgb"));assertTrue(body.isNull("fontAssetId"));
     assertFalse(value.getJSONObject("resolvedFonts").getJSONObject("body").has("fontPath"));return value;
    }
   }
   SystemClock.sleep(100);
  }
  throw new AssertionError("InformationDocument readiness timeout: "+value);
 }
 private void command(String action,int offset)throws Exception {
  JSONObject command=new JSONObject().put("sequence",++sequence).put("action",action).put("offsetPx",offset);
  File target=commandFile();target.getParentFile().mkdirs();File temporary=new File(target.getParentFile(),target.getName()+".tmp");
  Files.write(temporary.toPath(),command.toString().getBytes(StandardCharsets.UTF_8));Files.move(temporary.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING);
  awaitReady();
 }
 private JSONObject observe(String stage)throws Exception {
  JSONObject result=awaitReady();JSONArray geometry=stableGeometry();JSONObject capture=capture(stage);
  return new JSONObject().put("runtime",result).put("geometry",geometry).put("capture",capture)
   .put("activityIdentity",System.identityHashCode(activity));
 }
 private JSONObject recreate()throws Exception {
  JSONObject ready=awaitReady();Activity previous=activity;PodRuntimeView previousView=view;
  String hostSaved=onMain(()->previousView.savedActivityState());assertNotNull(hostSaved);
  JSONObject savedCheckpoint=new JSONObject(hostSaved).getJSONObject(STATE);
  assertEquals(ready.getInt("scrollOffsetPx"),savedCheckpoint.getInt("scrollOffsetPx"));assertEquals(sequence,savedCheckpoint.getInt("commandSequence"));
  Instrumentation.ActivityMonitor monitor=instrumentation.addMonitor("dev.podjs.androidwatch.MainActivity",null,false);
  try{onMain(()->{previous.recreate();return null;});activity=instrumentation.waitForMonitorWithTimeout(monitor,20_000);assertNotNull(activity);assertNotSame(previous,activity);}
  finally{instrumentation.removeMonitor(monitor);}
  run++;findView();JSONObject restored=awaitReady();assertTrue(restored.getBoolean("restoredAtLaunch"));
  assertEquals(ready.getInt("scrollOffsetPx"),restored.getJSONObject("loadedCheckpoint").getInt("scrollOffsetPx"));
  assertEquals(sequence,restored.getJSONObject("loadedCheckpoint").getInt("commandSequence"));
  if(sequence>0){
   assertEquals("Old command must be inspected before restored ready",sequence,restored.getJSONObject("initialCommandScan").getInt("observedSequence"));
   assertEquals("ignored-completed",restored.getJSONObject("initialCommandScan").getString("status"));
   assertTrue(restored.getInt("ignoredCommandCount")>=1);assertEquals(sequence,restored.getInt("lastIgnoredCommandSequence"));
  }else{assertEquals("missing",restored.getJSONObject("initialCommandScan").getString("status"));}
  assertEquals("New runtime must not apply completed commands",0,restored.getJSONArray("appliedCommandSequences").length());
  long end=SystemClock.uptimeMillis()+15_000;while(!onMain(()->previous.isDestroyed()&&host(previousView)==0)&&SystemClock.uptimeMillis()<end)SystemClock.sleep(50);
  return onMain(()->{
   assertTrue(previous.isDestroyed());assertEquals(0,host(previousView));assertTrue(lifecycle.saved.contains(previous));assertTrue(lifecycle.restored.contains(activity));
   return new JSONObject().put("firstIdentity",System.identityHashCode(previous)).put("secondIdentity",System.identityHashCode(activity))
    .put("savedBundleObserved",true).put("restoredBundleObserved",true).put("oldDestroyed",true).put("oldRuntimeReleased",true)
    .put("mechanism","real Activity.recreate; system-owned Bundle").put("savedCheckpoint",savedCheckpoint)
    .put("completedCommandObservedBeforeReady",sequence>0).put("completedCommandAppliedByNewRuntime",false).put("events",new JSONArray(lifecycle.events));
  });
 }
 private static void assertRestored(JSONObject before,JSONObject after,JSONObject recreation)throws Exception {
  assertTrue(recreation.getBoolean("savedBundleObserved"));assertNotEquals(before.getInt("activityIdentity"),after.getInt("activityIdentity"));
  assertEquals(before.getJSONObject("runtime").getInt("scrollOffsetPx"),after.getJSONObject("runtime").getInt("scrollOffsetPx"));
  assertEquals(before.getJSONArray("geometry").toString(),after.getJSONArray("geometry").toString());
  assertEquals("Recreated pixels differ",before.getJSONObject("capture").getString("pixelSha256"),after.getJSONObject("capture").getString("pixelSha256"));
 }
 private JSONObject snapshot()throws Exception{return onMain(()->{
  long host=host(view);assertTrue(host!=0);method("nativeAccessibilityEnabled",long.class,boolean.class).invoke(null,host,true);
  method("nativeFrame",long.class).invoke(null,host);long[] metadata=new long[3];
  byte[] bytes=(byte[])method("nativeAccessibilitySnapshot",long.class,long[].class).invoke(null,host,metadata);
  return bytes==null?null:new JSONObject(new String(bytes,StandardCharsets.UTF_8));
 });}
 private static JSONObject node(JSONObject tree,String label)throws Exception {
  if(tree==null)return null;JSONArray nodes=tree.getJSONArray("nodes");for(int n=0;n<nodes.length();n++){
   JSONObject node=nodes.getJSONObject(n);if(label.equals(node.optString("label")))return node;
  }return null;
 }
 private JSONObject awaitLabel(String label)throws Exception {
  long end=SystemClock.uptimeMillis()+15_000;JSONObject tree=null;
  while(SystemClock.uptimeMillis()<end){tree=snapshot();if(node(tree,label)!=null)return tree;SystemClock.sleep(100);}
  throw new AssertionError("Missing visible label "+label+": "+tree);
 }
 private JSONArray geometry()throws Exception {
  JSONArray result=new JSONArray();JSONObject tree=snapshot();if(tree==null)return result;JSONArray nodes=tree.getJSONArray("nodes");
  for(int n=0;n<nodes.length();n++){JSONObject node=nodes.getJSONObject(n);if(!node.optString("label").isEmpty())result.put(new JSONObject()
   .put("label",node.getString("label")).put("role",node.optString("role")).put("bounds",node.getJSONObject("bounds"))
   .put("actions",node.optInt("actions")).put("state",node.optInt("state")));}return result;
 }
 private JSONArray stableGeometry()throws Exception {
  long end=SystemClock.uptimeMillis()+10_000;JSONArray previous=geometry();int stable=0;
  while(SystemClock.uptimeMillis()<end){SystemClock.sleep(150);JSONArray current=geometry();stable=current.length()>0&&previous.toString().equals(current.toString())?stable+1:0;if(stable>=3)return current;previous=current;}
  throw new AssertionError("Semantic geometry did not settle: "+previous);
 }
 private Bitmap bitmap()throws Exception {
  Bitmap bitmap=onMain(()->Bitmap.createBitmap(activity.getWindow().getDecorView().getWidth(),activity.getWindow().getDecorView().getHeight(),Bitmap.Config.ARGB_8888));
  CountDownLatch latch=new CountDownLatch(1);AtomicInteger code=new AtomicInteger(PixelCopy.ERROR_UNKNOWN);
  onMain(()->{PixelCopy.request(activity.getWindow(),bitmap,value->{code.set(value);latch.countDown();},new Handler(Looper.getMainLooper()));return null;});
  if(!latch.await(5,TimeUnit.SECONDS)||code.get()!=PixelCopy.SUCCESS){bitmap.recycle();throw new AssertionError("Window PixelCopy failed: "+code.get());}
  return bitmap;
 }
 private JSONObject capture(String stage)throws Exception {
  long end=SystemClock.uptimeMillis()+12_000;String previous="";
  while(SystemClock.uptimeMillis()<end){Bitmap bitmap=bitmap();try{
   ByteBuffer bytes=ByteBuffer.allocate(bitmap.getByteCount());bitmap.copyPixelsToBuffer(bytes);String digest=sha(bytes.array());
   if(digest.equals(previous)){
    File file=new File(context.getFilesDir(),"information-document-"+stage+".png");
    try(FileOutputStream out=new FileOutputStream(file)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}
    return new JSONObject().put("file",file.getName()).put("method","window PixelCopy; consecutive stable pixels")
     .put("width",bitmap.getWidth()).put("height",bitmap.getHeight()).put("pixelSha256",digest).put("pngSha256",sha(Files.readAllBytes(file.toPath())));
   }previous=digest;
  }finally{bitmap.recycle();}SystemClock.sleep(150);}
  throw new AssertionError("Pixels did not stabilize for "+stage);
 }
 private void recordFailure(JSONObject proof,String stage,Throwable error)throws Exception {
  proof.put("state","failed").put("error",error.toString());
  try{if(activity!=null&&!activity.isDestroyed())proof.put("failureCapture",capture(stage+"-failure")).put("failureGeometry",geometry());}
  catch(Throwable captureError){proof.put("failureCaptureError",captureError.toString());}
 }
 private void writeProof(String caseName,JSONObject proof)throws Exception {Files.write(new File(context.getFilesDir(),"information-document-"+caseName+"-proof.json").toPath(),proof.toString(2).getBytes(StandardCharsets.UTF_8));}
 private File kv(){return new File(context.getFilesDir(),"podjs/podjs-kv.json");}
 private File commandFile(){return new File(context.getFilesDir(),"podjs/files/information-document-command.json");}
 private JSONObject read()throws Exception{return new JSONObject(new String(Files.readAllBytes(kv().toPath()),StandardCharsets.UTF_8));}
 private void findView()throws Exception {
  long end=SystemClock.uptimeMillis()+20_000;while((view=onMain(()->find(activity.getWindow().getDecorView())))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);
 }
 private void finish()throws Exception {
  if(activity==null)return;Activity previous=activity;PodRuntimeView previousView=view;
  onMain(()->{previous.finish();return null;});long end=SystemClock.uptimeMillis()+15_000;
  while(!onMain(()->previous.isDestroyed()&&(previousView==null||host(previousView)==0))&&SystemClock.uptimeMillis()<end)SystemClock.sleep(50);
  onMain(()->{((Application)context.getApplicationContext()).unregisterActivityLifecycleCallbacks(lifecycle);assertTrue(previous.isDestroyed());if(previousView!=null)assertEquals(0,host(previousView));return null;});activity=null;view=null;
 }
 private <T>T onMain(Callable<T> action)throws Exception {
  AtomicReference<T> value=new AtomicReference<>();AtomicReference<Throwable> failure=new AtomicReference<>();
  instrumentation.runOnMainSync(()->{try{value.set(action.call());}catch(Throwable error){failure.set(error);}});
  Throwable error=failure.get();if(error instanceof Error)throw(Error)error;if(error!=null)throw new Exception(error);return value.get();
 }
 private static long host(PodRuntimeView view)throws Exception {Field field=PodRuntimeView.class.getDeclaredField("host");field.setAccessible(true);return field.getLong(view);}
 private static Method method(String name,Class<?>...args)throws Exception{Method method=PodRuntimeView.class.getDeclaredMethod(name,args);method.setAccessible(true);return method;}
 private static PodRuntimeView find(View view){if(view instanceof PodRuntimeView)return(PodRuntimeView)view;if(view instanceof ViewGroup)for(int n=0;n<((ViewGroup)view).getChildCount();n++){PodRuntimeView child=find(((ViewGroup)view).getChildAt(n));if(child!=null)return child;}return null;}
 private static String sha(byte[] bytes)throws Exception {StringBuilder value=new StringBuilder();for(byte part:MessageDigest.getInstance("SHA-256").digest(bytes))value.append(String.format("%02x",part&255));return value.toString();}
 private static final class Lifecycle implements Application.ActivityLifecycleCallbacks {
  final List<Activity> saved=new ArrayList<>(),restored=new ArrayList<>();final List<JSONObject> events=new ArrayList<>();
  private void record(Activity activity,String event,Bundle state){try{events.add(new JSONObject().put("identity",System.identityHashCode(activity)).put("event",event).put("bundlePresent",state!=null));}catch(Exception error){throw new AssertionError(error);}}
  @Override public void onActivityCreated(Activity activity,Bundle state){if(state!=null)restored.add(activity);record(activity,"created",state);}
  @Override public void onActivitySaveInstanceState(Activity activity,Bundle state){saved.add(activity);record(activity,"saved",state);}
  @Override public void onActivityDestroyed(Activity activity){record(activity,"destroyed",null);}
  @Override public void onActivityResumed(Activity activity){record(activity,"resumed",null);}
  @Override public void onActivityStarted(Activity activity){}
  @Override public void onActivityPaused(Activity activity){}
  @Override public void onActivityStopped(Activity activity){}
 }
}
