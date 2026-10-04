package dev.podjs.runtime;

import static org.junit.Assert.*;
import static dev.podjs.runtime.StartupRuntimeTest.*;

import android.app.Activity;
import android.app.Application;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.PixelCopy;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Real same-process Activity recreation through the startup gate. The pending
 * case explicitly simulates one incoming metadata value before guest boot;
 * its second recreation uses the naturally saved Android Bundle unchanged. */
public final class LegalTopRestorationRuntimeTest {
 static final String STACK="watchrss.startup-legal-stack", BUNDLE="dev.podjs.activity-state";
 static final String LOG="legal-restoration-event-log", PATH="/functions/v1/legal/watch/privacy-policy";
 static final String MARKER="隐私恢复正文";
 static final String BODY=body();
 static String body(){StringBuilder text=new StringBuilder(MARKER);for(int n=1;n<=32;n++)text.append("\n\n隐私隔离段落").append(n).append("。本段用于检查真实列表恢复的位置。");return text.toString();}

 @Test public void heldTopRecreationResetsAfterCommittedLoading()throws Exception {exercise("held",false,false);}
 @Test public void pendingCandidateSurvivesAnotherRecreationBeforeMount()throws Exception {exercise("pending",true,false);}
 @Test public void immediateResponseClassifiesActualMountBranch()throws Exception {exercise("immediate",false,true);}

 private void exercise(String name,boolean pending,boolean immediate)throws Exception {
  Session s=new Session(name,pending,immediate);Throwable problem=null;
  try {
   s.start();
   JSONObject topSample=s.stableBaseline(false),before=topSample.getJSONObject("checkpoint");
   JSONArray top=topSample.getJSONArray("geometry");s.proof.put("initialTop",before).put("initialTopGeometry",top);
   s.capture("initial-top");
   s.h.performAction("协议正文",2);s.h.performAction("协议正文",2);
   JSONObject scrolledSample=s.stableBaseline(true),scrolled=scrolledSample.getJSONObject("checkpoint");
   JSONArray scrolledGeometry=scrolledSample.getJSONArray("geometry");
   assertFalse("Scrolled viewport must differ from top",sameCustomizationGeometry(top,scrolledGeometry,1));
   s.proof.put("beforeRecreation",scrolled).put("beforeGeometry",scrolledGeometry).put("semanticForwardScrolls",2);
   s.capture("scrolled-before");
   s.assertKV();
   long originalRun=s.run;
   s.recreate(pending,scrolled,false);
   s.server.awaitRequest(2,5000);
   if(pending){
    s.assertPendingRun();JSONObject pendingFirst=s.awaitCheckpoint(true,anchor(scrolled),true);
    s.assertSameCandidate(scrolled,pendingFirst);s.proof.put("pendingFirstCheckpoint",pendingFirst);
    s.server.plan(2).expectedCancellation=true;
    long middleRun=s.run;
    s.recreate(false,pendingFirst,true);
    s.server.awaitRequest(3,5000);
    assertEquals("Old held response must still be gated when the next request arrives",1L,s.server.plan(2).gate.getCount());
    assertEquals("Old held request worker must still be alive",1L,s.server.plan(2).finished.getCount());
    s.proof.put("newRequestArrivedWhileCanceledOldRequestStillHeld",true);
    s.assertPendingRun(middleRun);s.assertPendingRun();
    JSONObject pendingSecond=s.awaitCheckpoint(true,anchor(scrolled),true);
    s.assertSameCandidate(scrolled,pendingSecond);s.proof.put("pendingSecondCheckpoint",pendingSecond);
    // A separate worker serves request 3 while the canceled request 2 is still
    // held. Release the old worker now; a successful old write is not required.
    s.server.plan(2).release();s.server.plan(3).release();
    s.awaitEvent("response-applied",1,7000);
    JSONObject restored=s.awaitCheckpoint(false,anchor(scrolled),true);
    JSONArray after=s.stableGeometry(scrolledGeometry);s.assertStableAnchor(anchor(scrolled),1);
    s.assertSameCandidate(scrolled,restored);
    s.proof.put("afterRecreation",restored).put("afterGeometry",after)
     .put("pendingMetadataSimulationAppliedOnce",true).put("secondNaturalSavedBundlePreservedPendingAnchor",true)
     .put("secondRestoreClearedRetainedAsSavedOnlySimulation",true)
     .put("pendingCandidateConsumedExactlyOnce",true).put("branch","pending-survives-until-first-document-mount");
    s.assertPendingRun(middleRun);
    assertEquals(0,s.count(s.run,"loading-committed"));assertEquals(0,s.count(s.run,"document-unmounted"));
    s.assertCompletedEventOrder("pending");
   }else if(!immediate){
    s.awaitDiscardedBranch();
    assertEquals(0,s.count(s.run,"response-applied"));
    s.proof.put("heldLoadingCheckpoint",s.awaitDiscardedCheckpoint());
    s.server.plan(2).release();s.awaitEvent("response-applied",1,7000);
    JSONObject reset=s.awaitCheckpoint(false,zeroAnchor(),true);
    JSONArray after=s.stableGeometry(top);s.assertStableAnchor(zeroAnchor(),1);
    s.proof.put("afterRecreation",reset).put("afterGeometry",after)
     .put("branch","consumed-then-committed-loading-reset").put("canonicalAnchorResetToTop",true);
    s.assertCompletedEventOrder("discarded");
   }else{
    s.awaitEvent("response-applied",1,7000);s.awaitCheckpoint(false,null,true);
    s.stableGeometry(null);
    int loads=s.count(s.run,"loading-committed"),unmounts=s.count(s.run,"document-unmounted");
    assertEquals("Restored candidate must be consumed once",1,s.count(s.run,"candidate-consumed"));
    if(loads==0&&unmounts==0){
     JSONObject restored=s.awaitCheckpoint(false,anchor(scrolled),true);
     JSONArray after=s.stableGeometry(scrolledGeometry);s.assertStableAnchor(anchor(scrolled),1);
     assertEquals(1,s.count(s.run,"document-mounted"));
     s.proof.put("afterRecreation",restored).put("afterGeometry",after)
      .put("branch","true-fast-document-remained-mounted").put("trueFastVerified",true).put("fastUnverified",false);
     s.assertCompletedEventOrder("fast");
    }else{
     s.awaitDiscardedBranch();JSONObject reset=s.awaitCheckpoint(false,zeroAnchor(),true);
     JSONArray after=s.stableGeometry(top);s.assertStableAnchor(zeroAnchor(),1);
     s.proof.put("afterRecreation",reset).put("afterGeometry",after)
      .put("branch","immediate-http-but-committed-loading-reset").put("trueFastVerified",false).put("fastUnverified",true);
     s.assertCompletedEventOrder("discarded");
    }
   }
   s.capture("after-recreation");
   assertEquals(pending?originalRun+2:originalRun+1,s.run);
   s.server.awaitCompleted();s.server.assertHealthy();s.assertKV();
   s.proof.put("allOtherKVUnchanged",true).put("state","passed");
  }catch(Exception|AssertionError error){problem=error;s.proof.put("state","failed").put("failure",error.toString());throw error;}
  finally{s.finish(problem);}
 }

 static JSONObject anchor(JSONObject checkpoint)throws Exception {return checkpoint.getJSONObject("entry").getJSONObject("state").getJSONObject("listAnchor");}
 static JSONObject zeroAnchor()throws Exception {return new JSONObject().put("index",0).put("offsetPx",0);}
 static boolean nonzero(JSONObject value)throws Exception {return value.getLong("index")>0||value.getLong("offsetPx")>0;}

 static final class Session {
  final StartupRuntimeTest h=new StartupRuntimeTest();final GatedServer server;
  final String seedId=UUID.randomUUID().toString(),name,prefix;
  final JSONObject proof=new JSONObject();final JSONArray recreations=new JSONArray(),captures=new JSONArray();
  JSONObject seed;long run;String instance;
  Session(String name,boolean pending,boolean immediate)throws Exception {
   this.name=name;prefix="legal-top-restoration-"+name;server=new GatedServer(pending,immediate);
   proof.put("schemaVersion",1).put("state","started").put("case",name).put("seedId",seedId)
    .put("pid",android.os.Process.myPid()).put("sameProcessActivityRecreation",true).put("actualProcessDeathVerified",false)
    .put("physicalInputInjected",false).put("loggingUsesFixtureKVAndMayAffectScheduling",true)
    .put("semanticInspectionInvokesNativeFrameAndMayAdvanceCommitTiming",true)
    .put("semanticPollingDrivesNativeFrames",true).put("nativeTextResourceBarrierVerified",false).put("exactPixelParityAsserted",false)
    .put("captureLimitations","PixelCopy equality and foreground count establish stable raster samples only; they do not establish native text-resource readiness, visual acceptance, or native/PodJS pixel parity")
    .put("timingConclusionScope","Observed event branch under this instrumentation only; no uninstrumented timing or throughput claim")
    .put("nativeReferenceIsObservationalOnly",true).put("nativeReferenceRerun",false)
    .put("nativeReferences",new JSONArray()
     .put(new JSONObject().put("path","artifacts/native-info-fast-proof.json").put("sha256","e12193fecad5308151d099e2d407b77d8f0fd6f247a0e7f8d253d45e17023d13").put("axisBefore",6037).put("axisAfter",6037))
     .put(new JSONObject().put("path","artifacts/native-info-slow-proof.json").put("sha256","849450cd4e08fe74cd5617c0f1b49642f3e1a27e041337967ca66869adc982d7").put("axisBefore",6037).put("axisAfter",0)))
    .put("nativeReferenceLimitations","Existing Compose autoAdvance observations in one PID; scrollOutcomeAsserted=false, processDeathTested=false; axis is not compared to PodJS pixels; no native frame-event proof for fast branch.")
    .put("geometryUnits","PodJS accessibility scene coordinates; anchor offset is physical pixels")
    .put("startedAtEpochMs",System.currentTimeMillis()).put("recreations",recreations).put("captures",captures);
  }
  void start()throws Exception {
   assertEquals("dev.podjs.tests.startup",h.context.getPackageName());
   try(java.io.InputStream in=h.instrumentation.getContext().getAssets().open("theme-seed.json")){
    seed=new JSONObject(new String(readBytes(in),StandardCharsets.UTF_8));
   }
   seed.put("startup-legal-base-url",server.baseUrl()).put("legal-restoration-events",true)
    .put("legal-restoration-event-seed",seedId).put("legal-top-restoration-sentinel",new JSONObject().put("seedId",seedId).put("keep",731));
   seed.getJSONObject("watchrss.onboarding").put("oobeSeenVersion",3).put("privacyPolicyAgreedVersion",0);
   seed.remove(LOG);h.write(seed);h.launch();awaitHost();awaitFreshRun(0,null);
   h.awaitLabel("不同意");h.activate("查看《隐私政策》");h.awaitNavigation(true,false);
   server.awaitRequest(1,5000);awaitEvent("response-applied",1,7000);h.awaitLabel(MARKER);
   proof.put("baseUrl",server.baseUrl()).put("requestUrl",server.baseUrl()+PATH).put("bodySha256",sha256Text(BODY));
  }
  void assertKV()throws Exception {JSONObject value=h.read();assertNotNull(value.remove(LOG));assertJson(seed,value);}
  JSONObject readLog()throws Exception {
   JSONObject log=h.read().getJSONObject(LOG);
   assertEquals(1L,legalInteger(log,"version",1,1));assertEquals(seedId,log.getString("seedId"));
   assertEquals(0L,legalInteger(log,"droppedEvents",0,0));
   long current=legalInteger(log,"run",1,16),sequence=legalInteger(log,"sequence",0,256);
   JSONArray runs=log.getJSONArray("runs"),events=log.getJSONArray("events");
   assertEquals("Every fresh JS run must be retained in this bounded test",current,runs.length());
   Map<Long,String> ids=new HashMap<>();Set<String> unique=new HashSet<>();
   for(int n=0;n<runs.length();n++){
    JSONObject item=runs.getJSONObject(n);long number=legalInteger(item,"run",1,16);assertEquals(n+1L,number);
    String id=legalString(item,"instanceId");assertTrue(id.startsWith(seedId+"/"+number+"/"));assertTrue(unique.add(id));
    legalInteger(item,"startedAtEpochMs",1,Long.MAX_VALUE);ids.put(number,id);
   }
   assertEquals(ids.get(current),log.getString("instanceId"));assertEquals(sequence,events.length());
   for(int n=0;n<events.length();n++){
    JSONObject event=events.getJSONObject(n);assertEquals(n+1L,legalInteger(event,"sequence",1,256));
    long eventRun=legalInteger(event,"run",1,current);assertEquals(ids.get(eventRun),event.getString("instanceId"));
    assertEquals("privacy",event.getString("page"));legalInteger(event,"atEpochMs",1,Long.MAX_VALUE);
    assertTrue("Unknown fixture event",java.util.Arrays.asList("document-mounted","document-unmounted","candidate-consumed","loading-committed","response-applied").contains(event.getString("event")));
   }
   return log;
  }
  void awaitFreshRun(long previous,String previousInstance)throws Exception {
   long end=SystemClock.uptimeMillis()+10000;
   while(SystemClock.uptimeMillis()<end){
    JSONObject value=h.read().optJSONObject(LOG);
    if(value!=null&&value.optLong("run")>previous){JSONObject log=readLog();run=log.getLong("run");instance=log.getString("instanceId");assertEquals(previous+1,run);assertFalse(instance.equals(previousInstance));return;}
    SystemClock.sleep(40);
   }
   throw new AssertionError("Fresh legal event run missing after recreation");
  }
  int count(long wantedRun,String event)throws Exception {return count(readLog(),wantedRun,event);}
  int count(JSONObject log,long wantedRun,String wantedEvent)throws Exception {
   int count=0;JSONArray events=log.getJSONArray("events");
   for(int n=0;n<events.length();n++){JSONObject item=events.getJSONObject(n);if(item.getLong("run")==wantedRun&&wantedEvent.equals(item.getString("event")))count++;}return count;
  }
  void awaitEvent(String event,int expected,long timeout)throws Exception {
   long end=SystemClock.uptimeMillis()+timeout;
   while(SystemClock.uptimeMillis()<end){pulse();int actual=count(run,event);assertTrue("Unexpected duplicate "+event,actual<=expected);if(actual==expected)return;server.assertHealthy();SystemClock.sleep(35);}
   throw new AssertionError("Expected "+event+" in current run "+run+": "+readLog());
  }
  void awaitDiscardedBranch()throws Exception {
   awaitEvent("candidate-consumed",1,5000);awaitEvent("loading-committed",1,5000);awaitEvent("document-unmounted",1,5000);
   long candidate=0,loading=0,unmount=0;JSONArray events=readLog().getJSONArray("events");
   for(int n=0;n<events.length();n++){JSONObject event=events.getJSONObject(n);if(event.getLong("run")!=run)continue;
    if("candidate-consumed".equals(event.getString("event")))candidate=event.getLong("sequence");
    if("loading-committed".equals(event.getString("event")))loading=event.getLong("sequence");
    if("document-unmounted".equals(event.getString("event")))unmount=event.getLong("sequence");
   }
   assertTrue("Candidate must be consumed before the committed loading branch removes its document",candidate>0&&candidate<loading&&candidate<unmount);
  }
  void assertPendingRun()throws Exception {assertPendingRun(run);}
  void assertPendingRun(long wantedRun)throws Exception {
   JSONObject log=readLog();for(String event:new String[]{"document-mounted","candidate-consumed","response-applied","document-unmounted"})assertEquals("Pending run "+wantedRun+" must not have "+event,0,count(log,wantedRun,event));
  }
  void assertCompletedEventOrder(String branch)throws Exception {
   JSONObject log=readLog();Map<String,List<Long>> sequences=new HashMap<>();
   for(String event:new String[]{"document-mounted","document-unmounted","candidate-consumed","loading-committed","response-applied"})sequences.put(event,new ArrayList<>());
   JSONArray events=log.getJSONArray("events");
   for(int n=0;n<events.length();n++){JSONObject event=events.getJSONObject(n);if(event.getLong("run")==run)sequences.get(event.getString("event")).add(event.getLong("sequence"));}
   assertEquals(1,sequences.get("candidate-consumed").size());assertEquals(1,sequences.get("response-applied").size());
   long consumed=sequences.get("candidate-consumed").get(0),response=sequences.get("response-applied").get(0);
   List<Long> mounts=sequences.get("document-mounted"),loads=sequences.get("loading-committed"),unmounts=sequences.get("document-unmounted");
   if("discarded".equals(branch)){
    assertEquals(2,mounts.size());assertEquals(1,loads.size());assertEquals(1,unmounts.size());
    assertTrue(mounts.get(0)<consumed&&consumed<loads.get(0)&&consumed<unmounts.get(0));
    assertTrue(loads.get(0)<response&&unmounts.get(0)<response&&response<mounts.get(1));
   }else{
    assertEquals(1,mounts.size());assertEquals(0,loads.size());assertEquals(0,unmounts.size());
    assertTrue(mounts.get(0)<consumed);
    if("pending".equals(branch))assertTrue(response<mounts.get(0));else assertTrue(consumed<response);
   }
   JSONObject receipt=new JSONObject();for(Map.Entry<String,List<Long>> entry:sequences.entrySet())receipt.put(entry.getKey(),new JSONArray(entry.getValue()));
   proof.put("completedBranchEventSequences",receipt).put("completedBranchEventOrderAsserted",true);
  }
  void pulse()throws Exception {h.snapshot();}
  void awaitHost()throws Exception {
   long end=SystemClock.uptimeMillis()+15000;long[] host={0};
   while(SystemClock.uptimeMillis()<end){h.instrumentation.runOnMainSync(()->{try{host[0]=host(h.view);}catch(Exception error){throw new AssertionError(error);}});if(host[0]!=0)return;SystemClock.sleep(40);}
   throw new AssertionError("Recreated runtime did not boot");
  }
  JSONObject saved()throws Exception {String[] value={null};h.instrumentation.runOnMainSync(()->value[0]=h.view.savedActivityState());return new JSONObject(value[0]);}
  JSONObject checkpoint(JSONObject saved,boolean requireBody)throws Exception {
   JSONObject stack=saved.optJSONObject(STACK);if(stack==null)return null;
   legalInteger(stack,"version",2,2);String owner=legalString(stack,"owner");assertTrue(owner.matches("[A-Za-z0-9_-]{1,96}"));assertFalse(stack.has("backgrounds"));
   JSONArray pages=stack.getJSONArray("pages"),snapshots=stack.getJSONArray("snapshots");assertEquals(1,pages.length());assertEquals("privacy",pages.getString(0));assertEquals(1,snapshots.length());
   if(snapshots.isNull(0))return null;
   JSONObject entry=snapshots.getJSONObject(0),state=entry.getJSONObject("state");assertEquals("privacy",legalString(entry,"page"));assertLegalIdentity(entry.getJSONObject("identity"),server.baseUrl()+PATH);
   assertFalse(state.has("content"));assertFalse(state.has("contentBase64"));assertTrue(state.get("isLoading") instanceof Boolean);assertTrue(state.isNull("error"));
   legalInteger(state,"reloadKey",0,9007199254740991L);Object offset=state.get("scrollOffset");assertTrue(offset instanceof Number&&Double.isFinite(((Number)offset).doubleValue())&&((Number)offset).doubleValue()>=0);
   Object candidate=state.get("listAnchor");if(candidate!=JSONObject.NULL){assertTrue(candidate instanceof JSONObject);legalInteger((JSONObject)candidate,"index",0,9007199254740991L);legalInteger((JSONObject)candidate,"offsetPx",0,9007199254740991L);}
   Object reference=entry.get("bodyReference");assertTrue(reference==JSONObject.NULL||reference instanceof JSONObject);
   if(requireBody&&reference==JSONObject.NULL)return null;
   if(reference!=JSONObject.NULL)assertEquals(BODY,h.readLegalRecoveryBody(entry,owner,server.baseUrl()+PATH));
   return new JSONObject().put("owner",owner).put("entry",entry);
  }
  JSONObject awaitCheckpoint(boolean loading,JSONObject expectedAnchor,boolean body)throws Exception {
   long end=SystemClock.uptimeMillis()+7000;JSONObject last=null;
   while(SystemClock.uptimeMillis()<end){pulse();last=checkpoint(saved(),body);
    if(last!=null){JSONObject state=last.getJSONObject("entry").getJSONObject("state");
     if(state.getBoolean("isLoading")==loading&&(expectedAnchor==null||canonical(expectedAnchor).toString().equals(canonical(state.get("listAnchor")).toString())))return last;
    }
    server.assertHealthy();SystemClock.sleep(50);
   }
   throw new AssertionError("Checkpoint did not settle: loading="+loading+" anchor="+expectedAnchor+" last="+last);
  }
  JSONObject awaitDiscardedCheckpoint()throws Exception {
   long end=SystemClock.uptimeMillis()+5000;JSONObject last=null;
   while(SystemClock.uptimeMillis()<end){pulse();last=checkpoint(saved(),false);if(last!=null){JSONObject state=last.getJSONObject("entry").getJSONObject("state");if(state.getBoolean("isLoading")&&state.isNull("listAnchor"))return last;}SystemClock.sleep(40);}
   throw new AssertionError("Unmounted loading branch must publish a null consumed anchor: "+last);
  }
  JSONObject stableBaseline(boolean scrolled)throws Exception {
   long end=SystemClock.uptimeMillis()+7000;JSONObject previousPoint=null,last=null;JSONArray previousGeometry=null;int repeats=0;
   while(SystemClock.uptimeMillis()<end){
    JSONArray geometry=customizationGeometry(h.snapshot());JSONObject point=checkpoint(saved(),true);last=point;
    JSONObject value=point==null?null:point.getJSONObject("entry").getJSONObject("state").optJSONObject("listAnchor");
    boolean ready=point!=null&&!point.getJSONObject("entry").getJSONObject("state").getBoolean("isLoading")&&value!=null
     &&(scrolled?nonzero(value):canonical(value).toString().equals(canonical(zeroAnchor()).toString()));
    if(ready&&geometry.length()>0&&previousPoint!=null&&canonical(point).toString().equals(canonical(previousPoint).toString())&&sameCustomizationGeometry(previousGeometry,geometry,0)){
     if(++repeats>=2)return new JSONObject().put("checkpoint",point).put("geometry",geometry).put("equalConsecutiveSamples",3);
    }else repeats=0;
    previousPoint=ready?point:null;previousGeometry=geometry;server.assertHealthy();SystemClock.sleep(150);
   }
   throw new AssertionError("Saved anchor and visible geometry did not settle together: scrolled="+scrolled+" last="+last);
  }
  void assertSameCandidate(JSONObject expected,JSONObject actual)throws Exception {
   assertEquals(expected.getString("owner"),actual.getString("owner"));
   JSONObject a=expected.getJSONObject("entry"),b=actual.getJSONObject("entry");
   assertJson(a.getJSONObject("identity"),b.getJSONObject("identity"));assertJson(a.getJSONObject("bodyReference"),b.getJSONObject("bodyReference"));
   assertJson(anchor(expected),anchor(actual));assertEquals(a.getJSONObject("state").getLong("reloadKey"),b.getJSONObject("state").getLong("reloadKey"));
  }
  JSONArray stableGeometry(JSONArray expected)throws Exception {
   long end=SystemClock.uptimeMillis()+7000;JSONArray prior=null,actual=null;int repeats=0;
   while(SystemClock.uptimeMillis()<end){actual=customizationGeometry(h.snapshot());
    if(actual.length()>0&&(expected==null||sameCustomizationGeometry(expected,actual,1))&&prior!=null&&sameCustomizationGeometry(prior,actual,0)){if(++repeats>=2)return actual;}else repeats=0;
    prior=actual;SystemClock.sleep(120);
   }
   throw new AssertionError("Legal viewport did not settle. expected="+expected+" actual="+actual);
  }
  void assertStableAnchor(JSONObject expected,int consumed)throws Exception {
   for(int sample=0;sample<3;sample++){SystemClock.sleep(120);JSONObject checkpoint=awaitCheckpoint(false,expected,true);assertJson(expected,anchor(checkpoint));assertEquals(consumed,count(run,"candidate-consumed"));}
  }
  void recreate(boolean injectPending,JSONObject expected,boolean incomingLoading)throws Exception {
   assertTrue(android.os.Build.VERSION.SDK_INT>=29);
   final Activity old=h.activity;final PodRuntimeView oldView=h.view;final Application app=old.getApplication();
   final JSONObject receipt=new JSONObject().put("simulated",injectPending).put("actualBundleModified",false).put("usesActualActivityRecreate",true)
    .put("pendingPhaseInjected",injectPending).put("hostSavedCopyModified",injectPending).put("retainedClearSimulated",injectPending||incomingLoading)
    .put("callback","Application.ActivityLifecycleCallbacks.onActivityPostCreated").put("state","armed");
   recreations.put(receipt);final Throwable[] error={null};final Activity[] observed={null};final boolean[] armed={true};
   Application.ActivityLifecycleCallbacks callbacks=new Application.ActivityLifecycleCallbacks(){
    @Override public void onActivityPostCreated(Activity created,Bundle actualBundle){
     if(!armed[0]||created==old||!"dev.podjs.androidwatch.MainActivity".equals(created.getClass().getName()))return;
     armed[0]=false;observed[0]=created;
     try{
      PodRuntimeView fresh=find(created.getWindow().getDecorView());assertNotNull(fresh);assertNotSame(oldView,fresh);assertEquals(0L,host(fresh));
      assertNotNull(actualBundle);String actualSaved=actualBundle.getString(BUNDLE);assertNotNull(actualSaved);assertEquals(actualSaved,fresh.savedActivityState());
      JSONObject incoming=new JSONObject(actualSaved),point=checkpoint(incoming,true);assertNotNull(point);assertSameCandidate(expected,point);
      assertEquals(incomingLoading,point.getJSONObject("entry").getJSONObject("state").getBoolean("isLoading"));
      receipt.put("incomingSaved",incoming).put("incomingSavedSha256",sha256Text(actualSaved)).put("incomingRetained",new JSONObject(fresh.retainedActivityState()))
       .put("hostBefore",0).put("activityIdentity",Integer.toHexString(System.identityHashCode(created)));
      if(injectPending){
       assertFalse(incomingLoading);JSONObject changed=new JSONObject(actualSaved);
       changed.getJSONObject(STACK).getJSONArray("snapshots").getJSONObject(0).getJSONObject("state").put("isLoading",true);
       JSONObject reversed=new JSONObject(changed.toString());reversed.getJSONObject(STACK).getJSONArray("snapshots").getJSONObject(0).getJSONObject("state").put("isLoading",false);assertJson(incoming,reversed);
       fresh.restoreActivityState(changed.toString(),null);assertJson(changed,new JSONObject(fresh.savedActivityState()));assertEquals("{}",fresh.retainedActivityState());
       receipt.put("injectedSaved",changed).put("onlyChangedPointer","/watchrss.startup-legal-stack/snapshots/0/state/isLoading").put("retainedClearedBeforeGuest",true);
      }else if(incomingLoading){
       // Its pending metadata came from the real preceding Activity's Bundle.
       // Clear only the alternate retained channel to prove saved-only restore.
       fresh.restoreActivityState(actualSaved,null);assertEquals(actualSaved,fresh.savedActivityState());assertEquals("{}",fresh.retainedActivityState());
       receipt.put("simulated",true).put("simulation","saved-only restore by clearing retained; natural saved bytes unchanged")
        .put("retainedClearedBeforeGuest",true).put("naturalSavedBytesUnchanged",true);
      }
      assertEquals(0L,host(fresh));assertEquals(actualSaved,actualBundle.getString(BUNDLE));
      receipt.put("hostAfter",0).put("actualBundleUnchanged",true).put("state","passed");
     }catch(Exception|AssertionError failure){error[0]=failure;try{receipt.put("state","failed").put("failure",failure.toString());}catch(Exception ignored){}}
    }
    @Override public void onActivityCreated(Activity activity,Bundle state){}
    @Override public void onActivityStarted(Activity activity){}
    @Override public void onActivityResumed(Activity activity){}
    @Override public void onActivityPaused(Activity activity){}
    @Override public void onActivityStopped(Activity activity){}
    @Override public void onActivitySaveInstanceState(Activity activity,Bundle state){}
    @Override public void onActivityDestroyed(Activity activity){}
   };
   long previousRun=run;String previousInstance=instance;
   app.registerActivityLifecycleCallbacks(callbacks);
   try{h.recreateActivity();}finally{app.unregisterActivityLifecycleCallbacks(callbacks);}
   if(error[0]!=null)throw new AssertionError("Pre-guest recreation observation failed",error[0]);
   assertSame("Callback must observe the actual replacement Activity",h.activity,observed[0]);
   awaitHost();awaitFreshRun(previousRun,previousInstance);
   long end=SystemClock.uptimeMillis()+10000;boolean[] released={false};
   while(SystemClock.uptimeMillis()<end){h.instrumentation.runOnMainSync(()->{try{released[0]=old.isDestroyed()&&host(oldView)==0;}catch(Exception failure){throw new AssertionError(failure);}});if(released[0])break;SystemClock.sleep(40);}
   assertTrue("Previous Activity and native host must be released",released[0]);
   receipt.put("oldActivityDestroyedAndHostReleased",true).put("newEventRun",run).put("newEventInstanceId",instance);
  }
  void capture(String stage)throws Exception {
   // Window PixelCopy waits for the compositor's actual raster. Semantics are
   // recorded separately and do not stand in for rendered-pixel evidence.
   String previous=null;Bitmap accepted=null;int repeats=0,bright=0;String digest=null;
   long end=SystemClock.uptimeMillis()+5000;
   while(SystemClock.uptimeMillis()<end){
    Bitmap next=windowBitmap();ByteBuffer bytes=ByteBuffer.allocate(next.getByteCount());next.copyPixelsToBuffer(bytes);digest=sha256Bytes(bytes.array());
    int[] pixels=new int[next.getWidth()*next.getHeight()];next.getPixels(pixels,0,next.getWidth(),0,0,next.getWidth(),next.getHeight());bright=0;
    for(int pixel:pixels)if(((pixel>>16)&255)>80&&((pixel>>8)&255)>80&&(pixel&255)>80)bright++;
    if(digest.equals(previous)&&bright>40){repeats++;if(repeats>=2){accepted=next;break;}}else repeats=0;
    previous=digest;next.recycle();SystemClock.sleep(120);
   }
   assertNotNull("Rendered legal screen did not stabilize with visible foreground pixels",accepted);
   File file=new File(h.context.getFilesDir(),prefix+"-"+stage+".png");
   try(FileOutputStream out=new FileOutputStream(file)){assertTrue(accepted.compress(Bitmap.CompressFormat.PNG,100,out));
    captures.put(new JSONObject().put("stage",stage).put("file",file.getName()).put("width",accepted.getWidth()).put("height",accepted.getHeight())
     .put("pixelSha256",digest).put("pngSha256",sha256Bytes(Files.readAllBytes(file.toPath()))).put("foregroundPixelCount",bright).put("equalConsecutiveFrames",3));
   }finally{accepted.recycle();}
  }
  Bitmap windowBitmap()throws Exception {
   int[] size=new int[2];h.instrumentation.runOnMainSync(()->{size[0]=h.activity.getWindow().getDecorView().getWidth();size[1]=h.activity.getWindow().getDecorView().getHeight();});
   assertTrue(size[0]>0&&size[1]>0);Bitmap bitmap=Bitmap.createBitmap(size[0],size[1],Bitmap.Config.ARGB_8888);
   CountDownLatch done=new CountDownLatch(1);int[] result={-1};Object ownership=new Object();boolean[] abandoned={false};
   try{h.instrumentation.runOnMainSync(()->PixelCopy.request(h.activity.getWindow(),bitmap,status->{synchronized(ownership){result[0]=status;if(abandoned[0])bitmap.recycle();else done.countDown();}},new Handler(Looper.getMainLooper())));}
   catch(RuntimeException|AssertionError failure){bitmap.recycle();throw failure;}
   boolean delivered;
   try{delivered=done.await(2,TimeUnit.SECONDS);}catch(InterruptedException interrupted){synchronized(ownership){if(result[0]==-1)abandoned[0]=true;else bitmap.recycle();}throw interrupted;}
   synchronized(ownership){
    if(!delivered&&result[0]==-1){abandoned[0]=true;throw new AssertionError("Window PixelCopy callback timed out; late callback owns bitmap recycling");}
    if(result[0]!=PixelCopy.SUCCESS){bitmap.recycle();throw new AssertionError("Window PixelCopy failed: "+result[0]);}
    return bitmap;
   }
  }
  void finish(Throwable original)throws Exception {
   Throwable cleanup=null;
   try{proof.put("eventLog",readLog());}catch(Exception|AssertionError error){cleanup=error;proof.put("eventLogCaptureFailure",error.toString());}
   proof.put("server",server.evidence()).put("completedAtEpochMs",System.currentTimeMillis());
   try{server.close();}catch(Exception|AssertionError error){cleanup=error;proof.put("serverCleanupFailure",error.toString());}
   try{h.finish();}catch(Exception|AssertionError error){if(cleanup==null)cleanup=error;proof.put("activityCleanupFailure",error.toString());}
   if(cleanup!=null)proof.put("state","failed");
   Files.write(new File(h.context.getFilesDir(),prefix+"-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
   if(cleanup!=null){if(original!=null)original.addSuppressed(cleanup);else throw new AssertionError("Restoration test cleanup failed",cleanup);}
  }
 }
 static long host(PodRuntimeView view)throws Exception {Field field=PodRuntimeView.class.getDeclaredField("host");field.setAccessible(true);return field.getLong(view);}

 /** Each accepted request gets an independent worker, so a canceled held
  * request can never block the next Activity's request in accept(). */
 static final class GatedServer implements AutoCloseable {
  final ServerSocket listener;final ExecutorService workers;final Thread acceptor;
  final List<Plan> plans=new ArrayList<>();final Set<Socket> sockets=Collections.synchronizedSet(new HashSet<>());
  final AtomicInteger requests=new AtomicInteger();volatile boolean closed;volatile Throwable failure;
  GatedServer(boolean pending,boolean immediate)throws Exception {
   plans.add(new Plan(1,false));plans.add(new Plan(2,!immediate));if(pending)plans.add(new Plan(3,true));
   listener=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));
   workers=Executors.newCachedThreadPool(task->{Thread worker=new Thread(task,"legal-top-http-worker");worker.setDaemon(true);return worker;});
   acceptor=new Thread(()->{while(!closed){Socket accepted=null;try{
    accepted=listener.accept();if(closed){accepted.close();continue;}final Socket socket=accepted;sockets.add(socket);workers.execute(()->serve(socket));accepted=null;
   }catch(Exception error){if(accepted!=null){sockets.remove(accepted);try{accepted.close();}catch(Exception ignored){}}if(!closed)failure=error;}}},"legal-top-http-accept");
   acceptor.setDaemon(true);acceptor.start();
  }
  String baseUrl(){return "http://127.0.0.1:"+listener.getLocalPort();}
  Plan plan(int number){return plans.get(number-1);}
  void serve(Socket socket){
   Plan plan=null;boolean responseStarted=false;
   try(Socket owned=socket){
    owned.setSoTimeout(5000);BufferedReader reader=new BufferedReader(new InputStreamReader(owned.getInputStream(),StandardCharsets.US_ASCII));
    String first=reader.readLine();if(first==null)throw new java.io.IOException("Empty HTTP request");String[] parts=first.split(" ");
    if(parts.length<2||!"GET".equals(parts[0])||!PATH.equals(parts[1]))throw new java.io.IOException("Unexpected legal HTTP request: "+first);
    for(String line;(line=reader.readLine())!=null&&!line.isEmpty();){}
    int number=requests.incrementAndGet();if(number>plans.size())throw new java.io.IOException("Unexpected extra legal request "+number);
    plan=plan(number);plan.path=parts[1];plan.receivedAt=SystemClock.uptimeMillis();plan.received.countDown();
    if(!plan.gate.await(20,TimeUnit.SECONDS))throw new java.io.IOException("Held response was not released");
    if(closed)return;
    responseStarted=true;
    byte[] bytes=BODY.getBytes(StandardCharsets.UTF_8);
    owned.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: "+bytes.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
    owned.getOutputStream().write(bytes);owned.getOutputStream().flush();plan.written=true;
   }catch(Exception error){if(plan!=null)plan.error=error.toString();boolean canceledWrite=plan!=null&&plan.expectedCancellation&&responseStarted&&error instanceof java.io.IOException;if(!closed&&!canceledWrite)failure=error;}
   finally{if(plan!=null)plan.finished.countDown();sockets.remove(socket);}
  }
  void awaitRequest(int number,long timeout)throws Exception {assertTrue("Request "+number+" missing",plan(number).received.await(timeout,TimeUnit.MILLISECONDS));assertHealthy();}
  void awaitCompleted()throws Exception {for(Plan plan:plans){assertTrue("HTTP worker did not finish",plan.finished.await(3,TimeUnit.SECONDS));if(!plan.expectedCancellation)assertTrue("Live response must be written",plan.written);}assertEquals(plans.size(),requests.get());assertHealthy();}
  void assertHealthy(){if(failure!=null)throw new AssertionError("Concurrent legal HTTP server failed",failure);}
  JSONObject evidence()throws Exception {JSONArray rows=new JSONArray();for(Plan plan:plans)rows.put(plan.evidence());return new JSONObject().put("requestCount",requests.get()).put("plans",rows).put("failure",failure==null?JSONObject.NULL:failure.toString());}
  @Override public void close()throws Exception {
   closed=true;for(Plan plan:plans)plan.gate.countDown();listener.close();
   synchronized(sockets){for(Socket socket:sockets)try{socket.close();}catch(Exception ignored){}}
   workers.shutdownNow();acceptor.join(3000);assertFalse("HTTP acceptor leaked",acceptor.isAlive());assertTrue("HTTP request worker leaked",workers.awaitTermination(3,TimeUnit.SECONDS));
  }
 }
 static final class Plan {
  final int number;final boolean held;final CountDownLatch gate,received=new CountDownLatch(1),finished=new CountDownLatch(1);
  volatile String path,error;volatile long receivedAt,releasedAt;volatile boolean written,expectedCancellation;
  Plan(int number,boolean held){this.number=number;this.held=held;gate=new CountDownLatch(held?1:0);}
  void release(){releasedAt=SystemClock.uptimeMillis();assertTrue("Live held response must be released before the 12-second client read timeout",expectedCancellation||!held||receivedAt>0&&releasedAt-receivedAt<11000);gate.countDown();}
  JSONObject evidence()throws Exception {return new JSONObject().put("number",number).put("held",held).put("received",received.getCount()==0).put("path",path==null?JSONObject.NULL:path)
   .put("receivedAtUptimeMs",receivedAt).put("releasedAtUptimeMs",releasedAt).put("responseWritten",written).put("finished",finished.getCount()==0)
   .put("expectedCancellation",expectedCancellation).put("error",error==null?JSONObject.NULL:error);}
 }
}
