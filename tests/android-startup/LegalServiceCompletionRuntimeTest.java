package dev.podjs.runtime;

import static org.junit.Assert.*;
import static dev.podjs.runtime.StartupRuntimeTest.*;
import static dev.podjs.runtime.LegalTopRestorationRuntimeTest.*;

import android.app.Activity;
import android.app.Application;
import android.graphics.SurfaceTexture;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Choreographer;
import android.view.TextureView;
import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** A controlled frame boundary verifies real foreground service completion.
 * The second case observes one naturally scheduled immediate response. Neither
 * case drives frames or flushes Activity state during its protected interval. */
public final class LegalServiceCompletionRuntimeTest {
 @Test public void controlledForegroundServiceChainCompletesBeforeFirstFrame()throws Exception {exercise(true);}
 @Test public void naturalImmediateResponseClassifiesWithoutSemanticPolling()throws Exception {exercise(false);}

 private void exercise(boolean controlled)throws Exception {
  String name=controlled?"controlled":"natural";
  Session s=new Session("service-completion-"+name,false,!controlled);
  String prefix="legal-service-completion-"+name;
  JSONObject proof=s.proof;Recreation recreation=null;Throwable problem=null;
  try{
   proof.put("case",name).put("controlledFrameScheduling",controlled).put("naturalTimingPerformanceVerified",false)
    .put("noSemanticPollingDuringProtectedInterval",true).put("noActivityStateGettersDuringProtectedInterval",true)
    .put("noTestInvokedServicePumpDuringProtectedInterval",true).put("noTestInvokedNativeFrameDuringProtectedInterval",true)
    .put("frameProbeUsesFixtureKVAndMayAffectScheduling",true)
    .put("claimScope",controlled?"Real service chain completed with the SDK frame callback paused before its first frame":"One natural immediate-HTTP event branch under fixture instrumentation; no timing or performance claim");
   startWithFrameProbe(s);
   JSONObject topSample=s.stableBaseline(false),topPoint=topSample.getJSONObject("checkpoint");
   JSONArray topGeometry=topSample.getJSONArray("geometry");
   proof.put("initialTop",topPoint).put("initialTopGeometry",topGeometry);capture(s,prefix,"initial-top");
   s.h.performAction("协议正文",2);s.h.performAction("协议正文",2);
   JSONObject sample=s.stableBaseline(true),before=sample.getJSONObject("checkpoint");
   JSONArray beforeGeometry=sample.getJSONArray("geometry");
   String scrolledParagraph=visibleParagraph(beforeGeometry),topParagraph=visibleParagraph(topGeometry);
   assertFalse(sameCustomizationGeometry(topGeometry,beforeGeometry,1));
   proof.put("beforeRecreation",before).put("beforeGeometry",beforeGeometry).put("visibleBodyParagraphBefore",scrolledParagraph).put("semanticForwardScrolls",2)
    .put("observedMatchesPreviouslyReportedAnchor7_155",anchor(before).getLong("index")==7&&anchor(before).getLong("offsetPx")==155)
    .put("anchorExpectation","Exact observed canonical anchor is compared across recreation; index 7 / offset 155 is not assumed across device text environments");
   capture(s,prefix,"scrolled-before");s.assertKV();

   recreation=new Recreation(s,before,controlled);recreation.perform();
   // All calls until response-applied is observed are passive file/server/raw
   // field reads. In particular Session.awaitEvent() is forbidden here because
   // its semantic pulse invokes nativeFrame().
   if(controlled){
    recreation.assertPaused();
    JSONObject consumed=awaitEventWithoutFrames(s,recreation,"candidate-consumed",5000);
    assertEquals(0L,event(consumed,s.run,"candidate-consumed").getLong("frameCount"));
    assertEquals(0,s.count(consumed,s.run,"response-applied"));
    s.server.awaitRequest(2,3000);recreation.assertPaused();
    proof.put("beforeHeldResponseRelease",frameEvidence(s,consumed)).put("actualHeldRequestObserved",true);
    s.server.plan(2).release();
   }else{s.server.awaitRequest(2,5000);}
   JSONObject completed=awaitEventWithoutFrames(s,recreation,"response-applied",7000);
   proof.put("responseObservedBeforeAnySemanticOrStatePolling",frameEvidence(s,completed));
   JSONObject foreground=recreation.observeRawState();assertTrue(foreground.getBoolean("active"));assertEquals(0,foreground.getInt("lifecycleState"));
   proof.put("foregroundAtResponseObservation",foreground);
   boolean fast=s.count(completed,s.run,"loading-committed")==0&&s.count(completed,s.run,"document-unmounted")==0;
   if(controlled){
    recreation.assertPaused();assertTrue("Controlled completion must keep its original document branch",fast);
    assertEquals(0L,event(completed,s.run,"candidate-consumed").getLong("frameCount"));
    assertEquals(0L,event(completed,s.run,"response-applied").getLong("frameCount"));
    assertEquals(0L,currentRun(s,completed).getLong("frameCount"));assertEquals(0L,completed.getLong("frameCount"));
    proof.put("candidateAndResponseAppliedBeforeFirstFrame",true);
    recreation.restoreScheduling();
   }
   JSONObject firstFrame=awaitFirstFrame(s,5000);
   proof.put("firstFrameObserved",currentRun(s,firstFrame));
   // The protected interval is over. These existing helpers may now drive
   // frames while verifying measured geometry and the durable checkpoint.
   if(fast){
    JSONObject after=s.awaitCheckpoint(false,anchor(before),true);
    JSONArray afterGeometry=s.stableGeometry(beforeGeometry);s.assertStableAnchor(anchor(before),1);
    assertVisibleParagraph(afterGeometry,scrolledParagraph);proof.put("visibleBodyParagraphAfter",scrolledParagraph).put("visibleBodyParagraphVerified",true);
    s.assertSameCandidate(before,after);s.assertCompletedEventOrder("fast");
    proof.put("afterRecreation",after).put("afterGeometry",afterGeometry)
     .put("branch",controlled?"controlled-service-completion-before-first-frame":"natural-fast-document-remained-mounted")
     .put("sameCanonicalAnchorAndGeometry",true).put("fastUnverified",false);
   }else{
    s.awaitDiscardedBranch();JSONObject after=s.awaitCheckpoint(false,zeroAnchor(),true);
    JSONArray afterGeometry=s.stableGeometry(topGeometry);s.assertStableAnchor(zeroAnchor(),1);s.assertCompletedEventOrder("discarded");
    assertVisibleParagraph(afterGeometry,topParagraph);proof.put("visibleBodyParagraphAfter",topParagraph).put("visibleBodyParagraphVerified",true);
    proof.put("afterRecreation",after).put("afterGeometry",afterGeometry)
     .put("branch","natural-immediate-http-committed-loading-reset").put("canonicalAnchorResetToTop",true).put("fastUnverified",true);
   }
   capture(s,prefix,"after-recreation");s.server.awaitCompleted();s.assertKV();
   proof.put("allOtherKVUnchanged",true).put("naturalCaseClassifiedOnce",!controlled).put("state","passed");
  }catch(Exception|AssertionError error){problem=error;proof.put("state","failed").put("failure",error.toString());throw error;}
  finally{finish(s,recreation,prefix,problem);}
 }

 private static void startWithFrameProbe(Session s)throws Exception {
  assertEquals("dev.podjs.tests.startup",s.h.context.getPackageName());
  try(java.io.InputStream in=s.h.instrumentation.getContext().getAssets().open("theme-seed.json")){
   s.seed=new JSONObject(new String(readBytes(in),StandardCharsets.UTF_8));
  }
  s.seed.put("startup-legal-base-url",s.server.baseUrl()).put("legal-restoration-events",true)
   .put("legal-restoration-event-seed",s.seedId).put("legal-restoration-frame-probe",true)
   .put("legal-service-completion-sentinel",new JSONObject().put("seedId",s.seedId).put("keep",917));
  s.seed.getJSONObject("watchrss.onboarding").put("oobeSeenVersion",3).put("privacyPolicyAgreedVersion",0);
  s.seed.remove(LOG);s.h.write(s.seed);s.h.launch();s.awaitHost();s.awaitFreshRun(0,null);
  s.h.awaitLabel("不同意");s.h.activate("查看《隐私政策》");s.h.awaitNavigation(true,false);
  s.server.awaitRequest(1,5000);s.awaitEvent("response-applied",1,7000);s.h.awaitLabel(MARKER);
  validateFrames(s,s.readLog());
  s.proof.put("baseUrl",s.server.baseUrl()).put("requestUrl",s.server.baseUrl()+PATH).put("bodySha256",sha256Text(BODY));
 }

 private static JSONObject currentRun(Session s,JSONObject log)throws Exception {
  assertEquals(s.run,log.getLong("run"));assertEquals(s.instance,log.getString("instanceId"));
  JSONObject current=log.getJSONArray("runs").getJSONObject((int)s.run-1);
  assertEquals(s.run,current.getLong("run"));assertEquals(s.instance,current.getString("instanceId"));return current;
 }
 private static void validateFrames(Session s,JSONObject log)throws Exception {
  JSONArray runs=log.getJSONArray("runs"),events=log.getJSONArray("events");Map<Long,Long> last=new HashMap<>();
  for(int n=0;n<runs.length();n++){JSONObject row=runs.getJSONObject(n);legalInteger(row,"frameCount",0,9007199254740991L);last.put(row.getLong("run"),0L);}
  for(int n=0;n<events.length();n++){
   JSONObject row=events.getJSONObject(n);long count=legalInteger(row,"frameCount",0,9007199254740991L),run=row.getLong("run");
   assertTrue("Frame probe cannot move backward within a runtime",count>=last.get(run));last.put(run,count);
  }
  legalInteger(log,"frameCount",0,9007199254740991L);currentRun(s,log);
 }
 private static JSONObject event(JSONObject log,long run,String name)throws Exception {
  JSONObject found=null;JSONArray events=log.getJSONArray("events");
  for(int n=0;n<events.length();n++){JSONObject row=events.getJSONObject(n);if(row.getLong("run")==run&&name.equals(row.getString("event"))){assertNull("Duplicate event "+name,found);found=row;}}
  assertNotNull("Missing event "+name,found);return found;
 }
 private static JSONObject awaitEventWithoutFrames(Session s,Recreation recreation,String name,long timeout)throws Exception {
  long end=SystemClock.uptimeMillis()+timeout;JSONObject last=null;
  while(SystemClock.uptimeMillis()<end){
   recreation.checkFailure();last=s.readLog();validateFrames(s,last);
   if(recreation.controlled){recreation.assertPaused();assertEquals(0L,currentRun(s,last).getLong("frameCount"));assertEquals(0L,last.getLong("frameCount"));
    assertEquals(0,s.count(last,s.run,"loading-committed"));assertEquals(0,s.count(last,s.run,"document-unmounted"));}
   int count=s.count(last,s.run,name);assertTrue("Duplicate current-run event "+name,count<=1);if(count==1)return last;
   s.server.assertHealthy();SystemClock.sleep(25);
  }
  throw new AssertionError("No "+name+" without semantic/state polling in run "+s.run+": "+last);
 }
 private static JSONObject awaitFirstFrame(Session s,long timeout)throws Exception {
  long end=SystemClock.uptimeMillis()+timeout;JSONObject last=null;
  while(SystemClock.uptimeMillis()<end){last=s.readLog();validateFrames(s,last);JSONObject current=currentRun(s,last);
   if(current.getLong("frameCount")>=1){legalInteger(current,"firstFrameObservedAtEpochMs",1,Long.MAX_VALUE);return last;}
   SystemClock.sleep(25);
  }
  throw new AssertionError("SDK's normal first-frame observation missing: "+last);
 }
 private static JSONObject frameEvidence(Session s,JSONObject log)throws Exception {
  return new JSONObject().put("run",currentRun(s,log)).put("eventLog",log).put("observedAtUptimeMs",SystemClock.uptimeMillis());
 }
 private static String visibleParagraph(JSONArray geometry)throws Exception {
  for(int n=0;n<geometry.length();n++){
   JSONObject row=geometry.getJSONObject(n);String label=row.getString("label");JSONObject bounds=row.getJSONObject("bounds");
   if(bounds.getInt("right")<=bounds.getInt("left")||bounds.getInt("bottom")<=bounds.getInt("top"))continue;
   for(String paragraph:BODY.split("\\n\\n"))if(paragraph.equals(label.replace("\n","")))return label;
  }
  throw new AssertionError("No visible fetched-body paragraph in measured semantic geometry: "+geometry);
 }
 private static void assertVisibleParagraph(JSONArray geometry,String expected)throws Exception {
  for(int n=0;n<geometry.length();n++){JSONObject row=geometry.getJSONObject(n),bounds=row.getJSONObject("bounds");if(expected.equals(row.getString("label"))&&bounds.getInt("right")>bounds.getInt("left")&&bounds.getInt("bottom")>bounds.getInt("top"))return;}
  throw new AssertionError("Restored geometry is missing its visible fetched-body paragraph: "+expected);
 }
 private static Object field(Object object,String name)throws Exception {Field field=PodRuntimeView.class.getDeclaredField(name);field.setAccessible(true);return field.get(object);}
 private static JSONObject rawState(PodRuntimeView view)throws Exception {
  return new JSONObject().put("host",host(view)).put("active",field(view,"active")).put("lifecycleState",field(view,"lifecycleState")).put("firstFrameLogged",field(view,"firstFrameLogged"));
 }

 private static final class Recreation implements Application.ActivityLifecycleCallbacks {
  final Session s;final JSONObject expected,receipt=new JSONObject();final boolean controlled;
  final Activity previous;final PodRuntimeView previousView;final Application app;
  final CountDownLatch pausedReady=new CountDownLatch(1);
  volatile Activity observed;volatile PodRuntimeView target;volatile Throwable failure;volatile boolean paused,restored,registered;
  long pausedHost;int surfaceAvailableCalls;final JSONArray lifecycleEvents=new JSONArray();
  TextureView.SurfaceTextureListener original,wrapper;Choreographer.FrameCallback callback;
  Recreation(Session s,JSONObject expected,boolean controlled)throws Exception {
   this.s=s;this.expected=expected;this.controlled=controlled;previous=s.h.activity;previousView=s.h.view;app=previous.getApplication();
   receipt.put("usesActualActivityRecreate",true).put("actualBundleModified",false).put("stateInjection",false)
    .put("controlledFrameScheduling",controlled).put("callback","Application.ActivityLifecycleCallbacks.onActivityPostCreated").put("state","armed").put("lifecycleEvents",lifecycleEvents);
   s.recreations.put(receipt);
  }
  void perform()throws Exception {
   assertTrue(android.os.Build.VERSION.SDK_INT>=29);long oldRun=s.run;String oldInstance=s.instance;
   app.registerActivityLifecycleCallbacks(this);registered=true;
   try{
    s.h.recreateActivity();checkFailure();assertSame(s.h.activity,observed);s.awaitHost();checkFailure();
    if(controlled){assertTrue("Surface listener did not pause the original SDK frame callback",pausedReady.await(2,TimeUnit.SECONDS));checkFailure();assertPaused();}
    s.awaitFreshRun(oldRun,oldInstance);awaitOldRelease();checkFailure();
    receipt.put("newEventRun",s.run).put("newEventInstanceId",s.instance).put("oldActivityDestroyedAndHostReleased",true).put("state","passed");
   }finally{if(!controlled)stopObserving();}
  }
  @Override public void onActivityPostCreated(Activity created,Bundle actualBundle){
   if(observed!=null||created==previous||!"dev.podjs.androidwatch.MainActivity".equals(created.getClass().getName()))return;
   observed=created;
   try{
    target=find(created.getWindow().getDecorView());assertNotNull(target);assertNotSame(previousView,target);assertEquals(0L,host(target));
    assertNotNull(actualBundle);String incoming=actualBundle.getString(BUNDLE);assertNotNull(incoming);
    JSONObject point=s.checkpoint(new JSONObject(incoming),true);assertNotNull(point);s.assertSameCandidate(expected,point);
    assertFalse(point.getJSONObject("entry").getJSONObject("state").getBoolean("isLoading"));
    receipt.put("incomingSaved",new JSONObject(incoming)).put("incomingSavedSha256",sha256Text(incoming)).put("hostAtPostCreate",0)
     .put("activityIdentity",Integer.toHexString(System.identityHashCode(created)));
    if(controlled)installWrapper();
    assertEquals(incoming,actualBundle.getString(BUNDLE));assertEquals(0L,host(target));
   }catch(Exception|AssertionError error){recordFailure(error);}
  }
  void installWrapper()throws Exception {
   original=target.getSurfaceTextureListener();assertNotNull(original);assertSame("Expected unmodified SDK SurfaceTextureListener",target,original);
   callback=(Choreographer.FrameCallback)field(target,"frameCallback");assertNotNull(callback);
   wrapper=new TextureView.SurfaceTextureListener(){
    @Override public void onSurfaceTextureAvailable(SurfaceTexture surface,int width,int height){
     try{
      if(++surfaceAvailableCalls!=1)recordFailure(new AssertionError("Unexpected second SurfaceTexture availability during the controlled boundary"));
      original.onSurfaceTextureAvailable(surface,width,height);
      // Same UI turn: boot and its SDK kickoff have returned, but the queued
      // Choreographer callback has not run. Do not touch active or lifecycle.
      Choreographer.getInstance().removeFrameCallback(callback);paused=true;
      JSONObject state=rawState(target);assertForegroundBeforeFirstFrame(state);pausedHost=state.getLong("host");
      receipt.put("pausedImmediatelyAfterOriginalSurfaceAvailable",state).put("pauseStartedAtUptimeMs",SystemClock.uptimeMillis());
     }catch(Exception|AssertionError error){recordFailure(error);}finally{pausedReady.countDown();}
    }
    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture surface,int width,int height){original.onSurfaceTextureSizeChanged(surface,width,height);}
    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture surface){if(paused&&!restored)recordFailure(new AssertionError("Surface destroyed during the controlled boundary"));return original.onSurfaceTextureDestroyed(surface);}
    @Override public void onSurfaceTextureUpdated(SurfaceTexture surface){original.onSurfaceTextureUpdated(surface);}
   };
   target.setSurfaceTextureListener(wrapper);
  }
  void assertPaused()throws Exception {
   checkFailure();assertTrue(paused);assertFalse(restored);JSONObject[] state={null};
   s.h.instrumentation.runOnMainSync(()->{try{assertSame(wrapper,target.getSurfaceTextureListener());state[0]=rawState(target);}catch(Exception error){throw new AssertionError(error);}});
   assertForegroundBeforeFirstFrame(state[0]);assertEquals("Controlled interval must keep the same native host",pausedHost,state[0].getLong("host"));assertSame(s.h.view,target);
  }
  JSONObject observeRawState()throws Exception {
   JSONObject[] state={null};s.h.instrumentation.runOnMainSync(()->{try{state[0]=rawState(target);}catch(Exception error){throw new AssertionError(error);}});return state[0];
  }
  static void assertForegroundBeforeFirstFrame(JSONObject state)throws Exception {
   assertTrue("Native host must be alive",state.getLong("host")!=0);assertTrue("Test must leave active unchanged",state.getBoolean("active"));
   assertEquals("Test must leave resumed lifecycle unchanged",0,state.getInt("lifecycleState"));assertFalse("SDK must not have executed its first frame",state.getBoolean("firstFrameLogged"));
  }
  void restoreScheduling()throws Exception {
   if(!controlled||target==null||original==null||callback==null||restored){stopObserving();return;}
   final Throwable[] error={null};
   try{s.h.instrumentation.runOnMainSync(()->{
    // Inspect the boundary and restore it in the same main-thread turn. Guard
    // failures must still restore the original listener and scheduler.
    if(paused&&!restored)try{
     if(failure!=null)throw new AssertionError("Controlled boundary guard failed",failure);
     assertSame(wrapper,target.getSurfaceTextureListener());JSONObject state=rawState(target);assertForegroundBeforeFirstFrame(state);
     assertEquals(pausedHost,state.getLong("host"));assertSame(s.h.view,target);
     JSONObject closedLog=s.readLog();validateFrames(s,closedLog);assertEquals(0L,closedLog.getLong("frameCount"));assertEquals(0L,currentRun(s,closedLog).getLong("frameCount"));
     receipt.put("lastPausedRawState",state).put("closedProtectedIntervalEventLog",closedLog);
    }catch(Exception|AssertionError failure){error[0]=failure;}
    try{
     Choreographer.getInstance().removeFrameCallback(callback);target.setSurfaceTextureListener(original);
     if(host(target)!=0&&(Boolean)field(target,"active"))Choreographer.getInstance().postFrameCallback(callback);
     restored=true;paused=false;receipt.put("originalListenerAndFrameCallbackRestored",true).put("resumedAtUptimeMs",SystemClock.uptimeMillis());
    }catch(Exception|AssertionError failure){if(error[0]==null)error[0]=failure;else error[0].addSuppressed(failure);}
   });}finally{stopObserving();}
   if(error[0]!=null)throw new AssertionError("Original SDK scheduling could not be restored",error[0]);
  }
  void awaitOldRelease()throws Exception {
   long end=SystemClock.uptimeMillis()+10000;boolean[] released={false};
   while(SystemClock.uptimeMillis()<end){s.h.instrumentation.runOnMainSync(()->{try{released[0]=previous.isDestroyed()&&host(previousView)==0;}catch(Exception error){throw new AssertionError(error);}});if(released[0])return;SystemClock.sleep(40);}
   throw new AssertionError("Previous Activity/native host was not released");
  }
  void recordFailure(Throwable error){failure=error;try{receipt.put("state","failed").put("failure",error.toString());}catch(Exception ignored){}}
  void checkFailure(){if(failure!=null)throw new AssertionError("Recreation/frame-boundary hook failed",failure);}
  void stopObserving(){if(registered){app.unregisterActivityLifecycleCallbacks(this);registered=false;}}
  void lifecycle(Activity activity,String name){
   if(activity!=observed)return;
   try{lifecycleEvents.put(new JSONObject().put("event",name).put("whilePaused",paused&&!restored).put("atUptimeMs",SystemClock.uptimeMillis()));}
   catch(Exception error){recordFailure(error);}
   if(paused&&!restored)recordFailure(new AssertionError("Lifecycle changed during controlled boundary: "+name));
  }
  @Override public void onActivityCreated(Activity activity,Bundle state){}
  @Override public void onActivityStarted(Activity activity){lifecycle(activity,"started");}
  @Override public void onActivityResumed(Activity activity){lifecycle(activity,"resumed");}
  @Override public void onActivityPaused(Activity activity){lifecycle(activity,"paused");}
  @Override public void onActivityStopped(Activity activity){lifecycle(activity,"stopped");}
  @Override public void onActivityPreSaveInstanceState(Activity activity,Bundle state){lifecycle(activity,"pre-save-instance-state");}
  @Override public void onActivitySaveInstanceState(Activity activity,Bundle state){lifecycle(activity,"save-instance-state");}
  @Override public void onActivityDestroyed(Activity activity){lifecycle(activity,"destroyed");}
 }

 private static void capture(Session s,String prefix,String stage)throws Exception {
  s.capture(stage);JSONObject capture=s.captures.getJSONObject(s.captures.length()-1);
  File old=new File(s.h.context.getFilesDir(),capture.getString("file")),renamed=new File(s.h.context.getFilesDir(),prefix+"-"+stage+".png");
  Files.move(old.toPath(),renamed.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);capture.put("file",renamed.getName());
 }
 private static void finish(Session s,Recreation recreation,String prefix,Throwable original)throws Exception {
  Throwable cleanup=null;
  // Preserve the protected-interval evidence before restoring frames on failure.
  try{s.proof.put("finalObservedEventLog",s.readLog());}catch(Exception|AssertionError error){cleanup=error;s.proof.put("eventLogCaptureFailure",error.toString());}
  if(recreation!=null)try{recreation.restoreScheduling();}catch(Exception|AssertionError error){if(cleanup==null)cleanup=error;s.proof.put("schedulingCleanupFailure",error.toString());}
  try{s.proof.put("server",s.server.evidence());s.server.close();}catch(Exception|AssertionError error){if(cleanup==null)cleanup=error;s.proof.put("serverCleanupFailure",error.toString());}
  try{s.h.finish();s.proof.put("finalActivityAndNativeHostReleased",true);}catch(Exception|AssertionError error){if(cleanup==null)cleanup=error;s.proof.put("activityCleanupFailure",error.toString());}
  if(cleanup!=null)s.proof.put("state","failed");s.proof.put("completedAtEpochMs",System.currentTimeMillis());
  Files.write(new File(s.h.context.getFilesDir(),prefix+".json").toPath(),s.proof.toString().getBytes(StandardCharsets.UTF_8));
  if(cleanup!=null){if(original!=null)original.addSuppressed(cleanup);else throw new AssertionError("Service-completion test cleanup failed",cleanup);}
 }
}
