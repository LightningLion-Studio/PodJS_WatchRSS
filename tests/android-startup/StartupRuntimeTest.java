package dev.podjs.runtime;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Application;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/** Only this isolated package is seeded. Semantic activation calls the exact
 * live onPress callback; no touch, key, rotary or focus input is injected. */
public final class StartupRuntimeTest {
 final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
 final Context context=instrumentation.getTargetContext();
 Activity activity;
 PodRuntimeView view;
 @Test public void publicTextEnvironmentMatchesActivityResourcesAcrossRecreation() throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  android.content.res.Configuration initialConfiguration=new android.content.res.Configuration(context.getResources().getConfiguration());
  JSONObject sentinel=new JSONObject().put("keep","unchanged").put("value",731);
  try {
   write(new JSONObject().put("text-environment-fixture",true).put("text-environment-sentinel",sentinel));
   launch();awaitLabel("文字环境已就绪");JSONObject before=read().getJSONObject("text-environment-result");
   assertEquals(1,before.getInt("run"));assertTextEnvironment(before);assertJson(sentinel,read().getJSONObject("text-environment-sentinel"));
   recreateActivity();awaitLabel("文字环境已就绪");JSONObject after=read().getJSONObject("text-environment-result");
   assertEquals(2,after.getInt("run"));assertTextEnvironment(after);
   assertJson(before.getJSONObject("queried"),after.getJSONObject("queried"));
   assertJson(sentinel,read().getJSONObject("text-environment-sentinel"));
   assertEquals(initialConfiguration,context.getResources().getConfiguration());
   JSONObject proof=new JSONObject().put("state","passed").put("publicJavaScriptApiVerified",true)
    .put("beforeRecreation",before).put("afterRecreation",after).put("realActivityRecreationVerified",true)
    .put("platformSpValuesMatchActivityResources",true).put("deviceConfigurationUnchanged",true)
    .put("physicalInputInjected",false).put("nonDefaultSystemFontScaleVerified",false);
   Files.write(new File(context.getFilesDir(),"text-environment-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  }finally{finish();}
 }
 void assertTextEnvironment(JSONObject result)throws Exception {
  assertEquals("passed",result.getString("state"));
  android.content.res.Resources resources=activity.getResources();android.util.DisplayMetrics metrics=resources.getDisplayMetrics();
  for(String key:new String[]{"queried","empty"}){
   JSONObject value=result.getJSONObject(key);
   assertEquals(metrics.density,value.getDouble("density"),0.00001);
   assertEquals(resources.getConfiguration().fontScale,value.getDouble("fontScale"),0.00001);
  }
  assertEquals(0,result.getJSONObject("empty").getJSONArray("spValuesPx").length());
  JSONArray values=result.getJSONObject("queried").getJSONArray("spValuesPx");float[] requested={12,14,21,26,12};assertEquals(requested.length,values.length());
  for(int index=0;index<requested.length;index++)assertEquals(android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP,requested[index],metrics),values.getDouble(index),0.00001);
 }
 @Test public void privacyGatePersistsOnlyAgreementAndRelaunchesCorrectly() throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  JSONObject proof=new JSONObject();
  try {
   JSONObject seed=new JSONObject().put("startup-content-mounts",0).put("preserved-fixture-data",new JSONObject().put("articles",new JSONArray().put("kept")).put("revision",7));
   JSONObject consent=new JSONObject().put("oobeSeenVersion",3).put("privacyPolicyAgreedVersion",0).put("futureField","preserved");
   seed.put("watchrss.onboarding",consent);write(seed);
   launch();awaitLabel("不同意");awaitNavigation(false,false);proof.put("privacyPlatformSwipe",platformSwipeProbe(true));capture("privacy");assertEquals(0,read().getInt("startup-content-mounts"));
   activate("查看《隐私政策》");awaitNavigation(true,false);
   instrumentation.runOnMainSync(()->assertTrue(view.sendBack()));awaitNavigation(false,false);awaitLabel("不同意");
   proof.put("legalBackRestoresPrivacyGate",true);
   activate("不同意");awaitDestroyed();
   assertJson(seed,read());proof.put("declineLeavesAllDataUnchanged",true);
   launch();awaitLabel("同意");assertEquals(0,read().getInt("startup-content-mounts"));
   activate("同意");awaitDestroyed();
   JSONObject saved=read();assertEquals(1,saved.getJSONObject("watchrss.onboarding").getInt("privacyPolicyAgreedVersion"));
   assertEquals(3,saved.getJSONObject("watchrss.onboarding").getInt("oobeSeenVersion"));
   assertEquals("preserved",saved.getJSONObject("watchrss.onboarding").getString("futureField"));
   assertEquals(seed.getJSONObject("preserved-fixture-data").toString(),saved.getJSONObject("preserved-fixture-data").toString());
   JSONObject expected=new JSONObject(seed.toString());expected.getJSONObject("watchrss.onboarding").put("privacyPolicyAgreedVersion",1);
   assertJson(expected,saved);
   assertEquals(0,saved.getInt("startup-content-mounts"));proof.put("agreementSavedBeforeExit",true);
   launch();awaitLabel("验证主页");awaitNavigation(false,true);proof.put("contentPlatformSwipe",platformSwipeProbe(false));assertEquals(1,read().getInt("startup-content-mounts"));proof.put("nextLaunchMountsContentOnce",true);
   finish();
   seed.remove("watchrss.onboarding");write(seed);
   launch();awaitLabel("下一页");awaitNavigation(false,false);capture("welcome");assertEquals(0,read().getInt("startup-content-mounts"));assertFalse(read().has("watchrss.onboarding"));
   activate("下一页");awaitLabel("下一页");activate("下一页");SystemClock.sleep(300);
   assertTrue(snapshot().toString().contains("请勾选"));awaitNavigation(true,false);capture("agreement-error");
   instrumentation.runOnMainSync(()->assertTrue(view.sendBack()));awaitNavigation(false,false);awaitLabel("欢迎使用");
   assertEquals(0,read().getInt("startup-content-mounts"));assertFalse(read().has("watchrss.onboarding"));
   proof.put("freshIntroDoesNotMountOrPersistConsent",true);
   finish();seed.put("watchrss.onboarding",new JSONObject().put("privacyPolicyAgreedVersion","corrupt"));write(seed);
   launch();awaitLabel("启动记录无法读取");awaitNavigation(false,false);assertJson(seed,read());
   activate("重新读取");awaitLabel("启动记录无法读取");assertJson(seed,read());
   proof.put("corruptConsentPreservedOnRetry",true).put("hostSwipePolicyAndInternalBackVerified",true).put("physicalSwipeVerified",false).put("physicalInputInjected",false).put("state","passed");
   Files.write(new File(context.getFilesDir(),"startup-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  } finally {finish();}
 }
 @Test public void firstIntroCompletesWithoutPersistingDemonstrationSettings() throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  JSONObject proof=new JSONObject();
  try {
   JSONObject seed=new JSONObject().put("startup-content-mounts",0).put("preserved-fixture-data",new JSONObject().put("articles",new JSONArray().put("kept")).put("revision",8))
    .put("watchrss.onboarding",new JSONObject().put("oobeSeenVersion",0).put("privacyPolicyAgreedVersion",0).put("futureField","preserved"));
   write(seed);launch();awaitLabel("下一页");activate("下一页");activate("同意用户协议与隐私政策");
   assertJson(seed,read());activate("下一页");awaitLabel("自定义");awaitNavigation(true,false);
   activate("增大字体");awaitLabel("16sp");assertJson(seed,read());capture("customization-font");
   int scrolls=0;while(!hasLabel(snapshot(),"下一页")&&scrolls<12){performAction("自定义设置",2);scrolls++;}
   awaitLabel("下一页");assertTrue("Customization must scroll through real entries",scrolls>0);
   activate("提高静音开播上限");awaitLabel("0%");assertJson(seed,read());capture("customization-limit");
   activate("下一页");awaitLabel("互联网");
   long end=SystemClock.uptimeMillis()+15000;String status="";
   while(SystemClock.uptimeMillis()<end){String tree=snapshot().toString();if(tree.contains("未检测到可用互联网")){status="unavailable";break;}if(tree.contains("已连接蓝牙网络")){status="bluetooth";break;}if(tree.contains("已检测到互联网")){status="available";break;}SystemClock.sleep(100);}
   assertFalse("Network observation did not resolve",status.isEmpty());assertJson(seed,read());
   activate("继续");
   boolean offline=!status.equals("available");
   if(offline){
    awaitLabel("确认继续");recreateActivity();awaitLabel("确认继续");assertFalse("Underlying continue must be hidden from semantics",hasLabel(snapshot(),"继续"));assertJson(seed,read());
    activate("取消");awaitLabel("互联网");assertJson(seed,read());
    activate("继续");awaitLabel("确认继续");activate("确认继续");
   }
   awaitLabel("验证主页");awaitNavigation(false,true);
   JSONObject expected=new JSONObject(seed.toString());expected.put("startup-content-mounts",1);expected.getJSONObject("watchrss.onboarding").put("oobeSeenVersion",3).put("privacyPolicyAgreedVersion",1);assertJson(expected,read());
   Field serviceField=PodRuntimeView.class.getDeclaredField("services");serviceField.setAccessible(true);Object services=serviceField.get(view);
   Field networkField=services.getClass().getDeclaredField("networks");networkField.setAccessible(true);Object networks=networkField.get(services);
   Field subscriptions=networks.getClass().getDeclaredField("subscriptions");subscriptions.setAccessible(true);synchronized(networks){assertTrue(((java.util.Map<?,?>)subscriptions.get(networks)).isEmpty());}
   proof.put("consentCheckboxExercised",true).put("demonstrationFontChangedWithoutSaving",true).put("demonstrationVolumeLimitChangedWithoutSaving",true)
    .put("semanticScrolls",scrolls).put("observedNetworkStatus",status).put("offlineCancelAndConfirmationExercised",offline).put("contentMountedOnlyAfterConsent",true)
    .put("sameActivitySwipePolicyRestored",true).put("networkSubscriptionReleased",true);
   finish();launch();awaitLabel("验证主页");assertEquals(2,read().getInt("startup-content-mounts"));
   proof.put("completedIntroSkippedOnRelaunch",true).put("physicalInputInjected",false).put("state","passed");
   Files.write(new File(context.getFilesDir(),"onboarding-completion-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  } finally {finish();}
 }
 @Test public void themeTogglePreservesExistingPresetsAndEnvelopeAcrossRelaunch() throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  try {
   JSONObject seed;try(java.io.InputStream in=instrumentation.getContext().getAssets().open("theme-seed.json")){seed=new JSONObject(new String(readBytes(in),StandardCharsets.UTF_8));}
   write(seed);launch();activate("下一页");activate("同意用户协议与隐私政策");activate("下一页");awaitLabel("切换阅读主题");
   assertJson(seed,read());activate("切换阅读主题");
   JSONObject expected=new JSONObject(seed.toString());expected.getJSONObject("watchrss.reader-presets").getJSONObject("selection").put("mode","LIGHT");
   assertJson(expected,read());capture("theme-light");finish();
   launch();activate("下一页");activate("同意用户协议与隐私政策");activate("下一页");awaitLabel("切换阅读主题");assertJson(expected,read());
   activate("切换阅读主题");assertJson(seed,read());capture("theme-dark");
   JSONObject proof=new JSONObject().put("state","passed").put("lightThemePersistsAcrossRelaunch",true).put("secondToggleRestoresDark",true)
    .put("presetRecordsAssetsAndUnknownEnvelopePreserved",true).put("settingsAndConsentUnchanged",true).put("physicalInputInjected",false);
   Files.write(new File(context.getFilesDir(),"onboarding-theme-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  } finally {finish();}
 }
 @Test public void hostActivityStateSurvivesRecreationButNotFreshLaunch() throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  try {
   write(new JSONObject().put("activity-state-fixture",true));launch();awaitLabel("状态已就绪");
   assertJson(new JSONObject().put("saved",new JSONObject()).put("retained",new JSONObject()),read().getJSONObject("activity-state-observed"));
   Instrumentation.ActivityMonitor monitor=instrumentation.addMonitor("dev.podjs.androidwatch.MainActivity",null,false);
   Activity previous=activity;
   try {instrumentation.runOnMainSync(previous::recreate);activity=instrumentation.waitForMonitorWithTimeout(monitor,15000);assertNotNull("Recreated Activity missing",activity);assertNotSame(previous,activity);}
   finally {instrumentation.removeMonitor(monitor);}
   long end=SystemClock.uptimeMillis()+15000;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);
   awaitLabel("状态已就绪");JSONObject observed=read().getJSONObject("activity-state-observed");assertTrue(observed.getJSONObject("saved").getJSONObject("checkpoint").getBoolean("agreed"));assertEquals(2,observed.getJSONObject("retained").getInt("page"));
   android.os.Bundle bundle=new android.os.Bundle();instrumentation.runOnMainSync(()->instrumentation.callActivityOnSaveInstanceState(activity,bundle));
   String saved=bundle.getString("dev.podjs.activity-state");assertNotNull(saved);assertFalse(new JSONObject(saved).has("page"));
   PodActivityState afterProcess=new PodActivityState();afterProcess.restore(saved,null);assertJson(observed.getJSONObject("saved"),afterProcess.read().getJSONObject("saved"));assertEquals(0,afterProcess.read().getJSONObject("retained").length());
   finish();launch();awaitLabel("状态已就绪");assertJson(new JSONObject().put("saved",new JSONObject()).put("retained",new JSONObject()),read().getJSONObject("activity-state-observed"));
   JSONObject proof=new JSONObject().put("state","passed").put("realActivityRecreationVerified",true).put("savedAndRetainedRecovered",true).put("freshLaunchStartsEmpty",true)
    .put("bundleExcludesRetained",true).put("bundleOnlyRestoreBoundaryVerified",true).put("actualProcessDeathVerified",false).put("physicalInputInjected",false);
   Files.write(new File(context.getFilesDir(),"activity-state-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  }finally{finish();}
 }
 @Test public void activityStateRejectsOversizeAtomicallyAndReturnsCopies() throws Exception {
  PodActivityState state=new PodActivityState();state.write(new JSONObject().put("keep",true),new JSONObject().put("page",2));
  JSONObject copy=state.read();copy.getJSONObject("saved").put("keep",false);assertTrue(state.read().getJSONObject("saved").getBoolean("keep"));
  String before=state.saved();StringBuilder large=new StringBuilder();for(int n=0;n<24000;n++)large.append('中');
  try{state.write(new JSONObject().put("value",large.toString()),new JSONObject());fail("Expected UTF-8 limit");}catch(IllegalArgumentException expected){}
  assertEquals(before,state.saved());assertEquals(2,state.read().getJSONObject("retained").getInt("page"));
  state.restore("[1]",null);try{state.read();fail("Expected corrupt restore error");}catch(IllegalArgumentException expected){}
  assertEquals("[1]",state.saved());state.restore(null,null);assertEquals(0,state.read().getJSONObject("saved").length());
 }
 @Test public void introDraftRestoresAcrossRecreationWithoutSavingConsent() throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  try {
   JSONObject seed=new JSONObject().put("startup-content-mounts",0).put("watchrss.onboarding",new JSONObject().put("oobeSeenVersion",0).put("privacyPolicyAgreedVersion",0));
   write(seed);launch();activate("下一页");activate("下一页");recreateActivity();awaitLabel("同意用户协议与隐私政策");assertTrue(snapshot().toString().contains("请勾选"));assertFalse(checkboxChecked());
   activate("同意用户协议与隐私政策");assertJson(seed,read());
   recreateActivity();awaitLabel("同意用户协议与隐私政策");awaitNavigation(true,false);assertTrue(checkboxChecked());assertJson(seed,read());
   activate("下一页");awaitLabel("自定义");recreateActivity();awaitLabel("自定义");awaitNavigation(true,false);assertJson(seed,read());
   finish();launch();awaitLabel("欢迎使用");activate("下一页");assertFalse(checkboxChecked());assertJson(seed,read());
   JSONObject proof=new JSONObject().put("state","passed").put("agreementErrorRestored",true).put("agreementPageAndCheckboxRestored",true).put("customizationPageRestored",true)
    .put("freshLaunchResetsDraft",true).put("persistentConsentUnchanged",true).put("customizationValuesAndScrollRestored",false).put("actualProcessDeathVerified",false).put("physicalInputInjected",false);
   Files.write(new File(context.getFilesDir(),"onboarding-restoration-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  }finally{finish();}
 }
 @Test public void customizationDraftAndScrollRestoreOnlyWhileStepRemainsMounted() throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  try {
   JSONObject seed;try(java.io.InputStream in=instrumentation.getContext().getAssets().open("theme-seed.json")){seed=new JSONObject(new String(readBytes(in),StandardCharsets.UTF_8));}
   write(seed);launch();activate("下一页");activate("同意用户协议与隐私政策");activate("下一页");awaitLabel("自定义");awaitLabel("14sp");
   JSONArray initialTop=stableCustomizationGeometry();assertJson(seed,read());
   activate("增大字体");awaitLabel("16sp");assertJson(seed,read());
   int scrolls=scrollCustomizationTo("使用滚轮调节音量",2,true);assertCheckbox("使用滚轮调节音量",true);
   scrolls+=scrollCustomizationTo("音量调节防干扰",2,true);assertCheckbox("音量调节防干扰",false);
   activate("音量调节防干扰");assertCheckbox("音量调节防干扰",true);assertJson(seed,read());
   scrolls+=scrollCustomizationTo("下一页",2,false);awaitLabel("提高静音开播上限");
   activate("提高静音开播上限");awaitLabel("0%");assertJson(seed,read());
   JSONArray beforeRecreation=stableCustomizationGeometry();assertTrue("Must exercise a scrolled viewport",scrolls>0);
   assertFalse("Scrolled viewport must differ from the initial top",beforeRecreation.toString().equals(initialTop.toString()));
   capture("customization-restore-before");
   recreateActivity();awaitLabel("0%");awaitNavigation(true,false);
   JSONArray afterRecreation=awaitCustomizationGeometry(beforeRecreation);assertJson(seed,read());capture("customization-restore-after");
   scrolls+=scrollCustomizationTop();awaitLabel("16sp");assertJson(seed,read());
   scrolls+=scrollCustomizationTo("使用滚轮调节音量",2,true);assertCheckbox("使用滚轮调节音量",true);
   scrolls+=scrollCustomizationTo("音量调节防干扰",2,true);assertCheckbox("音量调节防干扰",true);
   scrolls+=scrollCustomizationTo("使用滚轮调节音量",4,true);activate("使用滚轮调节音量");assertCheckbox("使用滚轮调节音量",false);assertJson(seed,read());
   JSONArray beforeDisabledRecreation=stableCustomizationGeometry();recreateActivity();assertCheckbox("使用滚轮调节音量",false);
   JSONArray afterDisabledRecreation=awaitCustomizationGeometry(beforeDisabledRecreation);assertJson(seed,read());
   scrolls+=scrollCustomizationTop();
   int hiddenGuardScrolls=0;
   while(true){
    JSONObject tree=snapshot();assertFalse("Disabled volume must remove the guard throughout the list",hasLabel(tree,"音量调节防干扰"));
    if(hasLabel(tree,"下一页"))break;
    assertTrue("Disabled customization did not reach the bottom",hiddenGuardScrolls<12);performAction("自定义设置",2);hiddenGuardScrolls++;
   }
   scrolls+=hiddenGuardScrolls;assertJson(seed,read());
   scrolls+=scrollCustomizationTo("使用滚轮调节音量",4,true);activate("使用滚轮调节音量");assertCheckbox("使用滚轮调节音量",true);
   scrolls+=scrollCustomizationTo("音量调节防干扰",2,true);assertCheckbox("音量调节防干扰",true);assertJson(seed,read());
   scrolls+=scrollCustomizationTo("下一页",2,false);awaitLabel("0%");activate("下一页");awaitLabel("互联网");assertJson(seed,read());
   instrumentation.runOnMainSync(()->assertTrue(view.sendBack()));awaitLabel("自定义");awaitLabel("14sp");
   JSONArray returnedTop=awaitCustomizationGeometry(initialTop);assertJson(seed,read());capture("customization-return-defaults");
   scrolls+=scrollCustomizationTo("使用滚轮调节音量",2,true);assertCheckbox("使用滚轮调节音量",true);
   scrolls+=scrollCustomizationTo("音量调节防干扰",2,true);assertCheckbox("音量调节防干扰",false);
   scrolls+=scrollCustomizationTo("无限制",2,false);assertJson(seed,read());
   JSONObject proof=new JSONObject().put("state","passed").put("realActivityRecreations",2).put("font16spRestored",true)
    .put("volumeAndGuardCheckboxStatesRestored",true).put("zeroPercentLimitRestored",true).put("scrollViewportGeometryRestored",true)
    .put("beforeRecreationGeometry",beforeRecreation).put("afterRecreationGeometry",afterRecreation).put("geometryTolerancePixels",1)
    .put("disabledVolumeRestored",true).put("disabledGuardAbsentAcrossList",true).put("guardValueRetainedWhenReenabled",true)
    .put("beforeDisabledRecreationGeometry",beforeDisabledRecreation).put("afterDisabledRecreationGeometry",afterDisabledRecreation)
    .put("leavingAndReturningResetsDemonstrationValues",true).put("leavingAndReturningResetsScroll",true)
    .put("initialTopGeometry",initialTop).put("returnedTopGeometry",returnedTop).put("allPersistentKvUnchanged",true)
    .put("semanticScrolls",scrolls).put("actualProcessDeathVerified",false).put("physicalInputInjected",false);
   Files.write(new File(context.getFilesDir(),"onboarding-customization-restoration-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  }finally{finish();}
 }
 @Test public void publicActivityStateCapacitySurvivesRecreationAndRejectsEachOverflowAtomically() throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  try {
   JSONObject seed=new JSONObject().put("activity-state-capacity-fixture",true).put("preserved-fixture-data",new JSONObject().put("revision",19).put("articles",new JSONArray().put("kept")));
   write(seed);launch();JSONObject before=awaitCapacityResult(1,false);
   assertJson(new JSONObject(seed.toString()).put("activity-state-capacity-result",before),read());assertTrue("Capacity payloads must not be copied into KV",kv().length()<8192);
   int bundleBefore=assertCapacityBundle();
   recreateActivity();JSONObject after=awaitCapacityResult(2,true);
   assertJson(new JSONObject(seed.toString()).put("activity-state-capacity-result",after),read());assertTrue("Recreated capacity probe must store only a summary",kv().length()<8192);
   int bundleAfter=assertCapacityBundle();
   JSONObject proof=new JSONObject().put("state","passed").put("realActivityRecreationVerified",true).put("publicApiBoundaryWritesAndReadsVerified",true)
    .put("savedJsonBytes",64*1024).put("retainedJsonBytes",896*1024).put("asciiPayloads",true)
    .put("firstLaunch",before).put("afterRecreation",after).put("recreatedProbeReadBeforeWriting",true).put("recreatedProbeDidNotReseed",true)
    .put("bothOneByteOverflowsRejectedAtomicallyOnBothRuns",true).put("allPayloadCharactersComparedOnReadback",true)
    .put("savedBundleBytesBeforeRecreation",bundleBefore).put("savedBundleBytesAfterRecreation",bundleAfter).put("savedBundleContainsRetained",false)
    .put("persistentFixtureDataUnchanged",true).put("kvContainsOnlyProbeSummary",true).put("actualProcessDeathVerified",false).put("physicalInputInjected",false);
   Files.write(new File(context.getFilesDir(),"activity-state-capacity-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  }finally{finish();}
 }
 JSONObject awaitCapacityResult(int run,boolean restored)throws Exception {
  long end=SystemClock.uptimeMillis()+30000;JSONObject values=null;
  while(SystemClock.uptimeMillis()<end){
   values=read();assertFalse("Capacity probe failed: "+values.optString("activity-state-capacity-error"),values.has("activity-state-capacity-error"));
   JSONObject result=values.optJSONObject("activity-state-capacity-result");
   if(result!=null&&result.optInt("run")==run&&hasLabel(snapshot(),"状态容量验证已就绪")){
    assertEquals("passed",result.getString("state"));assertEquals(restored,result.getBoolean("restoredAtLaunch"));assertEquals(restored?0:1,result.getInt("initialAcceptedWrites"));
    assertEquals(64*1024,result.getInt("savedJsonBytes"));assertEquals(896*1024,result.getInt("retainedJsonBytes"));
    for(String key:new String[]{"readbackMatchesExactly","savedOverflowRejected","retainedOverflowRejected","afterSavedOverflowUnchanged","afterRetainedOverflowUnchanged","asciiPayloads"})assertTrue(key,result.getBoolean(key));
    assertFalse(result.getString("savedOverflowError").isEmpty());assertFalse(result.getString("retainedOverflowError").isEmpty());return result;
   }
   SystemClock.sleep(100);
  }
  throw new AssertionError("Capacity probe did not complete run "+run+": "+values);
 }
 int assertCapacityBundle()throws Exception {
  android.os.Bundle bundle=new android.os.Bundle();instrumentation.runOnMainSync(()->instrumentation.callActivityOnSaveInstanceState(activity,bundle));
  String saved=bundle.getString("dev.podjs.activity-state");assertNotNull("Saved activity state missing from Bundle",saved);
  assertEquals(64*1024,saved.getBytes(StandardCharsets.UTF_8).length);JSONObject object=new JSONObject(saved);assertEquals("Bundle must contain only the saved object",1,object.length());assertFalse(object.has("retained"));
  int payloadLength=64*1024-new JSONObject().put("payload","").toString().getBytes(StandardCharsets.UTF_8).length;
  char[] expected=new char[payloadLength];java.util.Arrays.fill(expected,'S');assertEquals("Every saved payload character must survive Bundle serialization",new String(expected),object.getString("payload"));
  return saved.getBytes(StandardCharsets.UTF_8).length;
 }
 @Test public void legalActivityStackRestoresAcrossRecreationButNotFreshLaunch() throws Exception {
  assertEquals("dev.podjs.tests.startup",context.getPackageName());
  try(LegalFixtureServer server=new LegalFixtureServer()){
   try {
    JSONObject seed;try(java.io.InputStream in=instrumentation.getContext().getAssets().open("theme-seed.json")){seed=new JSONObject(new String(readBytes(in),StandardCharsets.UTF_8));}
    seed.put("startup-legal-base-url",server.baseUrl());seed.getJSONObject("watchrss.onboarding").put("oobeSeenVersion",3);
    write(seed);launch();awaitLabel("不同意");activate("查看《隐私政策》");awaitLabel(LegalFixtureServer.PRIVACY_MARKER);awaitNavigation(true,false);
    server.assertHealthy();assertTrue("Privacy body must come from the loopback server",server.privacyRequests.get()>0);assertJson(seed,read());capture("legal-privacy-loaded");
    int footerScrolls=scrollLegalTo("浙ICP备2024111886号-5A");assertTrue("Long privacy body must require semantic scrolling",footerScrolls>0);assertFalse("Footer must be away from the first paragraph",hasLabel(snapshot(),LegalFixtureServer.PRIVACY_MARKER));
    JSONArray privacyFooterBefore=stableCustomizationGeometry();capture("legal-privacy-footer-before");
    activate("浙ICP备2024111886号-5A");assertBeianSemantics();assertJson(seed,read());SystemClock.sleep(1800);JSONObject beianBeforeSemantics=assertBeianSemantics();capture("legal-beian-before");
    int privacyBeforeRecreation=server.privacyRequests.get();recreateActivity();assertBeianSemantics();awaitNavigation(true,false);assertJson(seed,read());SystemClock.sleep(1800);JSONObject beianAfterSemantics=assertBeianSemantics();capture("legal-beian-after");
    instrumentation.runOnMainSync(()->assertTrue(view.sendBack()));awaitMissingLabel("标题：工信部备案");awaitLabel("浙ICP备2024111886号-5A");awaitNavigation(true,false);
    JSONArray privacyFooterAfter=awaitCustomizationGeometry(privacyFooterBefore);assertJson(seed,read());capture("legal-privacy-after-back");
    int privacyAfterBack=server.privacyRequests.get();assertEquals("Retained lower privacy page must not request its body again",privacyBeforeRecreation,privacyAfterBack);
    instrumentation.runOnMainSync(()->assertTrue(view.sendBack()));awaitLabel("不同意");awaitLabel("同意");awaitNavigation(false,false);awaitMissingLabel(LegalFixtureServer.PRIVACY_MARKER);assertJson(seed,read());
    activate("查看《隐私政策》");awaitLabel(LegalFixtureServer.PRIVACY_MARKER);footerScrolls+=scrollLegalTo("浙ICP备2024111886号-5A");activate("浙ICP备2024111886号-5A");assertBeianSemantics();awaitRetainedPrivacyBackground(server.baseUrl());assertJson(seed,read());
    int privacyBeforeSavedOnly=server.privacyRequests.get();
    // Recreate normally, then drop retained only in the new host before its
    // guest boots. This injection is a simulation, not process death or a
    // claim that Android omitted retained data from its own recreation path.
    JSONObject savedOnlyInjection=recreateWithSavedOnlyInjection(server.baseUrl());
    assertBeianSemantics();awaitLegalRequests(server.privacyRequests,privacyBeforeSavedOnly+1);
    JSONObject rebuiltBackground=awaitRetainedPrivacyBackground(server.baseUrl());assertJson(seed,read());int privacyAfterSavedOnly=server.privacyRequests.get();
    recreateActivity();assertBeianSemantics();awaitRetainedPrivacyBackground(server.baseUrl());assertJson(seed,read());
    instrumentation.runOnMainSync(()->assertTrue(view.sendBack()));awaitMissingLabel("标题：工信部备案");awaitLabel(LegalFixtureServer.PRIVACY_MARKER);awaitNavigation(true,false);capture("legal-privacy-after-saved-only");
    int privacyAfterRepeatedRecreation=server.privacyRequests.get();assertEquals("Refetched lower body must be retained for the next recreation",privacyAfterSavedOnly,privacyAfterRepeatedRecreation);assertJson(seed,read());
    instrumentation.runOnMainSync(()->assertTrue(view.sendBack()));awaitLabel("不同意");awaitNavigation(false,false);awaitMissingLabel(LegalFixtureServer.PRIVACY_MARKER);assertJson(seed,read());
    finish();JSONObject introSeed=new JSONObject(seed.toString());introSeed.getJSONObject("watchrss.onboarding").put("oobeSeenVersion",0);write(introSeed);
    launch();awaitLabel("欢迎使用");activate("下一页");activate("同意用户协议与隐私政策");assertTrue(checkboxChecked());activate("《用户协议》");awaitLabel(LegalFixtureServer.AGREEMENT_MARKER);assertJson(introSeed,read());
    int agreementBeforeRecreation=server.agreementRequests.get();assertTrue("User agreement body must come from the loopback server",agreementBeforeRecreation>0);capture("legal-agreement-before-recreate");
    recreateActivity();awaitLabel(LegalFixtureServer.AGREEMENT_MARKER);awaitNavigation(true,false);awaitLegalRequests(server.agreementRequests,agreementBeforeRecreation+1);assertJson(introSeed,read());capture("legal-agreement-after-recreate");
    int agreementAfterRecreation=server.agreementRequests.get();
    instrumentation.runOnMainSync(()->assertTrue(view.sendBack()));awaitMissingLabel(LegalFixtureServer.AGREEMENT_MARKER);awaitLabel("同意用户协议与隐私政策");assertTrue(checkboxChecked());awaitNavigation(true,false);assertJson(introSeed,read());
    // Exit while a legal page is open, so a fresh launch really tests that the
    // previous Activity stack is discarded rather than merely remaining empty.
    activate("《用户协议》");awaitLabel(LegalFixtureServer.AGREEMENT_MARKER);assertJson(introSeed,read());finish();
    launch();awaitLabel("欢迎使用");awaitNavigation(false,false);awaitMissingLabel(LegalFixtureServer.AGREEMENT_MARKER);awaitMissingLabel("用户协议");assertJson(introSeed,read());
    activate("下一页");assertFalse("A fresh intro must not retain the agreement checkbox",checkboxChecked());assertJson(introSeed,read());server.assertHealthy();
    JSONObject proof=new JSONObject().put("state","passed").put("realActivityRecreations",4).put("reconfigurationRestoresLegalStack",true)
     .put("privacyFooterOpensBeian",true).put("beianRemainsTopAfterRecreation",true).put("firstBackReturnsToPrivacyBody",true).put("secondBackReturnsToPrivacyGate",true)
     .put("beianHasFourIndependentNonInteractiveSemanticNodes",true).put("beianBeforeRecreationSemantics",beianBeforeSemantics).put("beianAfterRecreationSemantics",beianAfterSemantics)
     .put("privacyRequestsBeforeRecreation",privacyBeforeRecreation).put("privacyRequestsAfterBack",privacyAfterBack).put("lowerPrivacyBodyRetainedWithoutRefetch",true)
     .put("lowerPrivacyFooterPositionRetained",true).put("privacyFooterBeforeGeometry",privacyFooterBefore).put("privacyFooterAfterGeometry",privacyFooterAfter).put("geometryTolerancePixels",1)
     .put("savedOnlyBoundarySimulated",true).put("savedOnlyInjection",savedOnlyInjection).put("backgroundFetchRetainedForNextRecreation",true)
     .put("legalSnapshotSchemaVersion",2).put("rebuiltBackgroundBodyReference",rebuiltBackground.getJSONObject("bodyReference"))
     .put("rebuiltBackgroundBodyByteLength",rebuiltBackground.getJSONObject("bodyReference").getLong("byteLength")).put("rebuiltBackgroundBodyReferenceVerified",true)
     .put("privacyRequestsBeforeSavedOnly",privacyBeforeSavedOnly).put("privacyRequestsAfterSavedOnly",privacyAfterSavedOnly).put("privacyRequestsAfterRepeatedRecreation",privacyAfterRepeatedRecreation)
     .put("topUserAgreementRefetchedAfterRecreation",true).put("agreementRequestsBeforeRecreation",agreementBeforeRecreation).put("agreementRequestsAfterRecreation",agreementAfterRecreation).put("agreementRequestsAfterTest",server.agreementRequests.get())
     .put("backRestoresIntroAgreementCheckbox",true).put("freshLaunchRestoresLegalStack",false).put("freshLaunchReturnsToWelcome",true).put("freshLaunchResetsAgreementCheckbox",true)
     .put("allPersistentKvUnchanged",true).put("legalHttpLoopbackOnly",true).put("legalRequestPaths",server.requestPaths()).put("semanticFooterScrolls",footerScrolls)
     .put("actualProcessDeathVerified",false).put("physicalInputInjected",false);
    Files.write(new File(context.getFilesDir(),"onboarding-legal-restoration-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
   }finally{finish();}
  }
 }
 JSONObject assertBeianSemantics()throws Exception {
  String[] labels={"备案信息页面。使用手机扫描二维码访问工业和信息化部备案查询网站。","标题：工信部备案","备案查询网址：beian.miit.gov.cn","备案查询二维码，扫描后可在手机浏览器中打开备案查询页面"};
  String[] roles={"text","header","text","image"};long end=SystemClock.uptimeMillis()+15000;JSONObject tree=null;
  while(SystemClock.uptimeMillis()<end){
   tree=snapshot();boolean ready=tree!=null;for(String label:labels)ready=ready&&hasLabel(tree,label);
   if(!ready){SystemClock.sleep(100);continue;}
   JSONArray nodes=tree.getJSONArray("nodes");java.util.Set<Integer> identities=new java.util.HashSet<>();
   for(int expected=0;expected<labels.length;expected++){
    int count=0;JSONObject target=null;
    for(int n=0;n<nodes.length();n++){JSONObject node=nodes.getJSONObject(n);if(labels[expected].equals(node.optString("label"))){count++;target=node;}}
    assertEquals("Each Beian description must be an independent node: "+labels[expected],1,count);assertNotNull(target);
    assertEquals("Beian semantic role: "+labels[expected],roles[expected],target.getString("role"));assertEquals("Beian display content must not expose an action",0,target.getInt("actions"));
    assertTrue("Beian semantic nodes must have distinct identities",identities.add(target.getInt("id")));
   }
   for(int n=0;n<nodes.length();n++){JSONObject node=nodes.getJSONObject(n);if("button".equals(node.optString("role")))for(String label:labels)assertFalse("Beian content must not be merged into a parent button",node.optString("label").contains(label));}
   return tree;
  }
  throw new AssertionError("Missing independent Beian semantic nodes: "+tree);
 }
 int scrollLegalTo(String label)throws Exception {
  for(int n=0;n<=12;n++){JSONObject tree=snapshot();if(hasLabel(tree,label))return n;if(n==12)throw new AssertionError("Legal footer not reachable: "+tree);performAction("协议正文",2);}
  throw new AssertionError("Unreachable legal scroll loop");
 }
 void awaitMissingLabel(String label)throws Exception {
  long end=SystemClock.uptimeMillis()+15000;JSONObject tree=null;
  while(SystemClock.uptimeMillis()<end){tree=snapshot();if(tree!=null&&!hasLabel(tree,label))return;SystemClock.sleep(100);}
  throw new AssertionError("Unexpected remaining label "+label+": "+tree);
 }
 static void awaitLegalRequests(java.util.concurrent.atomic.AtomicInteger count,int expected){
  long end=SystemClock.uptimeMillis()+10000;while(SystemClock.uptimeMillis()<end){if(count.get()>=expected)return;SystemClock.sleep(100);}assertTrue("Expected legal body request did not arrive",count.get()>=expected);
 }
 JSONObject awaitRetainedPrivacyBackground(String baseUrl)throws Exception {
  String expectedUrl=privacyDocumentUrl(baseUrl);
  long end=SystemClock.uptimeMillis()+15000;String[] retained={null};
  while(SystemClock.uptimeMillis()<end){
   instrumentation.runOnMainSync(()->retained[0]=view.retainedActivityState());
   if(retained[0]!=null){
    JSONObject stack=new JSONObject(retained[0]).optJSONObject("watchrss.startup-legal-stack");
    JSONObject entry=stack==null?null:completedPrivacySnapshot(stack,expectedUrl,false);
    if(entry!=null){
     assertPrivacyRecoveryBody(readLegalRecoveryBody(entry,legalString(stack,"owner"),expectedUrl));return entry;
    }
   }
   SystemClock.sleep(100);
  }
  throw new AssertionError("Fetched lower privacy body did not reach retained activity state: "+retained[0]);
 }
 static String privacyDocumentUrl(String baseUrl){
  assertTrue("Legal fixture identity must use its current loopback endpoint",baseUrl.matches("http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}"));
  return baseUrl+"/functions/v1/legal/watch/privacy-policy";
 }
 static String legalString(JSONObject value,String key)throws Exception {
  Object raw=value.get(key);assertTrue("Legal "+key+" must be a string",raw instanceof String);return(String)raw;
 }
 static long legalInteger(JSONObject value,String key,long minimum,long maximum)throws Exception {
  Object raw=value.get(key);assertTrue("Legal "+key+" must be numeric",raw instanceof Number);double number=((Number)raw).doubleValue();
  assertTrue("Legal "+key+" must be an integer in range",Double.isFinite(number)&&number==Math.rint(number)&&number>=minimum&&number<=maximum);return(long)number;
 }
 static void assertLegalIdentity(JSONObject identity,String expectedUrl)throws Exception {
  assertEquals("privacy",legalString(identity,"page"));assertEquals("Legal identity must use this run's exact URL",expectedUrl,legalString(identity,"url"));
 }
 /** A v2 body reference can survive while a recreated request is loading.
  * Wait for completed metadata as well as the immutable body reference. */
 static JSONObject completedPrivacySnapshot(JSONObject stack,String expectedUrl,boolean savedChannel)throws Exception {
  assertEquals("Legal stack schema",2L,legalInteger(stack,"version",2,2));
  assertTrue("Legal owner token",legalString(stack,"owner").matches("[A-Za-z0-9_-]{1,96}"));assertFalse("v1 backgrounds must not be published",stack.has("backgrounds"));
  JSONArray snapshots=stack.getJSONArray("snapshots");assertTrue("Legal stack is bounded to two pages",snapshots.length()<=2);
  if(savedChannel){
   JSONArray pages=stack.getJSONArray("pages");assertEquals(pages.length(),snapshots.length());
   if(pages.length()==2){assertEquals("privacy",pages.get(0));assertEquals("beian",pages.get(1));}
  }else assertFalse("Retained v2 must not copy the saved route array",stack.has("pages"));
  // The UI may already show Beian while its asynchronous checkpoint is pending.
  if(snapshots.length()!=2)return null;
  assertTrue("Beian has no document snapshot",snapshots.isNull(1));if(snapshots.isNull(0))return null;
  JSONObject entry=snapshots.getJSONObject(0);assertEquals("privacy",legalString(entry,"page"));assertLegalIdentity(entry.getJSONObject("identity"),expectedUrl);
  JSONObject state=entry.getJSONObject("state");assertFalse("Saved metadata must not embed the body",state.has("content"));assertFalse("Saved metadata must not embed base64",state.has("contentBase64"));
  Object loading=state.get("isLoading"),error=state.get("error"),scroll=state.get("scrollOffset"),anchor=state.get("listAnchor");
  assertTrue("Loading metadata must be boolean",loading instanceof Boolean);assertTrue("Error metadata must be null or a string",error==JSONObject.NULL||error instanceof String);
  legalInteger(state,"reloadKey",0,9007199254740991L);assertTrue("Scroll metadata must be finite and nonnegative",scroll instanceof Number&&Double.isFinite(((Number)scroll).doubleValue())&&((Number)scroll).doubleValue()>=0);
  if(anchor!=JSONObject.NULL){assertTrue("List anchor metadata",anchor instanceof JSONObject);legalInteger((JSONObject)anchor,"index",0,9007199254740991L);legalInteger((JSONObject)anchor,"offsetPx",0,9007199254740991L);}
  Object reference=entry.get("bodyReference");assertTrue("Body reference must be null or an object",reference==JSONObject.NULL||reference instanceof JSONObject);
  return (Boolean)loading||error!=JSONObject.NULL||reference==JSONObject.NULL?null:entry;
 }
 String readLegalRecoveryBody(JSONObject entry,String expectedOwner,String expectedUrl)throws Exception {
  assertEquals("privacy",legalString(entry,"page"));assertLegalIdentity(entry.getJSONObject("identity"),expectedUrl);
  JSONObject reference=entry.getJSONObject("bodyReference");assertEquals("Body reference schema remains v1",1L,legalInteger(reference,"version",1,1));
  assertTrue("Legal owner token",expectedOwner.matches("[A-Za-z0-9_-]{1,96}"));assertEquals("Body owner must match its stack",expectedOwner,legalString(reference,"owner"));
  assertLegalIdentity(reference.getJSONObject("identity"),expectedUrl);
  String identitySha=legalString(reference,"identitySha256"),bodySha=legalString(reference,"sha256");
  assertTrue("Identity SHA-256 must be lowercase hex",identitySha.matches("[a-f0-9]{64}"));assertTrue("Body SHA-256 must be lowercase hex",bodySha.matches("[a-f0-9]{64}"));
  // These fixture strings are restricted ASCII. JS JSON.stringify leaves '/'
  // literal, whereas Android org.json escapes it, so do not hash JSONArray text.
  assertTrue("Expected URL must be the controlled privacy fixture",expectedUrl.matches("http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/functions/v1/legal/watch/privacy-policy"));
  assertEquals("Identity digest must bind page and exact URL",sha256Text("[\"privacy\",\""+expectedUrl+"\"]"),identitySha);
  int byteLength=(int)legalInteger(reference,"byteLength",1,512*1024);String path=legalString(reference,"path");
  String prefix="legal-recovery/v1/"+expectedOwner+"/"+identitySha+"-"+bodySha+"-";
  assertTrue("Body path must use its owner and digest prefix",path.startsWith(prefix)&&path.endsWith(".utf8"));
  String token=path.substring(prefix.length(),path.length()-5);assertTrue("Body allocation token cannot contain path traversal",token.matches("[A-Za-z0-9_-]{1,96}"));
  File root=new File(context.getFilesDir(),"podjs/files").getCanonicalFile(),body=new File(root,path);
  assertEquals("Recovery path must not traverse symlinks or escape the app-owned root",body.getAbsolutePath(),body.getCanonicalPath());
  assertTrue("Recovery body must be a regular file",Files.isRegularFile(body.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS));
  byte[] bytes=new byte[byteLength];java.nio.ByteBuffer buffer=java.nio.ByteBuffer.wrap(bytes);
  try(java.nio.channels.SeekableByteChannel input=Files.newByteChannel(body.toPath(),java.nio.file.StandardOpenOption.READ,java.nio.file.LinkOption.NOFOLLOW_LINKS)){
   assertEquals("Recovery body byte length",byteLength,input.size());
   while(buffer.hasRemaining())assertTrue("Recovery body must not be truncated",input.read(buffer)>0);
   assertEquals("Recovery body must not have trailing bytes",-1,input.read(java.nio.ByteBuffer.allocate(1)));assertEquals("Recovery body size must remain immutable",byteLength,input.size());
  }
  assertEquals("Recovery body SHA-256",bodySha,sha256Bytes(bytes));
  return StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString();
 }
 static void assertPrivacyRecoveryBody(String text){
  assertTrue("Recovery body must include its fetched first paragraph",text.contains(LegalFixtureServer.PRIVACY_MARKER));assertTrue("Recovery body must include its fetched last paragraph",text.contains("隐私隔离段落20。"));
 }
 static final class LegalFixtureServer implements AutoCloseable {
  static final String PRIVACY_MARKER="隐私恢复正文",AGREEMENT_MARKER="用户恢复正文";
  final java.net.ServerSocket server;
  final java.util.concurrent.atomic.AtomicInteger privacyRequests=new java.util.concurrent.atomic.AtomicInteger(),agreementRequests=new java.util.concurrent.atomic.AtomicInteger();
  final java.util.List<String> paths=java.util.Collections.synchronizedList(new java.util.ArrayList<>());
  final Thread worker;volatile boolean closed;volatile java.net.Socket activeSocket;volatile Throwable failure;
  LegalFixtureServer()throws Exception {
   server=new java.net.ServerSocket(0,4,java.net.InetAddress.getByName("127.0.0.1"));
   worker=new Thread(()->{
    while(!closed)try(java.net.Socket socket=server.accept()){
     activeSocket=socket;socket.setSoTimeout(5000);
     java.io.BufferedReader in=new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream(),StandardCharsets.US_ASCII));
     String first=in.readLine();if(first==null)continue;String[] request=first.split(" ");if(request.length<2)throw new java.io.IOException("Malformed loopback request");
     String path=request[1];for(String line;(line=in.readLine())!=null&&!line.isEmpty();){}
     paths.add(path);String body;
     if("/functions/v1/legal/watch/privacy-policy".equals(path)){privacyRequests.incrementAndGet();StringBuilder content=new StringBuilder(PRIVACY_MARKER);for(int n=1;n<=20;n++)content.append("\n\n隐私隔离段落").append(n).append("。");body=content.toString();}
     else if("/functions/v1/legal/watch/user-agreement".equals(path)){agreementRequests.incrementAndGet();body=AGREEMENT_MARKER+"\n\n仅用于隔离测试";}
     else throw new java.io.IOException("Unexpected loopback legal path: "+path);
     byte[] bytes=body.getBytes(StandardCharsets.UTF_8);java.io.OutputStream out=socket.getOutputStream();
     out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: "+bytes.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.write(bytes);out.flush();
    }catch(Exception error){if(!closed){failure=error;break;}}finally{activeSocket=null;}
   },"startup-legal-loopback");worker.setDaemon(true);worker.start();
  }
  String baseUrl(){return "http://127.0.0.1:"+server.getLocalPort();}
  JSONArray requestPaths(){synchronized(paths){return new JSONArray(paths);}}
  void assertHealthy(){if(failure!=null)throw new AssertionError("Loopback legal server failed",failure);}
  @Override public void close()throws Exception {
   closed=true;server.close();java.net.Socket socket=activeSocket;if(socket!=null)socket.close();worker.join(3000);assertFalse("Loopback legal server thread leaked",worker.isAlive());
  }
 }
 JSONObject checkboxNode(JSONObject tree,String label)throws Exception {
  if(tree==null)return null;JSONArray nodes=tree.getJSONArray("nodes");
  for(int n=0;n<nodes.length();n++){JSONObject node=nodes.getJSONObject(n);if(label.equals(node.optString("label"))&&"checkbox".equals(node.optString("role")))return node;}
  return null;
 }
 void assertCheckbox(String label,boolean checked)throws Exception {
  long end=SystemClock.uptimeMillis()+10000;JSONObject node=null;
  while(SystemClock.uptimeMillis()<end){node=checkboxNode(snapshot(),label);if(node!=null&&(node.optInt("state")&64)!=0&&((node.optInt("state")&4)!=0)==checked){assertTrue("Checkbox must expose its real activation callback",(node.optInt("actions")&1)!=0);return;}SystemClock.sleep(100);}
  fail("Checkbox "+label+" expected checked="+checked+": "+node);
 }
 int scrollCustomizationTo(String label,int action,boolean checkbox)throws Exception {
  for(int n=0;n<=12;n++){JSONObject tree=snapshot();if(checkbox?checkboxNode(tree,label)!=null:hasLabel(tree,label))return n;if(n==12)throw new AssertionError("Semantic scroll could not reach "+label+": "+tree);performAction("自定义设置",action);}
  throw new AssertionError("Unreachable scroll loop");
 }
 int scrollCustomizationTop()throws Exception {
  JSONArray previous=stableCustomizationGeometry();
  for(int n=1;n<=12;n++){performAction("自定义设置",4);JSONArray current=stableCustomizationGeometry();if(previous.toString().equals(current.toString()))return n;previous=current;}
  throw new AssertionError("Customization did not settle at its top");
 }
 static JSONArray customizationGeometry(JSONObject tree)throws Exception {
  JSONArray geometry=new JSONArray();if(tree==null)return geometry;JSONArray nodes=tree.getJSONArray("nodes");
  for(int n=0;n<nodes.length();n++){JSONObject node=nodes.getJSONObject(n);String label=node.optString("label");if(!label.isEmpty())geometry.put(new JSONObject().put("label",label).put("role",node.optString("role")).put("bounds",node.getJSONObject("bounds")).put("state",node.optInt("state")).put("actions",node.optInt("actions")));}
  return(JSONArray)canonical(geometry);
 }
 JSONArray stableCustomizationGeometry()throws Exception {
  long end=SystemClock.uptimeMillis()+10000;JSONArray previous=customizationGeometry(snapshot());
  while(SystemClock.uptimeMillis()<end){SystemClock.sleep(150);JSONArray current=customizationGeometry(snapshot());if(current.length()>0&&previous.toString().equals(current.toString()))return current;previous=current;}
  throw new AssertionError("Customization viewport did not settle: "+previous);
 }
 JSONArray awaitCustomizationGeometry(JSONArray expected)throws Exception {
  long end=SystemClock.uptimeMillis()+10000;JSONArray actual=null;
  while(SystemClock.uptimeMillis()<end){actual=customizationGeometry(snapshot());if(sameCustomizationGeometry(expected,actual,1))return actual;SystemClock.sleep(100);}
  throw new AssertionError("Customization viewport changed. Expected "+expected+" actual "+actual);
 }
 static boolean sameCustomizationGeometry(JSONArray expected,JSONArray actual,int tolerance)throws Exception {
  if(expected.length()!=actual.length())return false;
  for(int n=0;n<expected.length();n++){
   JSONObject before=expected.getJSONObject(n),after=actual.getJSONObject(n);
   for(String key:new String[]{"label","role","state","actions"})if(!before.get(key).equals(after.get(key)))return false;
   JSONObject beforeBounds=before.getJSONObject("bounds"),afterBounds=after.getJSONObject("bounds");
   for(String side:new String[]{"left","top","right","bottom"})if(Math.abs(beforeBounds.getInt(side)-afterBounds.getInt(side))>tolerance)return false;
  }
  return true;
 }
 boolean checkboxChecked()throws Exception {JSONArray nodes=awaitLabel("同意用户协议与隐私政策").getJSONArray("nodes");for(int n=0;n<nodes.length();n++){JSONObject node=nodes.getJSONObject(n);if("同意用户协议与隐私政策".equals(node.optString("label")))return(node.optInt("state")&4)!=0;}throw new AssertionError("Checkbox missing");}
 /** Inject only into the next new host after MainActivity restored its actual
  * Bundle/retained inputs, but before TextureView can create the guest. */
 JSONObject recreateWithSavedOnlyInjection(String baseUrl)throws Exception {
  final String expectedUrl=privacyDocumentUrl(baseUrl);
  assertTrue("Pre-guest saved-only injection requires API 29+",android.os.Build.VERSION.SDK_INT>=29);
  final Activity previous=activity;final PodRuntimeView previousView=view;final Application app=previous.getApplication();
  final File proofFile=new File(context.getFilesDir(),"onboarding-legal-saved-only-injection-proof.json");
  final JSONObject[] evidence={new JSONObject().put("schemaVersion",1).put("state","armed").put("startedAtEpochMs",System.currentTimeMillis())
   .put("mechanism","new-host pre-guest saved-only injection").put("callback","Application.ActivityLifecycleCallbacks.onActivityPostCreated")
   .put("simulated",true).put("actualProcessDeath",false).put("actualBundleModified",false).put("usesActualActivityRecreate",true)};
  final Throwable[] failure={null};final boolean[] armed={true};final Activity[] injected={null};
  Files.write(proofFile.toPath(),evidence[0].toString().getBytes(StandardCharsets.UTF_8));
  Application.ActivityLifecycleCallbacks callbacks=new Application.ActivityLifecycleCallbacks(){
   @Override public void onActivityPostCreated(Activity created,Bundle actualBundle){
    if(!armed[0]||created==previous||!"dev.podjs.androidwatch.MainActivity".equals(created.getClass().getName()))return;
    armed[0]=false;injected[0]=created;JSONObject proof=evidence[0];
    try{
     proof.put("activityIdentity",Integer.toHexString(System.identityHashCode(created)));
     PodRuntimeView fresh=find(created.getWindow().getDecorView());assertNotNull("New PodRuntimeView missing in post-create callback",fresh);assertNotSame(previousView,fresh);
     Field hostField=PodRuntimeView.class.getDeclaredField("host");hostField.setAccessible(true);
     long beforeHost=hostField.getLong(fresh);proof.put("hostBefore",beforeHost);assertEquals("Guest must not have booted before saved-only injection",0L,beforeHost);
     String savedBefore=fresh.savedActivityState(),retainedBefore=fresh.retainedActivityState();
     assertNotNull("Actual recreation Bundle missing",actualBundle);String bundleSaved=actualBundle.getString("dev.podjs.activity-state");assertNotNull("Actual Bundle saved channel missing",bundleSaved);
     proof.put("savedJson",savedBefore).put("bundleSavedJson",bundleSaved).put("bundleSavedSha256",sha256Text(bundleSaved))
      .put("before",new JSONObject().put("savedSha256",sha256Text(savedBefore)).put("retainedSha256",sha256Text(retainedBefore)).put("retained",new JSONObject(retainedBefore)));
     assertEquals("New host saved channel must be the actual Bundle value",bundleSaved,savedBefore);
     JSONObject retainedStack=new JSONObject(retainedBefore).getJSONObject("watchrss.startup-legal-stack"),savedStack=new JSONObject(savedBefore).getJSONObject("watchrss.startup-legal-stack");
     JSONObject retainedEntry=completedPrivacySnapshot(retainedStack,expectedUrl,false),savedEntry=completedPrivacySnapshot(savedStack,expectedUrl,true);
     assertNotNull("Incoming retained must contain the completed lower privacy snapshot",retainedEntry);assertNotNull("Actual saved Bundle must contain the completed lower privacy snapshot",savedEntry);
     assertEquals("Saved and retained task owners must agree",legalString(savedStack,"owner"),legalString(retainedStack,"owner"));
     // Android can sample saved and retained at different lifecycle callbacks;
     // validate both bodies without adding an unrelated anchor-equality claim.
     String retainedBody=readLegalRecoveryBody(retainedEntry,legalString(retainedStack,"owner"),expectedUrl),savedBody=readLegalRecoveryBody(savedEntry,legalString(savedStack,"owner"),expectedUrl);
     assertPrivacyRecoveryBody(retainedBody);assertEquals("Saved and retained must reference the same verified body",savedBody,retainedBody);
     proof.put("legalSnapshotSchemaVersion",2).put("savedBodyReference",savedEntry.getJSONObject("bodyReference")).put("retainedBodyReference",retainedEntry.getJSONObject("bodyReference"))
      .put("savedAndRetainedBodyReferencesVerified",true);
     fresh.restoreActivityState(savedBefore,null);
     String savedAfter=fresh.savedActivityState(),retainedAfter=fresh.retainedActivityState();long afterHost=hostField.getLong(fresh);
     proof.put("hostAfter",afterHost).put("after",new JSONObject().put("savedJson",savedAfter).put("savedSha256",sha256Text(savedAfter)).put("retainedSha256",sha256Text(retainedAfter)).put("retained",new JSONObject(retainedAfter)));
     assertEquals("Saved bytes must remain unchanged during the injection",savedBefore,savedAfter);assertEquals("Retained must be empty before the new guest reads it","{}",retainedAfter);
     assertEquals("State readback must not boot the guest",0L,afterHost);assertEquals("The actual Bundle must remain untouched",bundleSaved,actualBundle.getString("dev.podjs.activity-state"));
     proof.put("state","passed").put("savedUnchanged",true).put("retainedClearedBeforeGuest",true).put("completedAtEpochMs",System.currentTimeMillis());
    }catch(Exception|AssertionError error){failure[0]=error;try{proof.put("state","failed").put("error",error.toString());}catch(Exception ignored){} }
    finally{try{Files.write(proofFile.toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));}catch(Exception error){if(failure[0]==null)failure[0]=error;else failure[0].addSuppressed(error);}}
   }
   @Override public void onActivityCreated(Activity value,Bundle state){}
   @Override public void onActivityStarted(Activity value){}
   @Override public void onActivityResumed(Activity value){}
   @Override public void onActivityPaused(Activity value){}
   @Override public void onActivityStopped(Activity value){}
   @Override public void onActivitySaveInstanceState(Activity value,Bundle state){}
   @Override public void onActivityDestroyed(Activity value){}
  };
  instrumentation.runOnMainSync(()->app.registerActivityLifecycleCallbacks(callbacks));
  try{
   recreateActivity();
   if(failure[0]!=null)throw new AssertionError("Pre-guest saved-only injection failed: "+evidence[0],failure[0]);
   assertFalse("Armed post-create injection did not run",armed[0]);assertSame("Injection must target the recreated Activity",activity,injected[0]);assertEquals("passed",evidence[0].getString("state"));
   return evidence[0];
  }finally{instrumentation.runOnMainSync(()->app.unregisterActivityLifecycleCallbacks(callbacks));}
 }
 static String sha256Text(String value)throws Exception {
  return sha256Bytes(value.getBytes(StandardCharsets.UTF_8));
 }
 static String sha256Bytes(byte[] value)throws Exception {
  byte[] digest=java.security.MessageDigest.getInstance("SHA-256").digest(value);StringBuilder hex=new StringBuilder(64);
  for(byte part:digest){int n=part&255;hex.append(Character.forDigit(n>>>4,16)).append(Character.forDigit(n&15,16));}return hex.toString();
 }
 void recreateActivity(){
  Instrumentation.ActivityMonitor monitor=instrumentation.addMonitor("dev.podjs.androidwatch.MainActivity",null,false);Activity previous=activity;
  try{instrumentation.runOnMainSync(previous::recreate);activity=instrumentation.waitForMonitorWithTimeout(monitor,15000);assertNotNull(activity);assertNotSame(previous,activity);}finally{instrumentation.removeMonitor(monitor);}
  long end=SystemClock.uptimeMillis()+15000;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);
 }
 static byte[] readBytes(java.io.InputStream in)throws Exception {java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[4096];int count;while((count=in.read(buffer))!=-1)out.write(buffer,0,count);return out.toByteArray();}
 static boolean hasLabel(JSONObject tree,String label)throws Exception {if(tree==null)return false;JSONArray nodes=tree.getJSONArray("nodes");for(int n=0;n<nodes.length();n++)if(label.equals(nodes.getJSONObject(n).optString("label")))return true;return false;}
 static void assertJson(JSONObject expected,JSONObject actual)throws Exception {assertEquals(canonical(expected).toString(),canonical(actual).toString());}
 static Object canonical(Object value)throws Exception {if(value instanceof JSONObject){JSONObject source=(JSONObject)value,result=new JSONObject();java.util.TreeSet<String> keys=new java.util.TreeSet<>();java.util.Iterator<String> iterator=source.keys();while(iterator.hasNext())keys.add(iterator.next());for(String key:keys)result.put(key,canonical(source.get(key)));return result;}if(value instanceof JSONArray){JSONArray source=(JSONArray)value,result=new JSONArray();for(int n=0;n<source.length();n++)result.put(canonical(source.get(n)));return result;}return value;}
 File kv(){return new File(context.getFilesDir(),"podjs/podjs-kv.json");}
 void capture(String stage)throws Exception {SystemClock.sleep(500);Bitmap[] bitmap={null};instrumentation.runOnMainSync(()->bitmap[0]=view.getBitmap());assertNotNull(bitmap[0]);try(FileOutputStream out=new FileOutputStream(new File(context.getFilesDir(),"startup-"+stage+".png"))){assertEquals(466,bitmap[0].getWidth());assertEquals(466,bitmap[0].getHeight());assertTrue(bitmap[0].compress(Bitmap.CompressFormat.PNG,100,out));}finally{bitmap[0].recycle();}}
 void write(JSONObject value)throws Exception {File file=kv();file.getParentFile().mkdirs();Files.write(file.toPath(),value.toString().getBytes(StandardCharsets.UTF_8));}
 JSONObject read()throws Exception {return new JSONObject(new String(Files.readAllBytes(kv().toPath()),StandardCharsets.UTF_8));}
 void launch(){activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));long end=SystemClock.uptimeMillis()+15000;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);}
 void finish(){
  if(activity==null)return;
  Activity previous=activity;PodRuntimeView previousView=view;
  instrumentation.runOnMainSync(()->{if(!previous.isDestroyed())previous.finish();});
  // A queued finish plus an idle main thread does not imply destruction:
  // launching the next Activity can overlap two 250MB runtime font packs.
  // Fresh-launch cases must also wait for the old native host to be released.
  long end=SystemClock.uptimeMillis()+15000;boolean[] released={false};
  while(SystemClock.uptimeMillis()<end){
   instrumentation.runOnMainSync(()->{try{
    Field hostField=PodRuntimeView.class.getDeclaredField("host");hostField.setAccessible(true);
    released[0]=previous.isDestroyed()&&(previousView==null||hostField.getLong(previousView)==0);
   }catch(Exception error){throw new AssertionError(error);}});
   if(released[0]){activity=null;view=null;return;}
   SystemClock.sleep(50);
  }
  fail("Finished Activity or its native runtime was not released before the next launch");
 }
 void awaitDestroyed(){long end=SystemClock.uptimeMillis()+10000;boolean[] done={false};while(SystemClock.uptimeMillis()<end){instrumentation.runOnMainSync(()->done[0]=activity.isDestroyed());if(done[0])return;SystemClock.sleep(100);}fail("Gate did not finish Activity");}
 void awaitNavigation(boolean back,boolean swipe){long end=SystemClock.uptimeMillis()+10000;boolean[] actual=new boolean[4];while(SystemClock.uptimeMillis()<end){instrumentation.runOnMainSync(()->{actual[0]=view.canNavigateBack();actual[1]=view.canSwipeDismiss();actual[2]=view.canScrollHorizontally(-1);actual[3]=view.canScrollHorizontally(1);});if(actual[0]==back&&actual[1]==swipe&&actual[2]==!swipe&&actual[3]==!swipe)return;SystemClock.sleep(100);}fail("Navigation policy expected back="+back+" swipe="+swipe+" actual="+java.util.Arrays.toString(actual));}
 JSONObject platformSwipeProbe(boolean blocked)throws Exception {
  JSONObject[] result={null};instrumentation.runOnMainSync(()->{try{
   Field requested=activity.getClass().getDeclaredField("platformSwipeDismiss");requested.setAccessible(true);boolean enabled=requested.getBoolean(activity);
   result[0]=new JSONObject().put("platformRequested",enabled);
   if(!enabled)return;
   View layout=view;while(layout!=null&&!layout.getClass().getName().contains("SwipeDismissLayout"))layout=layout.getParent() instanceof View?(View)layout.getParent():null;
   assertNotNull("Requested platform swipe container missing",layout);
   Method canScroll=null;for(Class<?> owner=layout.getClass();owner!=null&&canScroll==null;owner=owner.getSuperclass())try{canScroll=owner.getDeclaredMethod("canScroll",View.class,boolean.class,float.class,float.class,float.class);}catch(NoSuchMethodException ignored){}
   result[0].put("layoutClass",layout.getClass().getName()).put("childScrollMethodAccessible",canScroll!=null);
   // Android hidden-API filtering may hide this method. Keep that limit in the
   // receipt; do not alter the device policy to make a reflective probe pass.
   if(canScroll==null)return;
   canScroll.setAccessible(true);
   boolean childOwns=(Boolean)canScroll.invoke(layout,layout,false,20f,layout.getWidth()/2f,layout.getHeight()/2f);
   assertEquals("Platform must honor the live child swipe policy",blocked,childOwns);
   result[0].put("layoutClass",layout.getClass().getName()).put("childOwnsHorizontalMovement",childOwns);
  }catch(Exception error){throw new AssertionError(error);}});return result[0];
 }
 // Caller must already own the main-thread turn. Keeping snapshot and action
 // in that same turn prevents a frame from replacing the committed tree hash.
 JSONObject snapshotOnMain()throws Exception {
  Field hostField=PodRuntimeView.class.getDeclaredField("host");hostField.setAccessible(true);long host=hostField.getLong(view);assertTrue(host!=0);
  Method enabled=method("nativeAccessibilityEnabled",long.class,boolean.class),frame=method("nativeFrame",long.class),snapshot=method("nativeAccessibilitySnapshot",long.class,long[].class);
  enabled.invoke(null,host,true);frame.invoke(null,host);long[] metadata=new long[3];byte[] bytes=(byte[])snapshot.invoke(null,host,metadata);
  return bytes==null?null:new JSONObject(new String(bytes,StandardCharsets.UTF_8)).put("testHash",metadata[0]).put("testHost",host);
 }
 JSONObject snapshot()throws Exception {
  JSONObject[] result={null};instrumentation.runOnMainSync(()->{try{result[0]=snapshotOnMain();}catch(Exception error){throw new AssertionError(error);}});return result[0];
 }
 static Method method(String name,Class<?>...args)throws Exception {Method method=PodRuntimeView.class.getDeclaredMethod(name,args);method.setAccessible(true);return method;}
 JSONObject awaitLabel(String label)throws Exception {long end=SystemClock.uptimeMillis()+20000;JSONObject tree=null;while(SystemClock.uptimeMillis()<end){tree=snapshot();if(tree!=null){JSONArray nodes=tree.getJSONArray("nodes");for(int n=0;n<nodes.length();n++)if(label.equals(nodes.getJSONObject(n).optString("label")))return tree;}SystemClock.sleep(100);}throw new AssertionError("Missing label "+label+": "+tree);}
 void activate(String label)throws Exception {performAction(label,1);}
 void performAction(String label,int action)throws Exception {
  // This wait is only readiness polling. Its node IDs and hash are never reused.
  try{awaitLabel(label);}catch(Exception|AssertionError error){
   throw new AssertionError("Semantic action readiness failed: label="+label+" action="+action+" id=unresolved hash=unavailable accepted=false freshNodes=unavailable",error);
  }
  instrumentation.runOnMainSync(()->{
   JSONObject tree=null,target=null;int id=0;long host=0,hash=0;boolean accepted=false;
   try{
    tree=snapshotOnMain();assertNotNull("Fresh semantic snapshot missing for "+label,tree);
    host=tree.getLong("testHost");hash=tree.getLong("testHash");JSONArray nodes=tree.getJSONArray("nodes");
    for(int n=0;n<nodes.length();n++){JSONObject node=nodes.getJSONObject(n);if(label.equals(node.optString("label"))){target=node;if((node.optInt("actions")&action)!=0)break;}}
    while(target!=null&&(target.optInt("actions")&action)==0){int parent=target.optInt("parentId");target=null;for(int n=0;n<nodes.length();n++)if(nodes.getJSONObject(n).getInt("id")==parent){target=nodes.getJSONObject(n);break;}}
    assertNotNull("No activation callback for "+label,target);id=target.getInt("id");
    accepted=(Boolean)method("nativeAccessibilityAction",long.class,int.class,long.class,int.class).invoke(null,host,id,hash,action);
    assertEquals(true,accepted);
    // Accepted means queued for delivery. Never replay it, even if the frame fails.
    method("nativeFrame",long.class).invoke(null,host);
   }catch(Exception|AssertionError error){
    throw new AssertionError("Semantic action failed: label="+label+" action="+action+" id="+id+" hash="+hash+" host="+host+" accepted="+accepted+" target="+target+" freshNodes="+(tree==null?"unavailable":tree.optJSONArray("nodes")),error);
   }
  });SystemClock.sleep(300);
 }
 static PodRuntimeView find(View view){if(view instanceof PodRuntimeView)return(PodRuntimeView)view;if(view instanceof ViewGroup)for(int n=0;n<((ViewGroup)view).getChildCount();n++){PodRuntimeView child=find(((ViewGroup)view).getChildAt(n));if(child!=null)return child;}return null;}
}
