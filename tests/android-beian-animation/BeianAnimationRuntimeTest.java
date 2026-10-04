package dev.podjs.runtime;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.graphics.RenderNode;
import android.os.Build;
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
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Fixed-clock production BeianScreen observations in the isolated startup APK.
 * No physical input, global settings, production animation hooks or host-clock
 * replacement. This verifies paused phases, not live animation performance. */
public final class BeianAnimationRuntimeTest {
 private static final String RESULT="beian-animation-result";
 private static final String QR_LABEL="备案查询二维码，扫描后可在手机浏览器中打开备案查询页面";
 private static final String DEFAULT_PHASES="0,250,500,980,1500,1650";
 private static final long READY_TIMEOUT_MS=75_000;
 private static final int OUTPUT_WIDTH=280,FRAME_LEFT=20,FRAME_WIDTH=240;
 private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
 private final Context context=instrumentation.getTargetContext();
 private final JSONArray observations=new JSONArray();
 private Activity activity;
 private PodRuntimeView view;
 private String runNonce,lastReadError,lastObservationFingerprint="";
 private JSONObject lastFixture;
 private NativeProbe lastNative;
 private ExpectedGeometry geometry;
 private int sequence;
 private double elapsedMs;
 private long clockOriginMs=-1;

 @Test public void productionQrFrozenPhasesHaveReadyNativeSurfacesAndStablePixels() throws Exception {
  JSONObject proof=new JSONObject().put("schemaVersion",2).put("state","started")
   .put("scope","production BeianScreen; fixture Date.now frozen at requested phases; native host timers unchanged")
   .put("animationPerformanceVerified",false).put("physicalInputInjected",false)
   .put("globalSettingsChanged",false).put("outerAlphaScaleReadback",false).put("nativeEntryTransformReadback",false)
   .put("outerAlphaScaleEvidence","pixel output has no outer scene alpha/scale; native entry RenderNode properties are read separately")
   .put("geometryScope","466x466 physical pixels, density 2; independent Native reference tables for font scales 1.0, 1.3 and 1.8");
  Throwable failure=null;
  try {
   String argument=InstrumentationRegistry.getArguments().getString("beianAnimationPhases",DEFAULT_PHASES);
   double[] phases=parsePhases(argument);
   proof.put("phaseArgument",argument).put("requestedPhasesMs",new JSONArray(phases));
   start();geometry=geometryFor(onMain(()->(double)activity.getResources().getConfiguration().fontScale));
   proof.put("runNonce",runNonce).put("platform",platform()).put("geometryOracle",geometry.json())
    .put("expectedViewport",new JSONObject().put("leftPx",93).put("topPx",geometry.outputTop).put("widthPx",OUTPUT_WIDTH).put("heightPx",geometry.outputHeight))
    .put("expectedLocalFrame",new JSONObject().put("leftPx",FRAME_LEFT).put("topPx",geometry.frameTop).put("widthPx",FRAME_WIDTH).put("heightPx",geometry.frameHeight));

   // Text readiness alone does not establish QR readiness. First observe the
   // decoded native image at t=0, then allow the production onFrame callback
   // at least four more frames to initialize its own firstFrame to the origin.
   Sample firstNativeReady=awaitPhase(0,0,0);
   Sample freshZeroPublication=awaitPhase(0,0,firstNativeReady.fixture.getLong("frameCount")+1);
   Sample zeroEstablished=awaitPhase(0,0,freshZeroPublication.fixture.getLong("frameCount")+4);
   proof.put("initialZeroClock",new JSONObject().put("firstNativeReady",firstNativeReady.json())
    .put("newPublicationAfterNativeReady",freshZeroPublication.json())
    .put("afterAdditionalFrames",zeroEstablished.json()).put("minimumAdditionalFrames",4));

   JSONArray captured=new JSONArray();proof.put("phases",captured);
   for(int index=0;index<phases.length;index++) {
    double requested=phases[index];
    Sample previous=awaitPhase(sequence,elapsedMs,0);
    if(index!=0||requested!=0)command(requested);
    Sample targetApplied=awaitPhase(sequence,requested,previous.fixture.getLong("frameCount")+4);
    Sample freshPublication=awaitPhase(sequence,requested,targetApplied.fixture.getLong("frameCount")+1);
    Sample presented=awaitPhase(sequence,requested,freshPublication.fixture.getLong("frameCount")+4);
    JSONObject phase=new JSONObject().put("index",index).put("commandSequence",sequence)
     .put("requestedElapsedMs",requested).put("effectiveElapsedMs",Math.min(1650,requested))
     .put("expectedSourceFormula",expected(requested,presented.fixture.getJSONObject("metrics").getDouble("density")))
     .put("nativeTargetFirstObserved",targetApplied.json()).put("newPublicationAfterNativeReady",freshPublication.json())
     .put("afterAdditionalFrames",presented.json());
    captured.put(phase);
    phase.put("capture",capture(index,requested,presented));
    writeProof(proof);
   }
   proof.put("state","passed").put("nativeEntryTransformReadback",true);
  } catch(Throwable error) {
   failure=error;proof.put("state","failed").put("error",error.toString());
   if(lastFixture!=null)proof.put("lastFixture",lastFixture);
   if(lastNative!=null)proof.put("lastNative",lastNative.json);
   if(lastReadError!=null)proof.put("lastKvReadError",lastReadError);
  } finally {
   proof.put("nativeObservations",observations);
   try {proof.put("cleanup",finish());}
   catch(Throwable error) {proof.put("cleanupError",error.toString());if(failure==null)failure=error;else failure.addSuppressed(error);proof.put("state","failed");}
   try {writeProof(proof);}
   catch(Throwable error) {if(failure==null)failure=error;else failure.addSuppressed(error);}
  }
  if(failure instanceof Error)throw(Error)failure;
  if(failure!=null)throw new Exception(failure);
 }

 private void start() throws Exception {
  assertEquals("This test may only seed its own fixture sandbox","dev.podjs.tests.startup",context.getPackageName());
  runNonce=UUID.randomUUID().toString();sequence=0;elapsedMs=0;
  JSONObject seed=kvFile().isFile()?new JSONObject(new String(Files.readAllBytes(kvFile().toPath()),StandardCharsets.UTF_8)):new JSONObject();
  seed.remove(RESULT);seed.put("beian-animation-run-nonce",runNonce);
  assertTrue(kvFile().getParentFile().isDirectory()||kvFile().getParentFile().mkdirs());
  Files.write(kvFile().toPath(),seed.toString().getBytes(StandardCharsets.UTF_8));
  Files.deleteIfExists(commandFile().toPath());
  activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity")
   .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  long deadline=SystemClock.uptimeMillis()+30_000;
  while(SystemClock.uptimeMillis()<deadline) {
   view=onMain(()->find(activity.getWindow().getDecorView()));
   if(view!=null)return;
   SystemClock.sleep(50);
  }
  throw new AssertionError("PodRuntimeView did not appear");
 }

 private Sample awaitPhase(int expectedSequence,double requested,long minimumFrames) throws Exception {
  long deadline=SystemClock.uptimeMillis()+READY_TIMEOUT_MS;
  while(SystemClock.uptimeMillis()<deadline) {
   JSONObject fixture=readFixture();
   if(fixture!=null&&runNonce.equals(fixture.optString("runNonce"))) {
    assertNotEquals("Fixture failed: "+fixture,"failed",fixture.optString("state"));
    if("ready".equals(fixture.optString("state"))&&fixture.optInt("commandSequence",-1)==expectedSequence) {
     assertFixture(fixture,expectedSequence,requested);
     NativeProbe nativeProbe=nativeProbe();recordObservation(nativeProbe,expectedSequence,requested);
     if(fixture.getLong("frameCount")>=minimumFrames&&nativeMatches(nativeProbe,requested,fixture.getJSONObject("metrics").getDouble("density")))
      return new Sample(fixture,nativeProbe,SystemClock.uptimeMillis());
    }
   }
   SystemClock.sleep(50);
  }
  throw new AssertionError("Phase did not become native-ready: sequence="+expectedSequence+" elapsed="+requested
   +" minimumFrames="+minimumFrames+" fixture="+lastFixture+" native="+(lastNative==null?null:lastNative.json)+" kvError="+lastReadError);
 }

 private void assertFixture(JSONObject value,int expectedSequence,double requested) throws Exception {
  assertEquals(runNonce,value.getString("runNonce"));assertEquals("ready",value.getString("state"));
  assertEquals(expectedSequence,value.getInt("commandSequence"));assertEquals(requested,value.getDouble("elapsedMs"),.000001);
  assertEquals(Math.min(1650,requested),value.getDouble("effectiveElapsedMs"),.000001);
  long origin=value.getLong("clockOriginMs");if(clockOriginMs<0)clockOriginMs=origin;assertEquals(clockOriginMs,origin);
  assertEquals("Fixture wall clock must remain at this exact phase",origin+requested,value.getDouble("clockTimestampMs"),.001);
  assertTrue(value.getString("clockMode").contains("native host timers unchanged"));
  assertFalse(value.getBoolean("qrReadinessVerifiedByFixture"));assertFalse(value.getBoolean("animationPerformanceVerified"));
  assertFalse(value.getBoolean("physicalInputInjected"));assertEquals(0,value.getJSONArray("errors").length());
  assertTrue(value.getLong("frameCount")>=4);
  JSONObject counts=value.getJSONObject("resources");assertEquals(0,counts.getInt("active"));assertEquals(0,counts.getInt("queued"));
  JSONObject text=value.getJSONObject("nativeTextStatus");assertEquals(2,text.getInt("cached"));assertEquals(2,text.getInt("ready"));
  for(String key:new String[]{"pending","failed","active","queued"})assertEquals("Native text "+key,0,text.getInt(key));
  assertEquals(0,text.getJSONObject("totals").getInt("failed"));assertTrue(text.getJSONObject("totals").getInt("succeeded")>=2);
  assertEquals(0,value.getJSONObject("initialTextStatus").getJSONObject("totals").getInt("failed"));
  JSONArray entries=text.getJSONArray("entries");assertEquals(2,entries.length());
  for(int index=0;index<entries.length();index++) {
   JSONObject entry=entries.getJSONObject(index);assertEquals("ready",entry.getString("status"));assertTrue(entry.getBoolean("uploaded"));
   assertEquals(entry.getInt("refs"),entry.getInt("readyListeners"));assertEquals(0,entry.getInt("pendingListeners"));assertEquals(0,entry.getInt("failedListeners"));
  }
  JSONArray applied=value.getJSONArray("appliedCommandSequences");assertEquals(expectedSequence,applied.length());
  for(int index=0;index<applied.length();index++)assertEquals(index+1,applied.getInt(index));
  JSONObject env=value.getJSONObject("environment"),metrics=value.getJSONObject("metrics");
  assertEquals(onMain(()->(double)activity.getResources().getConfiguration().fontScale),env.getDouble("fontScale"),.00001);
  assertEquals(onMain(()->(double)activity.getResources().getDisplayMetrics().density),metrics.getDouble("density"),.00001);
  assertEquals("Font scale must match the selected Native reference",geometry.fontScale,env.getDouble("fontScale"),.00001);
  assertEquals("This geometry oracle requires density 2",2,metrics.getDouble("density"),.00001);
  assertEquals(233,metrics.getDouble("logicalWidth"),.00001);assertEquals(233,metrics.getDouble("logicalHeight"),.00001);
  assertEquals(466,onMain(()->view.getWidth()).intValue());assertEquals(466,onMain(()->view.getHeight()).intValue());
 }

 private void command(double requested) throws Exception {
  assertTrue(requested>=elapsedMs&&requested<=5000);elapsedMs=requested;
  JSONObject command=new JSONObject().put("sequence",++sequence).put("elapsedMs",requested);
  File target=commandFile(),temporary=new File(target.getParentFile(),target.getName()+".tmp");
  assertTrue(target.getParentFile().isDirectory()||target.getParentFile().mkdirs());
  Files.write(temporary.toPath(),command.toString().getBytes(StandardCharsets.UTF_8));
  Files.move(temporary.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING);
 }

 private NativeProbe nativeProbe() throws Exception {
  NativeProbe probe=onMain(()->{
   assertNotNull(view);long runtimeHost=host(view);
   Object services=field(view,"services"),media=field(services,"mediaSurfaces");
   @SuppressWarnings("unchecked") Map<String,Object> sessions=(Map<String,Object>)field(media,"sessions");
   JSONArray rows=new JSONArray();int[] pixels=null;int width=0,height=0,stride=0;
   for(Map.Entry<String,Object> item:new TreeMap<>(sessions).entrySet()) {
    Object session=item.getValue(),style=field(session,"style");Bitmap image=(Bitmap)field(session,"image");
    Method state=session.getClass().getDeclaredMethod("state");state.setAccessible(true);
    JSONObject row=new JSONObject().put("state",state.invoke(session)).put("id",field(session,"id"))
     .put("video",field(session,"video")).put("linearSampling",field(session,"linearSampling"))
     .put("imageLoading",field(session,"imageLoading")).put("disposed",field(session,"disposed"))
     .put("failed",field(session,"failed")).put("error",nullable(field(session,"error")))
     .put("handle",field(session,"handle")).put("contentWidth",field(session,"width")).put("contentHeight",field(session,"height"))
     .put("textureWidth",field(session,"tw")).put("textureHeight",field(session,"th"))
     .put("decodeRevision",field(session,"revision")).put("videoReadyNotImageReadiness",field(session,"ready"))
     .put("videoFramesNotImageFrames",field(session,"renderedFrames"));
    File source=(File)field(session,"source");row.put("source",source==null?JSONObject.NULL:source.getPath());
    row.put("imagePresent",image!=null).put("imageRecycled",image!=null&&image.isRecycled());
    if(image!=null&&!image.isRecycled())row.put("imageWidth",image.getWidth()).put("imageHeight",image.getHeight());
    JSONObject actualStyle=new JSONObject();
    for(String key:new String[]{"fit","blurEdgeMode","brightness","brightnessBias","overlayOpacity","blur","saturation","zoom","focusX","focusY","rotation","base","overlay","active"})
     actualStyle.put(key,field(style,key));
    Object presentation=field(style,"presentationFrame");
    actualStyle.put("presentationFrame",presentation==null?JSONObject.NULL:presentationJson(presentation));
    row.put("style",actualStyle);
    int[] current=((int[])field(session,"pixels")).clone();row.put("pixelArgb32BeSha256",shaArgb(current));
    Object renderer=field(session,"renderer");
    row.put("rendererFrame",new JSONObject().put("width",field(renderer,"width")).put("height",field(renderer,"height")));
    row.put("renderNodes",new JSONObject().put("entry",renderNodeJson((RenderNode)field(renderer,"entry")))
     .put("root",renderNodeJson((RenderNode)field(renderer,"root"))).put("media",renderNodeJson((RenderNode)field(renderer,"media"))));
    row.put("nativePixelExtent","fixed output viewport with transparent padding; texture hash also includes power-of-two padding");
    rows.put(row);
    if(sessions.size()==1) {pixels=current;width=(Integer)field(session,"width");height=(Integer)field(session,"height");stride=(Integer)field(session,"tw");}
   }
   return new NativeProbe(new JSONObject().put("host",runtimeHost).put("sessionCount",rows.length()).put("sessions",rows),pixels,width,height,stride);
  });
  lastNative=probe;return probe;
 }

 private boolean nativeMatches(NativeProbe probe,double requested,double density) throws Exception {
  if(probe.json.getLong("host")==0||probe.json.getInt("sessionCount")!=1)return false;
  JSONObject row=probe.json.getJSONArray("sessions").getJSONObject(0),state=row.getJSONObject("state"),style=row.getJSONObject("style");
  if(row.getBoolean("video")||row.getBoolean("disposed")||row.getBoolean("failed")||row.getBoolean("imageLoading")
   ||!row.getBoolean("imagePresent")||row.getBoolean("imageRecycled")||row.getInt("handle")<0)return false;
  if(!"ready".equals(state.getString("state"))||!"linear".equals(state.getString("textureSampling"))||!row.getBoolean("linearSampling"))return false;
  int source=Math.max(1,(int)(120*density));
  if(row.getInt("imageWidth")!=source||row.getInt("imageHeight")!=source)return false;
  if(row.getInt("contentWidth")!=OUTPUT_WIDTH||row.getInt("contentHeight")!=geometry.outputHeight||row.getInt("textureWidth")!=512||row.getInt("textureHeight")!=512)return false;
  if(state.getInt("contentWidth")!=OUTPUT_WIDTH||state.getInt("contentHeight")!=geometry.outputHeight||state.getInt("width")!=512||state.getInt("height")!=512)return false;
  if(row.getJSONObject("rendererFrame").getInt("width")!=OUTPUT_WIDTH||row.getJSONObject("rendererFrame").getInt("height")!=geometry.outputHeight)return false;
  if(!"fit".equals(style.getString("fit"))||!"clamp".equals(style.getString("blurEdgeMode")))return false;
  if(style.getInt("base")!=0xff000000||style.getInt("overlay")!=0xffffffff||!style.getBoolean("active"))return false;
  JSONObject expected=expected(requested,density);
  if(!presentationMatches(style.optJSONObject("presentationFrame"),expected,geometry)||!presentationMatches(state.optJSONObject("presentationFrame"),expected,geometry))return false;
  JSONObject nodes=row.getJSONObject("renderNodes");
  if(!nodeMatches(nodes.getJSONObject("entry"),FRAME_WIDTH,geometry.frameHeight,FRAME_LEFT,geometry.frameTop,expected.getDouble("scale"),expected.getDouble("alpha")))return false;
  if(!nodeMatches(nodes.getJSONObject("media"),FRAME_WIDTH,geometry.frameHeight,0,0,1,1)||!nodeMatches(nodes.getJSONObject("root"),OUTPUT_WIDTH,geometry.outputHeight,0,0,1,1))return false;
  return near(style.getDouble("brightness"),1,.000001)&&near(style.getDouble("saturation"),1,.000001)
   &&near(style.getDouble("zoom"),1,.000001)&&near(style.getDouble("focusX"),.5,.000001)&&near(style.getDouble("focusY"),.5,.000001)
   &&near(style.getDouble("rotation"),0,.000001)
   &&near(style.getDouble("brightnessBias"),expected.getDouble("brightnessBias"),.00002)
   &&near(style.getDouble("overlayOpacity"),expected.getDouble("overlayOpacity"),.00002)
   &&near(style.getDouble("blur"),expected.getDouble("blurPx"),Build.VERSION.SDK_INT>=31?.003:.000001);
 }

 private JSONObject capture(int index,double requested,Sample readiness) throws Exception {
  long deadline=SystemClock.uptimeMillis()+20_000;List<Bitmap> stable=new ArrayList<>();List<JSONObject> samples=new ArrayList<>();
  String previous="";long firstFrame=-1;Bitmap pending=null;
  try {
   while(SystemClock.uptimeMillis()<deadline) {
    JSONObject before=requiredFixture(sequence,requested);NativeProbe nativeBefore=nativeProbe();
    assertTrue("Native style changed while phase is frozen",nativeMatches(nativeBefore,requested,before.getJSONObject("metrics").getDouble("density")));
    JSONObject semantics=semantics(before.getJSONObject("metrics"));
    pending=windowBitmap();Bitmap bitmap=pending;
    JSONObject after=requiredFixture(sequence,requested);NativeProbe nativeAfter=nativeProbe();
    boolean matches=nativeMatches(nativeAfter,requested,after.getJSONObject("metrics").getDouble("density"));
    String pixelHash=shaBitmap(bitmap),nativeHash=nativeAfter.json.toString();
    String signature=pixelHash+"\n"+nativeHash+"\n"+semantics.toString();
    if(!matches||!nativeBefore.json.toString().equals(nativeHash)||!signature.equals(previous)) {
     recycle(stable);samples.clear();firstFrame=before.getLong("frameCount");
    }
    if(!matches) {bitmap.recycle();pending=null;previous="";SystemClock.sleep(100);continue;}
    previous=signature;stable.add(bitmap);pending=null;
    samples.add(new JSONObject().put("observedUptimeMs",SystemClock.uptimeMillis()).put("fixtureBefore",before)
     .put("fixtureAfter",after).put("nativeBefore",nativeBefore.json).put("nativeAfter",nativeAfter.json).put("pixelArgb32BeSha256",pixelHash));
    if(stable.size()>=3&&after.getLong("frameCount")>firstFrame) {
     // Save the final three identical captures rather than retaining an
     // arbitrary earlier frame that happened to precede the native update.
     String stem=String.format(Locale.US,"beian-animation-%02d-%s-ms",index,Double.toString(requested).replace('.','p'));
     JSONArray pngs=new JSONArray();
     for(int n=stable.size()-3;n<stable.size();n++) {
      JSONObject png=saveBitmap(stem+"-sample-"+(n-(stable.size()-3)+1)+".png",stable.get(n));
      png.put("observation",samples.get(n));pngs.put(png);
     }
     JSONObject qr=node(semantics.getJSONArray("nodes"),QR_LABEL);assertNotNull("QR semantic node missing",qr);
     JSONObject bounds=qr.getJSONObject("windowBounds");
     Rect qrRect=new Rect(bounds.getInt("left"),bounds.getInt("top"),bounds.getInt("right"),bounds.getInt("bottom"));
     int visible=nonBlackPixels(stable.get(stable.size()-1),qrRect);assertTrue("Ready native QR was not visible in window pixels",visible>100);
     Bitmap mediaBitmap=Bitmap.createBitmap(nativeAfter.width,nativeAfter.height,Bitmap.Config.ARGB_8888);
     JSONObject mediaCapture;
     try {mediaBitmap.setPixels(nativeAfter.pixels,0,nativeAfter.stride,0,0,nativeAfter.width,nativeAfter.height);mediaCapture=saveBitmap(stem+"-native-media.png",mediaBitmap);}
     finally {mediaBitmap.recycle();}
     return new JSONObject().put("method","window PixelCopy; three consecutive equal pixel arrays with frozen clock and matching native style")
      .put("minimumConsecutiveEqualCaptures",3).put("observedConsecutiveEqualCaptures",stable.size())
      .put("frameCountAtFirstStableCapture",firstFrame).put("frameCountAtLastStableCapture",after.getLong("frameCount"))
      .put("clockRemainedFrozen",true).put("captureAfterNativeReadyFrameCount",readiness.fixture.getLong("frameCount"))
      .put("pixelHashEncoding","ARGB int32 big endian, row-major").put("windowPngs",pngs)
      .put("nativeMediaPng",mediaCapture).put("nativeMediaExtent",OUTPUT_WIDTH+"x"+geometry.outputHeight+" fixed output viewport; includes transparent border around the transformed "+FRAME_WIDTH+"x"+geometry.frameHeight+" frame")
      .put("nativeMediaPixelHashIncludesPadding",nativeAfter.json.getJSONArray("sessions").getJSONObject(0).getString("pixelArgb32BeSha256"))
      .put("semantics",semantics).put("qrNonBlackWindowPixels",visible).put("platform",platform());
    }
    // A slowly republished fixture counter may require a fourth equal image.
    // Keep bounded ownership while preserving the earliest observed counter.
    if(stable.size()>5) {stable.remove(0).recycle();samples.remove(0);}
    SystemClock.sleep(150);
   }
   throw new AssertionError("Frozen phase pixels did not stabilize: sequence="+sequence+" elapsed="+requested);
  } finally {if(pending!=null)pending.recycle();recycle(stable);}
 }

 private JSONObject semantics(JSONObject metrics) throws Exception {return onMain(()->{
  long runtimeHost=host(view);assertTrue(runtimeHost!=0);
  nativeMethod("nativeAccessibilityEnabled",long.class,boolean.class).invoke(null,runtimeHost,true);
  nativeMethod("nativeFrame",long.class).invoke(null,runtimeHost);
  long[] metadata=new long[3];byte[] bytes=(byte[])nativeMethod("nativeAccessibilitySnapshot",long.class,long[].class).invoke(null,runtimeHost,metadata);
  assertNotNull("Native semantic snapshot missing",bytes);JSONObject raw=new JSONObject(new String(bytes,StandardCharsets.UTF_8));
  int[] location=new int[2];view.getLocationInWindow(location);
  double sx=view.getWidth()/metrics.getDouble("logicalWidth"),sy=view.getHeight()/metrics.getDouble("logicalHeight");
  JSONArray converted=new JSONArray(),nodes=raw.getJSONArray("nodes");
  for(int index=0;index<nodes.length();index++) {
   JSONObject row=nodes.getJSONObject(index);if(row.optString("label").isEmpty())continue;
   JSONObject bounds=row.getJSONObject("bounds");
   converted.put(new JSONObject().put("label",row.getString("label")).put("role",row.get("role")).put("logicalBounds",bounds)
    .put("windowBounds",new JSONObject().put("left",(int)Math.floor(location[0]+bounds.getDouble("left")*sx))
     .put("top",(int)Math.floor(location[1]+bounds.getDouble("top")*sy)).put("right",(int)Math.ceil(location[0]+bounds.getDouble("right")*sx))
     .put("bottom",(int)Math.ceil(location[1]+bounds.getDouble("bottom")*sy))));
  }
  assertNotNull("Native title missing",node(converted,"标题：工信部备案"));
  assertNotNull("Native subtitle missing",node(converted,"备案查询网址：beian.miit.gov.cn"));
  assertNotNull("Native QR semantics missing",node(converted,QR_LABEL));
  return new JSONObject().put("coordinateSystem","native scene logical bounds converted using actual PodRuntimeView/window geometry")
   .put("scaleX",sx).put("scaleY",sy).put("viewWindowX",location[0]).put("viewWindowY",location[1])
   .put("viewWidth",view.getWidth()).put("viewHeight",view.getHeight()).put("nodes",converted);
 });}

 private Bitmap windowBitmap() throws Exception {
  Bitmap bitmap=onMain(()->Bitmap.createBitmap(activity.getWindow().getDecorView().getWidth(),activity.getWindow().getDecorView().getHeight(),Bitmap.Config.ARGB_8888));
  CountDownLatch latch=new CountDownLatch(1);AtomicInteger result=new AtomicInteger(PixelCopy.ERROR_UNKNOWN);
  Object ownership=new Object();boolean[] submitted={false},finished={false},abandoned={false};
  try {
   onMain(()->{
    PixelCopy.request(activity.getWindow(),bitmap,code->{
     synchronized(ownership) {result.set(code);finished[0]=true;if(abandoned[0])bitmap.recycle();}
     latch.countDown();
    },new Handler(Looper.getMainLooper()));
    synchronized(ownership) {submitted[0]=true;}return null;
   });
   assertTrue("Window PixelCopy timed out",latch.await(5,TimeUnit.SECONDS));assertEquals("Window PixelCopy failed",PixelCopy.SUCCESS,result.get());return bitmap;
  } catch(Exception|Error error) {
   // A timeout/interruption does not cancel a submitted PixelCopy. Keep its
   // destination alive until completion, then let that callback release it.
   synchronized(ownership) {if(!submitted[0]||finished[0])bitmap.recycle();else abandoned[0]=true;}
   throw error;
  }
 }

 private JSONObject saveBitmap(String name,Bitmap bitmap) throws Exception {
  File file=new File(context.getFilesDir(),name);
  try(FileOutputStream output=new FileOutputStream(file)) {assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,output));}
  return new JSONObject().put("file",name).put("width",bitmap.getWidth()).put("height",bitmap.getHeight())
   .put("pixelArgb32BeSha256",shaBitmap(bitmap)).put("pngSha256",sha(Files.readAllBytes(file.toPath())));
 }

 private JSONObject platform() throws Exception {return onMain(()->new JSONObject().put("package",context.getPackageName()).put("sdkInt",Build.VERSION.SDK_INT)
  .put("manufacturer",Build.MANUFACTURER).put("model",Build.MODEL).put("fontScale",activity.getResources().getConfiguration().fontScale)
  .put("density",activity.getResources().getDisplayMetrics().density).put("densityDpi",activity.getResources().getDisplayMetrics().densityDpi)
  .put("windowWidth",activity.getWindow().getDecorView().getWidth()).put("windowHeight",activity.getWindow().getDecorView().getHeight())
  .put("activityIdentity",System.identityHashCode(activity)));}

 private JSONObject finish() throws Exception {
  if(activity==null)return new JSONObject().put("activityLaunched",false);
  Activity previous=activity;PodRuntimeView previousView=view;
  onMain(()->{if(!previous.isDestroyed())previous.finish();return null;});
  long deadline=SystemClock.uptimeMillis()+15_000;
  while(SystemClock.uptimeMillis()<deadline) {
   if(onMain(()->previous.isDestroyed()&&(previousView==null||host(previousView)==0))) {
    Files.deleteIfExists(commandFile().toPath());activity=null;view=null;
    return new JSONObject().put("activityLaunched",true).put("activityDestroyed",true).put("nativeHostReleased",true).put("ownCommandRemoved",true);
   }
   SystemClock.sleep(50);
  }
  throw new AssertionError("Owned Activity/native host did not release after finish");
 }

 private JSONObject readFixture() {
  try {lastFixture=new JSONObject(new String(Files.readAllBytes(kvFile().toPath()),StandardCharsets.UTF_8)).optJSONObject(RESULT);lastReadError=null;return lastFixture;}
  catch(Exception error) {lastReadError=error.toString();return null;}
 }
 private JSONObject requiredFixture(int expectedSequence,double requested) throws Exception {
  JSONObject result=readFixture();assertNotNull("Fixture result disappeared during capture: "+lastReadError,result);assertFixture(result,expectedSequence,requested);return result;
 }
 private void recordObservation(NativeProbe probe,int expectedSequence,double requested) throws Exception {
  String fingerprint=expectedSequence+":"+probe.json.toString();if(fingerprint.equals(lastObservationFingerprint))return;
  lastObservationFingerprint=fingerprint;observations.put(new JSONObject().put("uptimeMs",SystemClock.uptimeMillis()).put("commandSequence",expectedSequence)
   .put("requestedElapsedMs",requested).put("native",probe.json));
 }
 private void writeProof(JSONObject proof) throws Exception {Files.write(new File(context.getFilesDir(),"beian-animation-proof.json").toPath(),proof.toString(2).getBytes(StandardCharsets.UTF_8));}
 private File kvFile() {return new File(context.getFilesDir(),"podjs/podjs-kv.json");}
 private File commandFile() {return new File(context.getFilesDir(),"podjs/files/beian-animation-command.json");}
 private <T>T onMain(Callable<T> action) throws Exception {
  AtomicReference<T> result=new AtomicReference<>();AtomicReference<Throwable> failure=new AtomicReference<>();
  instrumentation.runOnMainSync(()->{try {result.set(action.call());}catch(Throwable error){failure.set(error);}});
  if(failure.get() instanceof Error)throw(Error)failure.get();if(failure.get()!=null)throw new Exception(failure.get());return result.get();
 }
 private static Object field(Object owner,String name) throws Exception {Field field=owner.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(owner);}
 private static long host(PodRuntimeView view) throws Exception {return(Long)field(view,"host");}
 private static Method nativeMethod(String name,Class<?>...arguments) throws Exception {Method method=PodRuntimeView.class.getDeclaredMethod(name,arguments);method.setAccessible(true);return method;}
 private static PodRuntimeView find(View node) {if(node instanceof PodRuntimeView)return(PodRuntimeView)node;if(node instanceof ViewGroup)for(int n=0;n<((ViewGroup)node).getChildCount();n++){PodRuntimeView value=find(((ViewGroup)node).getChildAt(n));if(value!=null)return value;}return null;}
 private static JSONObject node(JSONArray nodes,String label) throws Exception {for(int index=0;index<nodes.length();index++){JSONObject node=nodes.getJSONObject(index);if(label.equals(node.optString("label")))return node;}return null;}
 private static Object nullable(Object value) {return value==null?JSONObject.NULL:value;}
 private static boolean near(double actual,double expected,double tolerance) {return Double.isFinite(actual)&&Math.abs(actual-expected)<=tolerance;}
 private static JSONObject presentationJson(Object frame) throws Exception {
  return new JSONObject().put("leftPx",field(frame,"left")).put("topPx",field(frame,"top"))
   .put("widthPx",field(frame,"width")).put("heightPx",field(frame,"height"))
   .put("scale",field(frame,"scale")).put("opacity",field(frame,"opacity"));
 }
 private static JSONObject renderNodeJson(RenderNode node) throws Exception {
  // Public getters exist on the API 30 baseline. Do not enumerate reflected
  // fields or methods of platform graphics/effect classes.
  return new JSONObject().put("hasDisplayList",node.hasDisplayList()).put("width",node.getWidth()).put("height",node.getHeight())
   .put("left",node.getLeft()).put("top",node.getTop()).put("right",node.getRight()).put("bottom",node.getBottom())
   .put("alpha",node.getAlpha()).put("scaleX",node.getScaleX()).put("scaleY",node.getScaleY())
   .put("translationX",node.getTranslationX()).put("translationY",node.getTranslationY())
   .put("pivotX",node.getPivotX()).put("pivotY",node.getPivotY());
 }
 private static boolean presentationMatches(JSONObject frame,JSONObject expected,ExpectedGeometry geometry) throws Exception {
  return frame!=null&&near(frame.getDouble("leftPx"),FRAME_LEFT,.000001)&&near(frame.getDouble("topPx"),geometry.frameTop,.000001)
   &&frame.getInt("widthPx")==FRAME_WIDTH&&frame.getInt("heightPx")==geometry.frameHeight
   &&near(frame.getDouble("scale"),expected.getDouble("scale"),.00002)&&near(frame.getDouble("opacity"),expected.getDouble("alpha"),.00002);
 }
 private static boolean nodeMatches(JSONObject node,int width,int height,int left,int top,double scale,double opacity) throws Exception {
  return node.getBoolean("hasDisplayList")&&node.getInt("width")==width&&node.getInt("height")==height
   &&node.getInt("left")==0&&node.getInt("top")==0&&node.getInt("right")==width&&node.getInt("bottom")==height
   &&near(node.getDouble("translationX"),left,.000001)&&near(node.getDouble("translationY"),top,.000001)
   &&near(node.getDouble("pivotX"),width/2.,.000001)&&near(node.getDouble("pivotY"),height/2.,.000001)
   &&near(node.getDouble("scaleX"),scale,.00002)&&near(node.getDouble("scaleY"),scale,.00002)&&near(node.getDouble("alpha"),opacity,.00002);
 }
 private static void recycle(List<Bitmap> bitmaps) {for(Bitmap bitmap:bitmaps)bitmap.recycle();bitmaps.clear();}
 private static int nonBlackPixels(Bitmap bitmap,Rect bounds) {if(!bounds.intersect(0,0,bitmap.getWidth(),bitmap.getHeight()))return 0;int result=0;for(int y=bounds.top;y<bounds.bottom;y++)for(int x=bounds.left;x<bounds.right;x++)if((bitmap.getPixel(x,y)&0xffffff)!=0)result++;return result;}
 private static String shaBitmap(Bitmap bitmap) throws Exception {int[] pixels=new int[bitmap.getWidth()*bitmap.getHeight()];bitmap.getPixels(pixels,0,bitmap.getWidth(),0,0,bitmap.getWidth(),bitmap.getHeight());return shaArgb(pixels);}
 private static String shaArgb(int[] pixels) throws Exception {
  // Preserve the receipt's ARGB int32 big-endian encoding while avoiding four
  // provider update calls per pixel on the main-thread native-session probe.
  ByteBuffer bytes=ByteBuffer.allocate(Math.multiplyExact(pixels.length,4)).order(ByteOrder.BIG_ENDIAN);
  bytes.asIntBuffer().put(pixels);return sha(bytes.array());
 }
 private static String sha(byte[] bytes) throws Exception {return hex(MessageDigest.getInstance("SHA-256").digest(bytes));}
 private static String hex(byte[] bytes) {StringBuilder result=new StringBuilder();for(byte value:bytes)result.append(String.format(Locale.US,"%02x",value&255));return result.toString();}

 private static double[] parsePhases(String input) {
  assertNotNull(input);String[] parts=input.split(",",-1);assertTrue("Use between 1 and 32 animation phases",parts.length>=1&&parts.length<=32);
  double[] result=new double[parts.length];double previous=0;
  for(int index=0;index<parts.length;index++) {double value=Double.parseDouble(parts[index].trim());assertTrue("Phases must be finite, sorted and in [0,5000]",Double.isFinite(value)&&value>=previous&&value<=5000);result[index]=value;previous=value;}
  return result;
 }
 private static JSONObject expected(double requested,double density) throws Exception {
  double elapsed=Math.min(1650,requested);
  return new JSONObject().put("requestedElapsedMs",requested).put("effectiveElapsedMs",elapsed)
   .put("alpha",.12+.88*bezier(elapsed/980,0,.2)).put("scale",1.16-.16*bezier(elapsed/1500,.4,.2))
   .put("brightness",1).put("brightnessBias",58./255*(1-bezier(elapsed/1400,.4,.2)))
   .put("overlayOpacity",.24*(1-bezier(elapsed/1350,.4,.2)))
   .put("blurPx",Build.VERSION.SDK_INT>=31?18*density*(1-bezier(elapsed/1650,.4,.2)):0)
   .put("oracle","independent 48-iteration cubic x inversion; production uses 16 iterations; native float style tolerances applied")
   .put("alphaScaleReadFromScene",false);
 }
 private static double bezier(double fraction,double x1,double x2) {
  if(fraction<=0)return 0;if(fraction>=1)return 1;double low=0,high=1;
  for(int iteration=0;iteration<48;iteration++){double t=(low+high)/2,u=1-t,x=3*u*u*t*x1+3*u*t*t*x2+t*t*t;if(x<fraction)low=t;else high=t;}
  double t=(low+high)/2;return 3*(1-t)*t*t+t*t*t;
 }
 private static ExpectedGeometry geometryFor(double fontScale) {
  // These are independent Native-device reference literals, not outputs of
  // the production PodJS layout function. See each proof's text measurements
  // and the matching final PixelCopy image; the QR frame is derived using
  // Native's 16dp gap, 120dp request and 18dp inset at density 2.
  if(near(fontScale,1.0,.00001))return new ExpectedGeometry(1.0,176,240,156,280,20,
   "artifacts/native-information-document/device-default-first/native-beian-proof.json",
   "d7edfc445ee960e14708512a6ed2794c6edf45e365fe5e5b9cfb018bba64fe69");
  if(near(fontScale,1.3,.00001))return new ExpectedGeometry(1.3,184,240,164,280,20,
   "artifacts/native-information-font-scale/device-1.3/native-beian-proof.json",
   "f6cdee726a305114781cbf671721d5577115d2943a24da4e2176b1fc2e28cb41");
  if(near(fontScale,1.8,.00001))return new ExpectedGeometry(1.8,208,222,190,258,18,
   "artifacts/native-information-font-scale/device-1.8/native-beian-proof.json",
   "5de0d18f49caba799917cdc414266f5421305427970c67744a00de91b9aa89a3");
  throw new AssertionError("No independent Native geometry reference for font scale "+fontScale);
 }
 private static final class ExpectedGeometry {
  final double fontScale;final int qrTop,frameHeight,outputTop,outputHeight,frameTop;final String sourceProof,sourceProofSha256;
  ExpectedGeometry(double fontScale,int qrTop,int frameHeight,int outputTop,int outputHeight,int frameTop,String sourceProof,String sourceProofSha256){
   this.fontScale=fontScale;this.qrTop=qrTop;this.frameHeight=frameHeight;this.outputTop=outputTop;this.outputHeight=outputHeight;this.frameTop=frameTop;
   this.sourceProof=sourceProof;this.sourceProofSha256=sourceProofSha256;
  }
  JSONObject json() throws Exception {return new JSONObject().put("fontScale",fontScale).put("sourceProof",sourceProof).put("sourceProofSha256",sourceProofSha256)
   .put("sourceKind","Native production Activity text bounds and final PixelCopy; QR frame derived using Native layout rules")
   .put("qrFrameInWindow",new JSONObject().put("leftPx",113).put("topPx",qrTop).put("widthPx",FRAME_WIDTH).put("heightPx",frameHeight))
   .put("outputViewportKind","fixed pixel-aligned bounds covering maximum scale 1.16");}
 }
 private static final class NativeProbe {
  final JSONObject json;final int[] pixels;final int width,height,stride;
  NativeProbe(JSONObject json,int[] pixels,int width,int height,int stride){this.json=json;this.pixels=pixels;this.width=width;this.height=height;this.stride=stride;}
 }
 private static final class Sample {
  final JSONObject fixture;final NativeProbe nativeProbe;final long uptimeMs;
  Sample(JSONObject fixture,NativeProbe nativeProbe,long uptimeMs){this.fixture=fixture;this.nativeProbe=nativeProbe;this.uptimeMs=uptimeMs;}
  JSONObject json() throws Exception {return new JSONObject().put("fixture",fixture).put("native",nativeProbe.json).put("observedUptimeMs",uptimeMs);}
 }
}
