package dev.podjs.runtime;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.lang.reflect.Field;
import java.util.Map;

/** Captures the fixture's actual GPU frames without injecting touch/key/crown input. */
public final class OnboardingRuntimeTest {
 @Test public void introStagesRenderOnWatch() throws Exception {
  Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
  Context context=instrumentation.getTargetContext();
  assertEquals("dev.podjs.tests.onboarding",context.getPackageName());
  Activity activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  JSONArray captured=new JSONArray();
  try {
   PodRuntimeView view=awaitView(activity);
   awaitStage(context,"network-observed",15000);
   JSONObject networkProof=result(context),guestSnapshot=networkProof.getJSONObject("snapshot"),nativeSnapshot=snapshot(context);
   for(String key:new String[]{"active","internet","validated","wifi","cellular","bluetooth"})assertEquals(key,nativeSnapshot.getBoolean(key),guestSnapshot.getBoolean(key));
   JSONArray statuses=networkProof.getJSONArray("statuses");assertEquals("checking",statuses.getString(0));
   String expected=!nativeSnapshot.getBoolean("active")||!nativeSnapshot.getBoolean("internet")||!nativeSnapshot.getBoolean("validated")?"unavailable":nativeSnapshot.getBoolean("wifi")||nativeSnapshot.getBoolean("cellular")?"available":nativeSnapshot.getBoolean("bluetooth")?"bluetooth":"unavailable";
   assertEquals(expected,statuses.getString(statuses.length()-1));
   Object networks=field(field(view,"services"),"networks");Object subscription;
   synchronized(networks){Map<?,?> subscriptions=(Map<?,?>)field(networks,"subscriptions");assertEquals(1,subscriptions.size());subscription=subscriptions.values().iterator().next();}
   synchronized(subscription){assertEquals(true,field(subscription,"defaultRegistered"));assertEquals(true,field(subscription,"wifiRegistered"));}
   advance(context,"network-observed");awaitStage(context,"network-released",10000);
   synchronized(networks){assertTrue(((Map<?,?>)field(networks,"subscriptions")).isEmpty());}
   synchronized(subscription){assertEquals(true,field(subscription,"ended"));assertEquals(false,field(subscription,"defaultRegistered"));assertEquals(false,field(subscription,"wifiRegistered"));}
   networkProof.put("nativeSnapshot",nativeSnapshot).put("subscriptionReleased",true).put("physicalNetworkChanged",false);
   advance(context,"network-released");
   for(String stage:new String[]{"welcome","agreement","agreement-error","agreement-checked","customization","network-checking","network-unavailable","offline-warning","network-bluetooth","bluetooth-warning","network-available","privacy"}){
    awaitStage(context,stage,45000);
    Bitmap[] holder=new Bitmap[1];instrumentation.runOnMainSync(()->holder[0]=view.getBitmap());Bitmap frame=holder[0];
    assertNotNull(stage,frame);assertEquals(466,frame.getWidth());assertEquals(466,frame.getHeight());
    try(FileOutputStream out=new FileOutputStream(new File(context.getFilesDir(),"onboarding-"+stage+".png"))){assertTrue(frame.compress(Bitmap.CompressFormat.PNG,100,out));}finally{frame.recycle();}
    captured.put(stage);
    File advance=new File(context.getFilesDir(),"podjs/files/onboarding-advance-"+stage);advance.getParentFile().mkdirs();assertTrue(advance.createNewFile());
   }
   awaitStage(context,"done",15000);JSONObject proof=result(context);assertEquals("passed",proof.getString("state"));assertEquals(1,proof.getInt("completionRequests"));
   proof.put("captured",captured).put("nativePixelEqualityVerified",false).put("actualNetworkMonitorExercised",true).put("network",networkProof);
   advance(context,"done");
   long exitDeadline=SystemClock.uptimeMillis()+10000;
   boolean[] destroyed={false};
   while(SystemClock.uptimeMillis()<exitDeadline){instrumentation.runOnMainSync(()->destroyed[0]=activity.isDestroyed());if(destroyed[0])break;SystemClock.sleep(100);}
   assertTrue("app.finishTask must destroy the actual Activity",destroyed[0]);
   proof.put("publicFinishTaskDestroyedActivity",true);
   Files.write(new File(context.getFilesDir(),"onboarding-ui-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  } finally {instrumentation.runOnMainSync(activity::finish);instrumentation.waitForIdleSync();}
 }
 static void advance(Context context,String stage)throws Exception {File file=new File(context.getFilesDir(),"podjs/files/onboarding-advance-"+stage);file.getParentFile().mkdirs();assertTrue(file.createNewFile());}
 static Object field(Object object,String name)throws Exception {Field field=object.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(object);}
 static JSONObject snapshot(Context context)throws Exception {ConnectivityManager manager=context.getSystemService(ConnectivityManager.class);Network network=manager.getActiveNetwork();NetworkCapabilities caps=network==null?null:manager.getNetworkCapabilities(network);return new JSONObject().put("active",network!=null).put("internet",caps!=null&&caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)).put("validated",caps!=null&&caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)).put("wifi",caps!=null&&caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)).put("cellular",caps!=null&&caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)).put("bluetooth",caps!=null&&caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH));}
 static JSONObject result(Context context)throws Exception {File file=new File(context.getFilesDir(),"podjs/podjs-kv.json");return file.isFile()?new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)).optJSONObject("onboarding-ui-result"):null;}
 static void awaitStage(Context context,String stage,long timeout)throws Exception {long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject result=result(context);if(result!=null){assertNotEquals(result.toString(),"failed",result.optString("state"));if(stage.equals(result.optString("stage")))return;}SystemClock.sleep(100);}throw new AssertionError("Missing stage "+stage+": "+result(context));}
 static PodRuntimeView awaitView(Activity activity){long end=SystemClock.uptimeMillis()+30000;PodRuntimeView view;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);return view;}
 static PodRuntimeView find(View view){if(view instanceof PodRuntimeView)return(PodRuntimeView)view;if(view instanceof ViewGroup)for(int n=0;n<((ViewGroup)view).getChildCount();n++){PodRuntimeView child=find(((ViewGroup)view).getChildAt(n));if(child!=null)return child;}return null;}
}
