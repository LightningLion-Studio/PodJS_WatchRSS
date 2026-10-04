package dev.podjs.runtime;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.SurfaceTexture;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Choreographer;
import android.view.FrameMetrics;
import android.view.PixelCopy;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import androidx.test.platform.app.InstrumentationRegistry;
import dev.podjs.runtime.PodMediaSurfaceServices.Timing;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** One fresh production BeianScreen on the real clock in the isolated test APK.
 * Observers delegate the original runtime behavior. No extra nativeFrame,
 * accessibility action, clock replacement, input or per-frame JSON/KV/hash.
 * Window/HWUI metrics and texture callbacks are not Vulkan/panel present FPS. */
public final class BeianPerformanceRuntimeTest {
 private static final String RESULT="beian-performance-result";
 private static final int LIMIT=8192;
 private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
 private final Context context=instrumentation.getTargetContext();
 private final AtomicReference<Throwable> observerFailure=new AtomicReference<>();
 private final Rows choreographer=new Rows(2),textureUpdates=new Rows(1),windowFrames=new Rows(16);
 private final List<Upload> uploads=new ArrayList<>(256);
 private final CountDownLatch terminalSeen=new CountDownLatch(1);
 private Activity activity;
 private PodRuntimeView view;
 private PodMediaSurfaceServices media;
 private Map<String,PodMediaSurfaceServices.Session> sessions;
 private Field hostField,sinkField;
 private PodMediaSurfaceServices.TextureSink originalSink,observedSink;
 private PodMediaSurfaceServices.TimingObserver originalTimingObserver,observedTimingObserver;
 private RenderTimings renderTimings;
 private VulkanTimings vulkanTimings;
 private TextureView.SurfaceTextureListener originalTextureListener,observedTextureListener;
 private Choreographer.FrameCallback frameObserver;
 private Window.OnFrameMetricsAvailableListener metricsObserver;
 private HandlerThread metricsThread;
 private Handler metricsHandler;
 private boolean sandboxVerified,sinkInstalled,textureListenerInstalled,frameObserverInstalled,metricsInstalled;
 private boolean renderTimingEnabled,timingObserverInstalled,vulkanTimingEnabled;
 private volatile boolean measuring;
 private volatile long firstTerminalNs;
 private long mountCommandBeforeNs,mountCommandAfterNs,measurementEndNs;
 private String runNonce,lastReadError;
 private JSONObject lastFixture;

 @Test public void productionQrRunsOnNormalClock() throws Exception {
  JSONObject proof=new JSONObject().put("schemaVersion",1).put("state","started")
   .put("scope","one new Activity and guest; unmodified production BeianScreen; normal clocks")
   .put("physicalInputInjected",false).put("focusInputInjected",false).put("globalSettingsChanged",false)
   .put("clockReplaced",false).put("productionPropsAdded",false).put("extraNativeFramesRequested",false)
   .put("physicalDisplayPresentVerified",false).put("vulkanFramePresentVerified",false)
   .put("terminalPixelsMatchGoldenVerified",false).put("animationSmoothnessAccepted",false);
  Throwable failure=null;
  try {
   start();proof.put("runNonce",runNonce).put("platform",platform());
   installObservers();
   mount();
   assertTrue("Native image did not reach terminal style within 20 seconds",terminalSeen.await(20,TimeUnit.SECONDS));
   // Include the natural producer/consumer tail. No pixel copying or forced
   // invalidation occurs in the measured interval.
   SystemClock.sleep(350);
   stopObservers();
   assertObserverHealth();
   JSONObject fixture=readFixture();assertNotNull("Missing mounted fixture: "+lastReadError,fixture);
   assertEquals(runNonce,fixture.getString("runNonce"));assertEquals("mounted",fixture.getString("state"));
   assertEquals("unmodified Date.now and native timers",fixture.getString("clockMode"));
   assertFalse(fixture.getBoolean("animationOriginIsMountTime"));
   proof.put("fixture",fixture).put("measurement",measurement());
   proof.put("terminalNative",onMain(()->terminalNative()));
   proof.put("terminalWindowCapture",captureTerminalWindow());
   proof.put("state","passed").put("normalClockNativeTerminalObserved",true).put("normalClockNativeTransitionObserved",true);
  } catch(Throwable error) {
   failure=error;proof.put("state","failed").put("error",error.toString());
   if(lastFixture!=null)proof.put("lastFixture",lastFixture);
   if(lastReadError!=null)proof.put("lastFixtureReadError",lastReadError);
  } finally {
   try {stopObservers();}catch(Throwable error){failure=combine(failure,error);proof.put("observerCleanupError",error.toString());}
   try {proof.put("measurement",measurement());}catch(Throwable error){failure=combine(failure,error);proof.put("measurementError",error.toString());}
   try {proof.put("cleanup",finish());}catch(Throwable error){failure=combine(failure,error);proof.put("cleanupError",error.toString());}
   if(observerFailure.get()!=null){proof.put("observerError",observerFailure.get().toString());failure=combine(failure,observerFailure.get());}
   if(failure!=null)proof.put("state","failed");
   if(sandboxVerified)try {writeProof(proof);}catch(Throwable error){failure=combine(failure,error);}
  }
  if(failure instanceof Error)throw(Error)failure;
  if(failure!=null)throw new Exception(failure);
 }

 private void start() throws Exception {
  assertEquals("Only the isolated fixture package may be seeded","dev.podjs.tests.startup",context.getPackageName());
  assertEquals("dev.podjs.tests.startup.test",instrumentation.getContext().getPackageName());
  assertEquals("Use the existing runner that checks unchanged global font settings",
   "dev.podjs.tests.fontscale.PodFontScaleRunner",instrumentation.getClass().getName());
  String fontScale=InstrumentationRegistry.getArguments().getString("fontScale");
  assertTrue("Use the existing isolated runner fontScale argument", "1.3".equals(fontScale)||"1.8".equals(fontScale));
  String renderTiming=InstrumentationRegistry.getArguments().getString("renderTiming","false");
  assertTrue("renderTiming must be true or false", "true".equals(renderTiming)||"false".equals(renderTiming));
  renderTimingEnabled="true".equals(renderTiming);
  if(renderTimingEnabled)renderTimings=new RenderTimings();
  String vulkanTiming=InstrumentationRegistry.getArguments().getString("vulkanTiming","false");
  assertTrue("vulkanTiming must be true or false", "true".equals(vulkanTiming)||"false".equals(vulkanTiming));
  vulkanTimingEnabled="true".equals(vulkanTiming);
  if(vulkanTimingEnabled)vulkanTimings=new VulkanTimings();
  sandboxVerified=true;
  assertTrue("Frame commit capture requires the supported API 30+ host",Build.VERSION.SDK_INT>=30);
  runNonce=UUID.randomUUID().toString();
  JSONObject seed=kvFile().isFile()?new JSONObject(new String(Files.readAllBytes(kvFile().toPath()),StandardCharsets.UTF_8)):new JSONObject();
  seed.remove(RESULT);seed.put("beian-performance-run-nonce",runNonce);
  assertTrue(kvFile().getParentFile().isDirectory()||kvFile().getParentFile().mkdirs());
  Files.write(kvFile().toPath(),seed.toString().getBytes(StandardCharsets.UTF_8));
  Files.deleteIfExists(commandFile().toPath());
  hostField=field(PodRuntimeView.class,"host");
  activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity")
   .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  long deadline=SystemClock.uptimeMillis()+30_000;
  while(SystemClock.uptimeMillis()<deadline) {
   view=onMain(()->find(activity.getWindow().getDecorView()));
   JSONObject fixture=readFixture();
   if(fixture!=null&&runNonce.equals(fixture.optString("runNonce"))) {
    assertNotEquals("Fixture failed: "+fixture,"failed",fixture.optString("state"));
    if(view!=null&&onMain(()->host(view)!=0&&view.isAvailable())&&"waiting".equals(fixture.optString("state"))){
     assertEquals(Float.parseFloat(fontScale),onMain(()->activity.getResources().getConfiguration().fontScale),.00001f);return;
    }
   }
   SystemClock.sleep(25);
  }
  throw new AssertionError("Normal-clock fixture did not wait for mount command: "+lastFixture);
 }

 @SuppressWarnings("unchecked")
 private void installObservers() throws Exception {
  metricsThread=new HandlerThread("BeianWindowMetrics");metricsThread.start();metricsHandler=new Handler(metricsThread.getLooper());
  onMain(()->{
   assertTrue(activity.getWindow().getDecorView().isHardwareAccelerated());
   Object services=field(PodRuntimeView.class,"services").get(view);
   media=(PodMediaSurfaceServices)field(services.getClass(),"mediaSurfaces").get(services);
   sessions=(Map<String,PodMediaSurfaceServices.Session>)field(PodMediaSurfaceServices.class,"sessions").get(media);
   assertTrue("Production screen mounted before observers were installed",sessions.isEmpty());
   if(renderTimingEnabled){
    observedTimingObserver=(sessionId,kind,values)->{
     if(measuring)try{renderTimings.copy(sessionId,kind,values);}catch(Throwable error){observerFailure.compareAndSet(null,error);}
    };
    originalTimingObserver=media.setTimingObserver(observedTimingObserver);timingObserverInstalled=true;
    assertNull("Fresh isolated runtime already has a media timing observer",originalTimingObserver);
   }
   sinkField=field(PodMediaSurfaceServices.class,"sink");originalSink=(PodMediaSurfaceServices.TextureSink)sinkField.get(media);
   assertNotNull(originalSink);
   observedSink=new PodMediaSurfaceServices.TextureSink(){
    @Override public int write(int handle,int[] pixels,int width,int height,boolean linear){
     long begin=System.nanoTime();
     int result=originalSink.write(handle,pixels,width,height,linear);
     long end=System.nanoTime();
     if(measuring)try {
      PodMediaSurfaceServices.Session owner=null;
      for(PodMediaSurfaceServices.Session candidate:sessions.values())if(candidate.pixels==pixels){owner=candidate;break;}
      if(owner==null)throw new AssertionError("Texture write has no owning media session");
      if(uploads.size()>=LIMIT)throw new AssertionError("Upload observations overflowed");
      Upload sample=new Upload(owner,begin,end,result,width,height,linear);uploads.add(sample);
      if(result>=0&&sample.imageReady&&terminal(sample.style)&&firstTerminalNs==0){firstTerminalNs=end;terminalSeen.countDown();}
     }catch(Throwable error){observerFailure.compareAndSet(null,error);}
     return result;
    }
    @Override public void free(int handle){originalSink.free(handle);}
   };
   sinkField.set(media,observedSink);sinkInstalled=true;
   originalTextureListener=view.getSurfaceTextureListener();assertNotNull(originalTextureListener);
   observedTextureListener=new TextureView.SurfaceTextureListener(){
    @Override public void onSurfaceTextureAvailable(SurfaceTexture texture,int width,int height){originalTextureListener.onSurfaceTextureAvailable(texture,width,height);}
    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture,int width,int height){originalTextureListener.onSurfaceTextureSizeChanged(texture,width,height);}
    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture){return originalTextureListener.onSurfaceTextureDestroyed(texture);}
    @Override public void onSurfaceTextureUpdated(SurfaceTexture texture){
     originalTextureListener.onSurfaceTextureUpdated(texture);
     if(measuring)try {textureUpdates.add(System.nanoTime());}catch(Throwable error){observerFailure.compareAndSet(null,error);}
    }
   };
   view.setSurfaceTextureListener(observedTextureListener);textureListenerInstalled=true;
   frameObserver=new Choreographer.FrameCallback(){@Override public void doFrame(long frameTimeNanos){
    if(measuring){try{choreographer.add(System.nanoTime(),frameTimeNanos);}catch(Throwable error){observerFailure.compareAndSet(null,error);}}
    if(frameObserverInstalled)Choreographer.getInstance().postFrameCallback(this);
   }};
   frameObserverInstalled=true;Choreographer.getInstance().postFrameCallback(frameObserver);
   metricsObserver=(window,metrics,dropped)->{
    if(!measuring)return;
    try {
     windowFrames.add(System.nanoTime(),dropped,metrics.getMetric(FrameMetrics.FIRST_DRAW_FRAME),
      metrics.getMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP),metrics.getMetric(FrameMetrics.VSYNC_TIMESTAMP),
      metrics.getMetric(FrameMetrics.TOTAL_DURATION),metrics.getMetric(FrameMetrics.UNKNOWN_DELAY_DURATION),
      metrics.getMetric(FrameMetrics.INPUT_HANDLING_DURATION),metrics.getMetric(FrameMetrics.ANIMATION_DURATION),
      metrics.getMetric(FrameMetrics.LAYOUT_MEASURE_DURATION),metrics.getMetric(FrameMetrics.DRAW_DURATION),
      metrics.getMetric(FrameMetrics.SYNC_DURATION),metrics.getMetric(FrameMetrics.COMMAND_ISSUE_DURATION),
      metrics.getMetric(FrameMetrics.SWAP_BUFFERS_DURATION),
      Build.VERSION.SDK_INT>=31?metrics.getMetric(FrameMetrics.GPU_DURATION):-1,
      Build.VERSION.SDK_INT>=31?metrics.getMetric(FrameMetrics.DEADLINE):-1);
    }catch(Throwable error){observerFailure.compareAndSet(null,error);}
   };
   activity.getWindow().addOnFrameMetricsAvailableListener(metricsObserver,metricsHandler);metricsInstalled=true;
   return null;
  });
 }

 private void mount() throws Exception {
  JSONObject command=new JSONObject().put("runNonce",runNonce).put("action","mount").put("sequence",1);
  File file=commandFile(),temporary=new File(file.getParentFile(),file.getName()+".tmp");
  assertTrue(file.getParentFile().isDirectory()||file.getParentFile().mkdirs());
  Files.write(temporary.toPath(),command.toString().getBytes(StandardCharsets.UTF_8));
  onMain(()->{
   if(vulkanTimingEnabled)vulkanTimings.begin(view,host(view));
   measuring=true;mountCommandBeforeNs=System.nanoTime();return null;
  });
  Files.move(temporary.toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING);
  mountCommandAfterNs=System.nanoTime();
 }

 private void stopObservers() throws Exception {
  Throwable cleanupFailure=null;
  try {if(activity!=null)onMain(()->{
   if(measuring){measurementEndNs=System.nanoTime();measuring=false;}
   Throwable failure=null;
   if(vulkanTimings!=null&&vulkanTimings.started&&!vulkanTimings.stopAttempted)
    try{vulkanTimings.stop(view,host(view));}catch(Throwable error){failure=combine(failure,error);}
   if(frameObserverInstalled){frameObserverInstalled=false;try{Choreographer.getInstance().removeFrameCallback(frameObserver);}catch(Throwable error){failure=combine(failure,error);}}
   if(metricsInstalled){try{activity.getWindow().removeOnFrameMetricsAvailableListener(metricsObserver);metricsInstalled=false;}catch(Throwable error){failure=combine(failure,error);}}
   if(textureListenerInstalled)try{
    if(view.getSurfaceTextureListener()!=observedTextureListener)failure=combine(failure,new AssertionError("Texture listener ownership changed"));
    else view.setSurfaceTextureListener(originalTextureListener);
    textureListenerInstalled=false;
   }catch(Throwable error){failure=combine(failure,error);}
   if(sinkInstalled)try{
    if(sinkField.get(media)!=observedSink)failure=combine(failure,new AssertionError("Media sink ownership changed"));
    else sinkField.set(media,originalSink);
    sinkInstalled=false;
   }catch(Throwable error){failure=combine(failure,error);}
   if(timingObserverInstalled)try{
    PodMediaSurfaceServices.TimingObserver previous=media.setTimingObserver(originalTimingObserver);
    timingObserverInstalled=false;
    if(previous!=observedTimingObserver){media.setTimingObserver(previous);failure=combine(failure,new AssertionError("Media timing observer ownership changed"));}
   }catch(Throwable error){failure=combine(failure,error);}
   if(failure instanceof Error)throw(Error)failure;if(failure!=null)throw new Exception(failure);
   return null;
  });}catch(Throwable error){cleanupFailure=error;}
  // Flush the separate metrics thread before reading its bounded buffer.
  if(metricsThread!=null){
   try{
    measuring=false;metricsThread.quitSafely();metricsThread.join(5000);
    assertFalse("FrameMetrics thread did not stop",metricsThread.isAlive());metricsThread=null;metricsHandler=null;
   }catch(Throwable error){cleanupFailure=combine(cleanupFailure,error);}
  }
  if(cleanupFailure instanceof Error)throw(Error)cleanupFailure;if(cleanupFailure!=null)throw new Exception(cleanupFailure);
 }

 private void assertObserverHealth() throws Exception {
  if(observerFailure.get()!=null)throw new AssertionError("Observer failed",observerFailure.get());
  assertTrue("No Choreographer observations",choreographer.size>0);
  assertTrue("No TextureView update notifications",textureUpdates.size>0);
  assertTrue("No Window FrameMetrics",windowFrames.size>0);
  assertTrue("No image uploads",uploads.size()>1);
  assertTrue("Missing terminal upload",firstTerminalNs>0);
  if(renderTimingEnabled)renderTimings.assertHealthy(uploads);
  if(vulkanTimingEnabled)vulkanTimings.assertHealthy();
  Upload initial=null,intermediate=null,terminal=null;
  for(Upload sample:uploads)if(sample.handle>=0&&sample.imageReady){
   if(initial==null){assertTrue("First ready upload did not have the initial style",initial(sample.style));initial=sample;}
   if(intermediate==null&&changed(sample.style)&&!terminal(sample.style))intermediate=sample;
   if(terminal==null&&terminal(sample.style))terminal=sample;
  }
  assertNotNull("Missing initial ready image",initial);assertNotNull("No intermediate native animation style was observed",intermediate);
  assertNotNull("Missing terminal native image",terminal);
  assertTrue("Native styles were not observed in initial/intermediate/terminal order",initial.end<intermediate.begin&&intermediate.end<terminal.begin);
 }

 private JSONObject measurement() throws Exception {
  JSONArray mediaRows=new JSONArray();long firstReady=0,firstChanged=0;int readyCount=0;boolean firstReadyInitial=false;
  for(Upload sample:uploads){
   mediaRows.put(sample.json());
   if(sample.handle>=0&&sample.imageReady){
    readyCount++;if(firstReady==0){firstReady=sample.end;firstReadyInitial=initial(sample.style);}
    if(firstChanged==0&&changed(sample.style))firstChanged=sample.begin;
   }
  }
  boolean originAvailable=firstReadyInitial&&firstReady>0&&firstChanged>firstReady&&firstTerminalNs>=firstChanged;
  JSONObject origin=new JSONObject().put("available",originAvailable).put("firstReadyImageHadInitialStyle",firstReadyInitial)
   .put("lowerBoundNs",originAvailable?firstReady:JSONObject.NULL)
   .put("upperBoundNs",originAvailable?firstChanged:JSONObject.NULL)
   .put("contract","production onFrame origin lies after first ready-image CPU texture write and before first changed-style write; includes readiness polling and service latency")
   .put("exactProductionOriginObserved",false);
  if(originAvailable){
   origin.put("widthMs",ms(firstChanged-firstReady));
   origin.put("originToTerminalUploadLowerBoundMs",ms(firstTerminalNs-firstChanged));
   origin.put("originToTerminalUploadUpperBoundMs",ms(firstTerminalNs-firstReady));
  }
  JSONObject value=new JSONObject().put("clock","System.nanoTime; absolute monotonic ns, same clock for Java observers")
   .put("mountCommandBeforeNs",mountCommandBeforeNs).put("mountCommandAfterNs",mountCommandAfterNs).put("endNs",measurementEndNs)
   .put("nominalFinalChangingNativeParameterMs",Build.VERSION.SDK_INT>=31?1650:1500)
   .put("nominalContract",Build.VERSION.SDK_INT>=31?"blur ends at 1650 ms":"API 30 blur is zero; scale ends at 1500 ms, although JS elapsed caps at 1650")
   .put("animationOriginInterval",origin).put("firstTerminalUploadNs",firstTerminalNs)
   .put("readyImageWrites",readyCount).put("mediaWrites",mediaRows)
   .put("choreographer",choreographer.json(new String[]{"callbackNs","frameTimeNs"}))
   .put("textureUpdateCallbacks",textureUpdates.json(new String[]{"callbackNs"}))
   .put("windowFrameMetrics",windowFrames.json(new String[]{"callbackNs","reportsDropped","firstDraw","intendedVsyncNs","vsyncNs","totalNs","unknownDelayNs","inputNs","animationNs","layoutMeasureNs","drawNs","syncNs","commandIssueNs","swapBuffersNs","gpuNs","deadlineNs"}))
   .put("mediaStageTimings",renderTimingEnabled?renderTimings.json():new JSONObject().put("enabled",false).put("argument","-e renderTiming true"))
   .put("vulkanStageTimings",vulkanTimingEnabled?vulkanTimings.json():new JSONObject().put("enabled",false).put("argument","-e vulkanTiming true"))
   .put("choreographerGapMs",gaps(choreographer,0)).put("textureUpdateCallbackGapMs",gaps(textureUpdates,0))
   .put("windowTotalDurationMs",durations(windowFrames,5))
   .put("limits",new JSONArray(Arrays.asList(
    "Media write timing starts after HardwareRenderer/readback; it measures JNI copy/CPU texture update, not full media rendering or GPU upload completion.",
    "TextureView notifications are update callbacks, not exact buffer latch/present timestamps or displayed FPS.",
    "FrameMetrics describe Window/HWUI, not every Vulkan scene buffer. reportsDropped means lost metric reports, not dropped displayed frames.",
    "Choreographer callbacks describe main-thread scheduling, not scene changes or display presentation.",
    "No per-buffer IDs correlate these streams. Adjacent timestamps must not be treated as matching frames.",
    "Post-measurement commit and PixelCopy provide a window snapshot for offline comparison, not physical display acceptance.")));
  long dropped=0,overDeadline=0;for(int n=0;n<windowFrames.size;n++){long[] row=windowFrames.data[n];dropped+=row[1];if(row[15]>=0&&row[5]>row[15])overDeadline++;}
  value.put("windowMetricReportsDropped",dropped).put("windowFramesOverDeadline",Build.VERSION.SDK_INT>=31?overDeadline:JSONObject.NULL);
  if(firstReady>0)value.put("commandToReadyImageWriteMs",ms(firstReady-mountCommandAfterNs));
  if(firstChanged>0&&firstTerminalNs>0)value.put("firstChangedWriteToTerminalWriteMs",ms(firstTerminalNs-firstChanged));
  return value;
 }

 private JSONObject terminalNative() throws Exception {
  assertEquals("Expected one surviving QR image surface",1,sessions.size());
  PodMediaSurfaceServices.Session session=sessions.values().iterator().next();
  assertFalse(session.video);assertFalse(session.disposed);assertFalse(session.failed);assertFalse(session.imageLoading);
  assertNotNull(session.image);assertFalse(session.image.isRecycled());assertTrue(session.handle>=0);assertTrue(session.linearSampling);
  assertTrue("Production native style is not terminal",terminal(session.style));
  return new Upload(session,0,0,session.handle,session.tw,session.th,session.linearSampling).json()
   .put("observedNs",System.nanoTime()).put("host",host(view));
 }

 private JSONObject captureTerminalWindow() throws Exception {
  CountDownLatch committed=new CountDownLatch(1);long[] commitNs={0};
  Runnable callback=()->{commitNs[0]=System.nanoTime();committed.countDown();};
  onMain(()->{activity.getWindow().getDecorView().getViewTreeObserver().registerFrameCommitCallback(callback);
   // Explicit post-measurement HWUI invalidation; no extra Pod nativeFrame.
   activity.getWindow().getDecorView().invalidate();return null;});
  try{assertTrue("Post-measurement Window commit timed out",committed.await(5,TimeUnit.SECONDS));}
  finally{onMain(()->{if(activity.getWindow().getDecorView().getViewTreeObserver().isAlive())activity.getWindow().getDecorView().getViewTreeObserver().unregisterFrameCommitCallback(callback);return null;});}
  long requested=System.nanoTime();Bitmap bitmap=windowBitmap();long completed=System.nanoTime();
  try {
   String name="beian-performance-"+runNonce+"-terminal-window.png";
   File file=new File(context.getFilesDir(),name);
   try(FileOutputStream output=new FileOutputStream(file)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,output));}
   return new JSONObject().put("file",name).put("width",bitmap.getWidth()).put("height",bitmap.getHeight())
    .put("windowCommitCallbackNs",commitNs[0]).put("pixelCopyRequestedNs",requested).put("pixelCopyCompletedNs",completed)
    .put("terminalUploadToCopyCompletedMs",ms(completed-firstTerminalNs)).put("pngSha256",sha(Files.readAllBytes(file.toPath())))
    .put("pixelArgb32BeSha256",shaBitmap(bitmap)).put("postMeasurementInvalidation",true)
    .put("terminalGoldenComparisonRequired",true).put("terminalPixelContentVerified",false)
    .put("physicalDisplayPresentVerified",false).put("nativeStyleAfterCapture",onMain(()->terminalNative()));
  }finally{bitmap.recycle();}
 }

 private Bitmap windowBitmap() throws Exception {
  Bitmap bitmap=onMain(()->Bitmap.createBitmap(activity.getWindow().getDecorView().getWidth(),activity.getWindow().getDecorView().getHeight(),Bitmap.Config.ARGB_8888));
  CountDownLatch latch=new CountDownLatch(1);AtomicInteger result=new AtomicInteger(PixelCopy.ERROR_UNKNOWN);
  Object ownership=new Object();boolean[] submitted={false},finished={false},abandoned={false};
  try {
   onMain(()->{PixelCopy.request(activity.getWindow(),bitmap,code->{
    synchronized(ownership){result.set(code);finished[0]=true;if(abandoned[0])bitmap.recycle();}latch.countDown();
   },new Handler(Looper.getMainLooper()));synchronized(ownership){submitted[0]=true;}return null;});
   assertTrue("Window PixelCopy timed out",latch.await(5,TimeUnit.SECONDS));assertEquals("Window PixelCopy failed",PixelCopy.SUCCESS,result.get());return bitmap;
  }catch(Exception|Error error){synchronized(ownership){if(!submitted[0]||finished[0])bitmap.recycle();else abandoned[0]=true;}throw error;}
 }

 private JSONObject platform() throws Exception {return onMain(()->new JSONObject().put("package",context.getPackageName()).put("sdkInt",Build.VERSION.SDK_INT)
  .put("manufacturer",Build.MANUFACTURER).put("model",Build.MODEL).put("fontScale",activity.getResources().getConfiguration().fontScale)
  .put("requestedRunnerFontScale",InstrumentationRegistry.getArguments().getString("fontScale"))
  .put("density",activity.getResources().getDisplayMetrics().density).put("densityDpi",activity.getResources().getDisplayMetrics().densityDpi)
  .put("windowWidth",activity.getWindow().getDecorView().getWidth()).put("windowHeight",activity.getWindow().getDecorView().getHeight())
  .put("refreshRateHz",view.getDisplay().getRefreshRate()).put("activityIdentity",System.identityHashCode(activity)).put("nativeHost",host(view))
  .put("globalFontInvariantOwner","existing isolated PodFontScaleRunner validates Activity override and unchanged global Resources/settings")
  .put("geometryOracle","none; actual native viewport and POT dimensions are recorded for this font scale"));}

 private JSONObject finish() throws Exception {
  if(activity==null)return new JSONObject().put("activityLaunched",false);
  Activity previous=activity;PodRuntimeView previousView=view;
  onMain(()->{if(!previous.isDestroyed())previous.finish();return null;});
  long deadline=SystemClock.uptimeMillis()+15_000;
  while(SystemClock.uptimeMillis()<deadline){
   if(onMain(()->previous.isDestroyed()&&(previousView==null||host(previousView)==0))){
    Files.deleteIfExists(commandFile().toPath());Files.deleteIfExists(new File(commandFile().getParentFile(),commandFile().getName()+".tmp").toPath());
    activity=null;view=null;
    return new JSONObject().put("activityLaunched",true).put("activityDestroyed",true).put("nativeHostReleased",true)
     .put("observersDetached",!sinkInstalled&&!textureListenerInstalled&&!frameObserverInstalled&&!metricsInstalled&&!timingObserverInstalled
      &&(vulkanTimings==null||!vulkanTimings.started||vulkanTimings.stopReturned))
     .put("vulkanTimingRequested",vulkanTimingEnabled).put("vulkanTimingStopAttempted",vulkanTimings!=null&&vulkanTimings.stopAttempted)
     .put("vulkanTimingSnapshotCaptured",vulkanTimings!=null&&vulkanTimings.snapshot!=null)
     .put("metricsThreadStopped",metricsThread==null).put("ownCommandRemoved",true);
   }SystemClock.sleep(25);
  }throw new AssertionError("Owned Activity/native host did not release after finish");
 }

 private JSONObject readFixture(){try{lastFixture=new JSONObject(new String(Files.readAllBytes(kvFile().toPath()),StandardCharsets.UTF_8)).optJSONObject(RESULT);lastReadError=null;return lastFixture;}catch(Exception error){lastReadError=error.toString();return null;}}
 private File kvFile(){return new File(context.getFilesDir(),"podjs/podjs-kv.json");}
 private File commandFile(){return new File(context.getFilesDir(),"podjs/files/beian-performance-command.json");}
 private void writeProof(JSONObject proof)throws Exception{
  File target=new File(context.getFilesDir(),"beian-performance-proof.json"),temporary=new File(context.getFilesDir(),"beian-performance-proof.json.tmp");
  Files.write(temporary.toPath(),proof.toString(2).getBytes(StandardCharsets.UTF_8));Files.move(temporary.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING);
 }
 private long host(PodRuntimeView value)throws Exception{return hostField.getLong(value);}
 private static Field field(Class<?> owner,String name)throws Exception{Field result=owner.getDeclaredField(name);result.setAccessible(true);return result;}
 private <T>T onMain(Callable<T> action)throws Exception{AtomicReference<T> result=new AtomicReference<>();AtomicReference<Throwable> failure=new AtomicReference<>();instrumentation.runOnMainSync(()->{try{result.set(action.call());}catch(Throwable error){failure.set(error);}});if(failure.get() instanceof Error)throw(Error)failure.get();if(failure.get()!=null)throw new Exception(failure.get());return result.get();}
 private static PodRuntimeView find(View node){if(node instanceof PodRuntimeView)return(PodRuntimeView)node;if(node instanceof ViewGroup)for(int n=0;n<((ViewGroup)node).getChildCount();n++){PodRuntimeView result=find(((ViewGroup)node).getChildAt(n));if(result!=null)return result;}return null;}
 private static Throwable combine(Throwable first,Throwable next){if(first==null)return next;if(first!=next)first.addSuppressed(next);return first;}
 private static boolean terminal(PodMediaSurfaceServices.Style style){return style.presentationFrame!=null&&style.presentationFrame.scale==1f&&style.presentationFrame.opacity==1f&&style.blur==0f&&style.brightnessBias==0f&&style.overlayOpacity==0f;}
 private static boolean initial(PodMediaSurfaceServices.Style style){return style.presentationFrame!=null&&style.presentationFrame.scale==1.16f&&style.presentationFrame.opacity==.12f;}
 private static boolean changed(PodMediaSurfaceServices.Style style){return style.presentationFrame!=null&&(style.presentationFrame.scale<1.16f||style.presentationFrame.opacity>.12f);}
 private static double ms(long ns){return ns/1_000_000.;}
 private static JSONObject gaps(Rows rows,int column)throws Exception{double[] values=new double[Math.max(0,rows.size-1)];for(int n=1;n<rows.size;n++)values[n-1]=ms(rows.data[n][column]-rows.data[n-1][column]);return distribution(values);}
 private static JSONObject durations(Rows rows,int column)throws Exception{double[] values=new double[rows.size];for(int n=0;n<rows.size;n++)values[n]=ms(rows.data[n][column]);return distribution(values);}
 private static JSONObject distribution(double[] values)throws Exception{JSONObject out=new JSONObject().put("count",values.length);if(values.length==0)return out;Arrays.sort(values);return out.put("p50",values[(int)Math.ceil(values.length*.50)-1]).put("p95",values[(int)Math.ceil(values.length*.95)-1]).put("p99",values[(int)Math.ceil(values.length*.99)-1]).put("max",values[values.length-1]);}
 private static String shaBitmap(Bitmap bitmap)throws Exception{int[] pixels=new int[bitmap.getWidth()*bitmap.getHeight()];bitmap.getPixels(pixels,0,bitmap.getWidth(),0,0,bitmap.getWidth(),bitmap.getHeight());ByteBuffer bytes=ByteBuffer.allocate(pixels.length*4).order(ByteOrder.BIG_ENDIAN);bytes.asIntBuffer().put(pixels);return sha(bytes.array());}
 private static String sha(byte[] bytes)throws Exception{byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes);StringBuilder result=new StringBuilder();for(byte value:digest){result.append(Character.forDigit((value>>4)&15,16));result.append(Character.forDigit(value&15,16));}return result.toString();}

 private static final class Rows {
  final long[][] data;int size;
  Rows(int columns){data=new long[LIMIT][columns];}
  void add(long...values){if(size>=data.length)throw new AssertionError("Frame observation buffer overflowed");System.arraycopy(values,0,data[size++],0,values.length);}
  JSONObject json(String[] columns)throws Exception{JSONArray rows=new JSONArray();for(int n=0;n<size;n++)rows.put(new JSONArray(data[n]));return new JSONObject().put("columns",new JSONArray(Arrays.asList(columns))).put("rows",rows);}
 }
 /** Native owns bounded primitive storage during measurement. Java invokes only
  * begin before measuring, and end once after measuring; serialization is cold. */
 private static final class VulkanTimings {
  static final int CAPACITY=4096,HEADER_COUNT=7,COLUMN_COUNT=15;
  static final int VERSION=0,FIELD_COUNT=1,CAPACITY_FIELD=2,COUNT=3,DROPPED=4,START_NS=5,STOP_NS=6;
  static final int SEQUENCE=0,HOST_FRAME_SEQUENCE=1,RENDERER_FRAME_SERIAL=2,STAGE=3,BEGIN_NS=4,END_NS=5,OUTCOME=6,RESULT_CODE=7,
   TEXTURE_KEY=8,REVISION=9,WIDTH=10,HEIGHT=11,BYTES=12,ITEM_COUNT=13,FLAGS=14;
  static final int[] STAGE_CODES={1,2,3,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27};
  static final String[] STAGE_NAMES={"hostFrame","guest","snapshot","drawList","decode","uploadImages","uploadPriorFenceWait","createTexture",
   "stagingCopy","uploadRecord","uploadSubmit","uploadFenceWait","frameFenceWait","acquireImage","sceneRecord","frameSubmit","present",
   "destroyTexture","cacheHit","uploadCommitted","stagingCapacity","cpuFrame"};
  static final String[] HEADER_NAMES={"schemaVersion","fieldCount","capacity","count","dropped","nativeStartNs","nativeStopNs"};
  static final String[] COLUMN_NAMES={"sequence","hostFrameSequence","rendererFrameSerial","stage","beginNs","endNs","outcome","resultCode",
   "textureKey","revision","width","height","bytes","count","flags"};
  boolean started,stopAttempted,stopReturned,validated,clockBracketsConfirmed;
  long ownerHost,stopHost,beginCallBeforeNs,beginCallAfterNs,endCallBeforeNs,endCallAfterNs;
  long[] snapshot;
  String stopError;
  void begin(PodRuntimeView view,long host){
   assertFalse("Vulkan stage timing already started",started);
   assertTrue("Vulkan stage timing requires a live host",host!=0);
   ownerHost=host;beginCallBeforeNs=System.nanoTime();
   try{view.beginRendererTiming(CAPACITY);started=true;}finally{beginCallAfterNs=System.nanoTime();}
  }
  void stop(PodRuntimeView view,long host){
   assertTrue("Vulkan stage timing was never started",started);
   assertFalse("Vulkan stage timing stop may only be attempted once",stopAttempted);
   stopAttempted=true;stopHost=host;endCallBeforeNs=System.nanoTime();
   try{
    // The SDK clears ownership before checking HostLifetime and never passes
    // a destroyed/replaced host pointer to JNI. Native disables before copying.
    snapshot=view.endRendererTiming();stopReturned=true;
   }catch(Throwable error){stopError=error.toString();throw error;}
   finally{endCallAfterNs=System.nanoTime();}
  }
  void assertHealthy(){
   assertTrue("Vulkan stage timing was not started",started);
   assertTrue("Vulkan stage timing stop was not attempted",stopAttempted);
   assertTrue("Vulkan stage timing stop did not return",stopReturned);
   assertEquals("Vulkan stage timing host changed",ownerHost,stopHost);
   assertNotNull("Vulkan stage timing snapshot is missing",snapshot);
   assertTrue("Vulkan stage timing header is truncated",snapshot.length>=HEADER_COUNT);
   assertEquals("Vulkan stage timing schema version changed",1,snapshot[VERSION]);
   assertEquals("Vulkan stage timing column count changed",COLUMN_COUNT,snapshot[FIELD_COUNT]);
   assertEquals("Vulkan stage timing capacity changed",CAPACITY,snapshot[CAPACITY_FIELD]);
   long count=snapshot[COUNT];
   assertTrue("Vulkan stage timing count is invalid",count>0&&count<=CAPACITY);
   assertEquals("Vulkan stage timing snapshot length is invalid",HEADER_COUNT+count*COLUMN_COUNT,snapshot.length);
   assertEquals("Vulkan stage timing buffer overflowed",0,snapshot[DROPPED]);
   clockBracketsConfirmed=beginCallBeforeNs<=snapshot[START_NS]&&snapshot[START_NS]<=beginCallAfterNs
    &&endCallBeforeNs<=snapshot[STOP_NS]&&snapshot[STOP_NS]<=endCallAfterNs;
   assertTrue("Native CLOCK_MONOTONIC does not fit the Java begin/end call brackets",clockBracketsConfirmed);
   assertTrue("Native timing interval is reversed",snapshot[START_NS]<=snapshot[STOP_NS]);
   int hostFrames=0,rendererRows=0;
   java.util.HashMap<Long,long[]> frames=new java.util.HashMap<>();
   for(int row=0;row<count;row++){
    int offset=HEADER_COUNT+row*COLUMN_COUNT;
    assertEquals("Vulkan stage event reservation sequence is not continuous",row+1,snapshot[offset+SEQUENCE]);
    assertTrue("Vulkan stage host frame sequence is invalid",snapshot[offset+HOST_FRAME_SEQUENCE]>=0);
    assertTrue("Vulkan stage renderer serial is invalid",snapshot[offset+RENDERER_FRAME_SERIAL]>=0);
    long begin=snapshot[offset+BEGIN_NS],end=snapshot[offset+END_NS],stage=snapshot[offset+STAGE];
    assertTrue("Vulkan stage timestamp is missing or outside its native interval",snapshot[START_NS]<=begin&&begin<=end&&end<=snapshot[STOP_NS]);
    boolean known=false;for(int code:STAGE_CODES)if(stage==code){known=true;break;}
    assertTrue("Unknown Vulkan stage code",known);
    assertTrue("Unknown Vulkan stage outcome",snapshot[offset+OUTCOME]==1||snapshot[offset+OUTCOME]==-1);
    if(stage==1){
     hostFrames++;assertTrue("Host frame sequence must be nonzero",snapshot[offset+HOST_FRAME_SEQUENCE]>0);
     assertNull("Duplicate host frame sequence",frames.put(snapshot[offset+HOST_FRAME_SEQUENCE],new long[]{begin,end}));
    }else if(stage>=9)rendererRows++;
   }
   assertTrue("No nativeFrame stage observations",hostFrames>0);
   assertTrue("No Vulkan renderer stage observations",rendererRows>0);
   for(int row=0;row<count;row++){
    int offset=HEADER_COUNT+row*COLUMN_COUNT;long frame=snapshot[offset+HOST_FRAME_SEQUENCE];
    if(frame==0)continue; // Resize/detach work may be outside a nativeFrame.
    long[] scope=frames.get(frame);assertNotNull("Stage refers to an unrecorded host frame",scope);
    assertTrue("Stage lies outside its nativeFrame scope",scope[0]<=snapshot[offset+BEGIN_NS]&&snapshot[offset+END_NS]<=scope[1]);
   }
   validated=true;
  }
  JSONObject json()throws Exception{
   JSONObject out=new JSONObject().put("enabled",true).put("argument","-e vulkanTiming true")
    .put("started",started).put("stopAttempted",stopAttempted).put("stopReturned",stopReturned)
    .put("snapshotCaptured",snapshot!=null).put("validated",validated).put("capacityRequested",CAPACITY)
    .put("nativePrimitiveRecordBytes",(long)CAPACITY*COLUMN_COUNT*Long.BYTES)
    .put("ownerHost",ownerHost).put("stopHost",stopHost).put("beginCallBeforeNs",beginCallBeforeNs).put("beginCallAfterNs",beginCallAfterNs)
    .put("endCallBeforeNs",endCallBeforeNs).put("endCallAfterNs",endCallAfterNs)
    .put("noNativeGettersDuringMeasurement",true).put("extraNativeFramesRequested",false)
    .put("nativeClock","CLOCK_MONOTONIC ns").put("javaClock","System.nanoTime ns").put("clockBracketsConfirmed",clockBracketsConfirmed);
   if(stopError!=null)out.put("stopError",stopError);
   if(snapshot!=null){
    // Preserve malformed/partial evidence even if structural health checks fail.
    if(snapshot.length<HEADER_COUNT||snapshot[VERSION]!=1||snapshot[FIELD_COUNT]!=COLUMN_COUNT||snapshot[COUNT]<0
     ||snapshot[COUNT]>CAPACITY||HEADER_COUNT+snapshot[COUNT]*COLUMN_COUNT!=snapshot.length)out.put("rawSnapshot",new JSONArray(snapshot));
    else{
     JSONObject header=new JSONObject(),codes=new JSONObject(),stageCounts=new JSONObject();JSONArray rows=new JSONArray(),durations=new JSONArray();
     for(int index=0;index<HEADER_COUNT;index++)header.put(HEADER_NAMES[index],snapshot[index]);
     for(int index=0;index<STAGE_CODES.length;index++)codes.put(STAGE_NAMES[index],STAGE_CODES[index]);
     for(int row=0;row<snapshot[COUNT];row++){
      int offset=HEADER_COUNT+row*COLUMN_COUNT;JSONArray values=new JSONArray();
      for(int column=0;column<COLUMN_COUNT;column++)values.put(snapshot[offset+column]);rows.put(values);
      long begin=snapshot[offset+BEGIN_NS],end=snapshot[offset+END_NS];durations.put(begin>0&&end>=begin?end-begin:JSONObject.NULL);
     }
     for(int index=0;index<STAGE_CODES.length;index++){
      int success=0,failure=0,unknown=0;for(int row=0;row<snapshot[COUNT];row++){
       int offset=HEADER_COUNT+row*COLUMN_COUNT;if(snapshot[offset+STAGE]==STAGE_CODES[index]){
        if(snapshot[offset+OUTCOME]==1)success++;else if(snapshot[offset+OUTCOME]==-1)failure++;else unknown++;
       }
      }
      stageCounts.put(STAGE_NAMES[index],new JSONObject().put("success",success).put("failure",failure).put("unknown",unknown));
     }
     out.put("header",header).put("columns",new JSONArray(Arrays.asList(COLUMN_NAMES))).put("rows",rows).put("durationNs",durations)
      .put("stageCodes",codes).put("stageCounts",stageCounts)
      .put("outcomeCodes",new JSONObject().put("success",1).put("failure",-1)).put("unfinishedResultCode",Long.MIN_VALUE)
      .put("flagBits",new JSONObject().put("linear",0).put("coverage",1).put("existing",2).put("white",3)
       .put("hostFrameGpuSubmitted",16).put("hostFrameCpuSubmitted",17));
    }
   }
   out.put("limits",new JSONArray(Arrays.asList(
    "Events reserve rows at begin and fill their end later; reservation sequence order is not completion order.",
    "Join through hostFrameSequence. rendererFrameSerial may be zero and decode may precede its increment; it is not a universal parent ID.",
    "Stage scopes are nested and may repeat per texture; durations must not be summed as disjoint frame costs.",
    "CPU wall times include driver waits. Vulkan present call success is not a physical panel timestamp or acceptance of smoothness.",
    "Outcome failure and raw resultCode are retained as diagnostic evidence; shader/backend work may fall back to CPU.",
    "Zero hostFrameSequence denotes work outside nativeFrame; no per-buffer ID links these events to TextureView or Window callbacks.",
    "The bounded native buffer is allocated before measuring and disabled before one cold snapshot copy; no native getters or extra nativeFrames occur during measurement.",
    "Native/Java timestamp comparability is checked only by the begin/end call brackets; observer and timing overhead remain uncalibrated.")));
   return out;
  }
 }
 /** Allocated only with -e renderTiming true, before mounting the production screen.
  * The observer copies borrowed arrays synchronously and allocates nothing per sample. */
 private static final class RenderTimings {
  final long[] data=new long[LIMIT*Timing.FIELD_COUNT];
  final String[] sessionIds=new String[LIMIT];
  final int[] kinds=new int[LIMIT];
  int size;
  void copy(String sessionId,int kind,long[] values){
   if(size>=LIMIT)throw new AssertionError("Media stage timing buffer overflowed");
   if(values==null||values.length!=Timing.FIELD_COUNT)throw new AssertionError("Media stage timing schema changed");
   if(kind!=Timing.DISPATCH&&kind!=Timing.RENDER)throw new AssertionError("Unknown media stage timing kind");
   System.arraycopy(values,0,data,size*Timing.FIELD_COUNT,Timing.FIELD_COUNT);
   sessionIds[size]=sessionId;kinds[size]=kind;size++;
  }
  void assertHealthy(List<Upload> uploads){
   int dispatches=0,renders=0;
   long lastDispatch=0,lastRender=0;
   int[] renderFields={Timing.BEGIN_NS,Timing.RECORD_BEGIN_NS,Timing.RECORD_END_NS,Timing.DRAW_BEGIN_NS,Timing.DRAW_END_NS,
    Timing.ACQUIRE_BEGIN_NS,Timing.ACQUIRE_END_NS,Timing.COPY_BEGIN_NS,Timing.COPY_END_NS,Timing.PIXELS_BEGIN_NS,Timing.PIXELS_END_NS,
    Timing.CLEANUP_BEGIN_NS,Timing.CLEANUP_END_NS,Timing.SINK_BEGIN_NS,Timing.SINK_END_NS,Timing.END_NS};
   java.util.HashSet<Long> dispatchIds=new java.util.HashSet<>();
   for(int row=0;row<size;row++){
    int offset=row*Timing.FIELD_COUNT;long sequence=data[offset+Timing.SEQUENCE];
    assertNotNull("Media stage sample has no session ID",sessionIds[row]);
    assertFalse("Media stage sample has empty session ID",sessionIds[row].isEmpty());
    assertTrue("Media stage timestamps out of order",data[offset+Timing.BEGIN_NS]>0&&data[offset+Timing.END_NS]>=data[offset+Timing.BEGIN_NS]);
    assertEquals("Media stage operation failed",Timing.OK,data[offset+Timing.OUTCOME]);
    assertEquals("Successful media stage marked failed",0,data[offset+Timing.FAILED_STAGE]);
    if(kinds[row]==Timing.DISPATCH){
     assertTrue("Dispatch sequence is not increasing",sequence>lastDispatch);lastDispatch=sequence;dispatches++;dispatchIds.add(sequence);
     assertEquals("Dispatch self ID mismatch",sequence,data[offset+Timing.DISPATCH_SEQUENCE]);
     assertTrue("Dispatch queue timestamps invalid",data[offset+Timing.ENQUEUED_NS]>0&&data[offset+Timing.ENQUEUED_NS]<=data[offset+Timing.BEGIN_NS]);
     assertTrue("Dispatch completion timestamps invalid",data[offset+Timing.BEGIN_NS]<=data[offset+Timing.WORK_END_NS]
      &&data[offset+Timing.WORK_END_NS]<=data[offset+Timing.COMPLETE_BEGIN_NS]&&data[offset+Timing.COMPLETE_BEGIN_NS]<=data[offset+Timing.COMPLETE_END_NS]
      &&data[offset+Timing.COMPLETE_END_NS]<=data[offset+Timing.END_NS]);
    }else{
     assertTrue("Render sequence is not increasing",sequence>lastRender);lastRender=sequence;
     long previous=0;for(int field:renderFields){long value=data[offset+field];assertTrue("Successful render stage missing or out of order",value>0&&value>=previous);previous=value;}
     assertTrue("Render timing has no corresponding sink observation",renders<uploads.size());Upload upload=uploads.get(renders++);
     assertEquals("Render/sink session mismatch",upload.id,sessionIds[row]);
     assertEquals("Render/sink decode revision mismatch",upload.decodeRevision,data[offset+Timing.DECODE_REVISION]);
     assertEquals("Render/sink output handle mismatch",upload.handle,data[offset+Timing.HANDLE_AFTER]);
     assertTrue("Render does not enclose its synchronous JNI sink call",data[offset+Timing.SINK_BEGIN_NS]<=upload.begin&&upload.end<=data[offset+Timing.SINK_END_NS]);
    }
   }
   assertTrue("No media dispatch timing observations",dispatches>0);
   assertTrue("No media render timing observations",renders>0);
   assertEquals("Not every sink observation has a render timing record",uploads.size(),renders);
   for(int row=0;row<size;row++)if(kinds[row]==Timing.RENDER)
    assertTrue("Image render refers to an unobserved initiating dispatch",dispatchIds.contains(data[row*Timing.FIELD_COUNT+Timing.DISPATCH_SEQUENCE]));
  }
  JSONObject json()throws Exception{
   String[] columns=new String[Timing.FIELD_COUNT];
   columns[Timing.SEQUENCE]="sequence";columns[Timing.DISPATCH_SEQUENCE]="dispatchSequence";columns[Timing.CAUSE]="cause";
   columns[Timing.HANDLE_BEFORE]="handleBefore";columns[Timing.HANDLE_AFTER]="handleAfter";columns[Timing.DECODE_REVISION]="decodeRevision";
   columns[Timing.WIDTH]="contentWidth";columns[Timing.HEIGHT]="contentHeight";columns[Timing.TEXTURE_WIDTH]="textureWidth";columns[Timing.TEXTURE_HEIGHT]="textureHeight";
   columns[Timing.ENQUEUED_NS]="enqueuedNs";columns[Timing.BEGIN_NS]="beginNs";columns[Timing.END_NS]="endNs";
   columns[Timing.RECORD_BEGIN_NS]="recordBeginNs";columns[Timing.RECORD_END_NS]="recordEndNs";
   columns[Timing.DRAW_BEGIN_NS]="drawBeginNs";columns[Timing.DRAW_END_NS]="drawEndNs";
   columns[Timing.ACQUIRE_BEGIN_NS]="acquireBeginNs";columns[Timing.ACQUIRE_END_NS]="acquireEndNs";
   columns[Timing.COPY_BEGIN_NS]="copyBeginNs";columns[Timing.COPY_END_NS]="copyEndNs";
   columns[Timing.PIXELS_BEGIN_NS]="pixelsBeginNs";columns[Timing.PIXELS_END_NS]="pixelsEndNs";
   columns[Timing.CLEANUP_BEGIN_NS]="cleanupBeginNs";columns[Timing.CLEANUP_END_NS]="cleanupEndNs";
   columns[Timing.SINK_BEGIN_NS]="sinkBeginNs";columns[Timing.SINK_END_NS]="sinkEndNs";
   columns[Timing.WORK_END_NS]="workEndNs";columns[Timing.COMPLETE_BEGIN_NS]="completeBeginNs";columns[Timing.COMPLETE_END_NS]="completeEndNs";
   columns[Timing.FAIL_BEGIN_NS]="failBeginNs";columns[Timing.FAIL_END_NS]="failEndNs";
   columns[Timing.OUTCOME]="outcome";columns[Timing.FAILED_STAGE]="failedStage";
   for(String column:columns)assertNotNull("Unmapped media stage timing column",column);
   String[] durationColumns={"queueNs","totalNs","workNs","completeNs","failNs","recordNs","drawNs","acquireNs","copyNs","pixelsNs","cleanupNs","sinkNs"};
   int[][] pairs={{Timing.ENQUEUED_NS,Timing.BEGIN_NS},{Timing.BEGIN_NS,Timing.END_NS},{Timing.BEGIN_NS,Timing.WORK_END_NS},
    {Timing.COMPLETE_BEGIN_NS,Timing.COMPLETE_END_NS},{Timing.FAIL_BEGIN_NS,Timing.FAIL_END_NS},
    {Timing.RECORD_BEGIN_NS,Timing.RECORD_END_NS},{Timing.DRAW_BEGIN_NS,Timing.DRAW_END_NS},
    {Timing.ACQUIRE_BEGIN_NS,Timing.ACQUIRE_END_NS},{Timing.COPY_BEGIN_NS,Timing.COPY_END_NS},
    {Timing.PIXELS_BEGIN_NS,Timing.PIXELS_END_NS},{Timing.CLEANUP_BEGIN_NS,Timing.CLEANUP_END_NS},{Timing.SINK_BEGIN_NS,Timing.SINK_END_NS}};
   JSONArray rows=new JSONArray();
   for(int row=0;row<size;row++){
    int offset=row*Timing.FIELD_COUNT;JSONArray values=new JSONArray(),durations=new JSONArray();
    for(int column=0;column<Timing.FIELD_COUNT;column++)values.put(data[offset+column]);
    for(int[] pair:pairs){long begin=data[offset+pair[0]],end=data[offset+pair[1]];durations.put(begin>0&&end>=begin?end-begin:JSONObject.NULL);}
    rows.put(new JSONObject().put("sessionId",sessionIds[row]).put("kind",kinds[row]).put("values",values).put("durationsNs",durations));
   }
   return new JSONObject().put("enabled",true).put("argument","-e renderTiming true").put("schemaVersion",1)
    .put("clock","System.nanoTime; CPU wall time, ns").put("capacity",LIMIT).put("count",size)
    .put("primitiveBufferBytes",(long)LIMIT*(Timing.FIELD_COUNT*Long.BYTES+Integer.BYTES))
    .put("sessionReferenceSlots",LIMIT).put("columns",new JSONArray(Arrays.asList(columns)))
    .put("durationColumns",new JSONArray(Arrays.asList(durationColumns))).put("rows",rows)
    .put("kindCodes",new JSONObject().put("dispatch",Timing.DISPATCH).put("render",Timing.RENDER))
    .put("dispatchCauseCodes",new JSONObject().put("open",Timing.OPEN).put("update",Timing.UPDATE).put("state",Timing.STATE).put("close",Timing.CLOSE).put("other",Timing.OTHER))
    .put("renderCauseCodes",new JSONObject().put("initial",Timing.INITIAL).put("decode",Timing.DECODE).put("style",Timing.STYLE).put("videoFrame",Timing.VIDEO_FRAME).put("videoState",Timing.VIDEO_STATE))
    .put("outcomeCodes",new JSONObject().put("ok",Timing.OK).put("exception",Timing.EXCEPTION).put("sinkRejected",Timing.SINK_REJECTED))
    .put("failedStageCodes",new JSONObject().put("none",0).put("record",Timing.RECORD_STAGE).put("draw",Timing.DRAW_STAGE).put("acquire",Timing.ACQUIRE_STAGE).put("copy",Timing.COPY_STAGE).put("pixels",Timing.PIXELS_STAGE).put("cleanup",Timing.CLEANUP_STAGE).put("sink",Timing.SINK_STAGE))
    .put("limits",new JSONArray(Arrays.asList("Borrowed arrays are copied synchronously; JSON and duration calculation occur after observers stop.",
     "Timestamp zero means a stage was not reached or is inapplicable; missing durations are null.",
     "Sequence spaces are separate for dispatch and render. dispatchSequence links renders to an initiating dispatch; decode completion can occur later.",
     "Render sink timing includes the existing delegated sink observer bookkeeping; mediaWrites times only its original JNI sink call.",
     "Timing overhead is uncalibrated; stage durations are CPU wall times and can include waiting, not GPU execution or physical presentation.",
     "Dispatch work contains synchronous render work; nested durations must not be summed as independent costs.")));
  }
 }
 private static final class Upload {
  final String id;final long begin,end,decodeRevision;final int handle,width,height,tw,th,imageWidth,imageHeight;final boolean imageReady,linear;final PodMediaSurfaceServices.Style style;
  Upload(PodMediaSurfaceServices.Session session,long begin,long end,int handle,int tw,int th,boolean linear){
   id=session.id;this.begin=begin;this.end=end;this.handle=handle;this.tw=tw;this.th=th;this.linear=linear;style=session.style;
   width=session.width;height=session.height;decodeRevision=session.revision;
   imageReady=!session.imageLoading&&!session.failed&&!session.disposed&&session.image!=null&&!session.image.isRecycled();
   imageWidth=imageReady?session.image.getWidth():0;imageHeight=imageReady?session.image.getHeight():0;
  }
  JSONObject json()throws Exception{
   PodMediaSurfaceServices.PresentationFrame frame=style.presentationFrame;
   Object presentation=frame==null?JSONObject.NULL:new JSONObject().put("leftPx",frame.left).put("topPx",frame.top).put("widthPx",frame.width).put("heightPx",frame.height).put("scale",frame.scale).put("opacity",frame.opacity);
   return new JSONObject().put("id",id).put("writeBeginNs",begin).put("writeEndNs",end).put("jniCpuTextureWriteMs",ms(end-begin))
    .put("texture",handle).put("contentWidth",width).put("contentHeight",height).put("textureWidth",tw).put("textureHeight",th)
    .put("cpuTextureBytes",(long)tw*th*4).put("viewportPixels",(long)width*height).put("textureSampling",linear?"linear":"nearest")
    .put("imageReady",imageReady).put("imageWidth",imageWidth).put("imageHeight",imageHeight).put("decodeRevision",decodeRevision)
    .put("style",new JSONObject().put("presentationFrame",presentation).put("blurPx",style.blur).put("brightnessBias",style.brightnessBias)
     .put("overlayOpacity",style.overlayOpacity).put("brightness",style.brightness).put("saturation",style.saturation).put("fit",style.fit)
     .put("blurEdgeMode",style.blurEdgeMode).put("active",style.active).put("baseArgb",style.base).put("overlayArgb",style.overlay));
  }
 }
}
