package dev.podjs.hotfix;

import android.app.*;
import android.content.*;
import android.os.*;
import android.view.*;
import android.widget.*;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.*;
import java.net.*;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import javax.net.ssl.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Emulator-only: real release UI/OkHttp/encryption/Keystore, local TLS receiver, no production traffic. */
@RunWith(AndroidJUnit4.class)
public class UploadAcceptanceTest {
 static final String HOST="sly-data-plane.watchrss.cn",PKG="com.lightningstudio.watchrss";
 static TrustManager[] localTrust;
 public static final class TrustFactory extends TrustManagerFactorySpi {
  protected void engineInit(KeyStore store){}
  protected void engineInit(ManagerFactoryParameters params){}
  protected TrustManager[] engineGetTrustManagers(){return localTrust;}
 }
 static View find(View view,String label){
  if(view instanceof TextView && ((TextView)view).getText().toString().equals(label))return view;
  if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++){View child=find(((ViewGroup)view).getChildAt(i),label);if(child!=null)return child;}
  return null;
 }
 static String text(View view){String out=view instanceof TextView?((TextView)view).getText().toString()+"\n":"";if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++)out+=text(((ViewGroup)view).getChildAt(i));return out;}
 static CheckBox checkbox(View view){if(view instanceof CheckBox)return (CheckBox)view;if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++){CheckBox child=checkbox(((ViewGroup)view).getChildAt(i));if(child!=null)return child;}return null;}
 @Test public void formalReleaseFailureUploadsAndDeletesUsingRealHttpAndLocalTls()throws Exception {
  Instrumentation ins=InstrumentationRegistry.getInstrumentation();Context target=ins.getTargetContext();
  assertEquals(PKG,target.getPackageName());assertTrue(Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"));
  assertEquals(1278,target.getPackageManager().getPackageInfo(PKG,0).getLongVersionCode());
  assertEquals(0,target.getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE);
  KeyStore store=KeyStore.getInstance(KeyStore.getDefaultType());store.load(null);
  try(InputStream input=ins.getContext().getAssets().open("receiver-ca.pem")){store.setCertificateEntry("local-emulator-only",CertificateFactory.getInstance("X.509").generateCertificate(input));}
  String algorithm=TrustManagerFactory.getDefaultAlgorithm();TrustManagerFactory factory=TrustManagerFactory.getInstance(algorithm);factory.init(store);localTrust=factory.getTrustManagers();
  Provider provider=new Provider("TakeoverLocalTls",1.0,"Emulator instrumentation only"){};
  provider.put("TrustManagerFactory.TakeoverLocal",TrustFactory.class.getName());Security.insertProviderAt(provider,1);Security.setProperty("ssl.TrustManagerFactory.algorithm","TakeoverLocal");
  ProxySelector original=ProxySelector.getDefault();
  ProxySelector.setDefault(new ProxySelector(){public List<Proxy> select(URI uri){if(!HOST.equals(uri.getHost()))throw new SecurityException("external_network_forbidden");return Collections.singletonList(new Proxy(Proxy.Type.HTTP,new InetSocketAddress("10.0.2.2",54446)));}public void connectFailed(URI uri,SocketAddress address,IOException error){}});
  Activity activity=null;
  try {
   activity=ins.startActivitySync(target.getPackageManager().getLaunchIntentForPackage(PKG).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));final Activity owner=activity;
   View root=owner.getWindow().getDecorView();long end=SystemClock.uptimeMillis()+60000;
   while(find(root,"上传日志")==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);
   assertNotNull("actual migration failure offers upload",find(root,"上传日志"));
   ins.runOnMainSync(()->find(root,"上传日志").performClick());end=SystemClock.uptimeMillis()+15000;
   while(!text(root).contains("2.0.1-2 / 1278")&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);
   assertTrue(text(root).contains("2.0.1-2 / 1278"));assertFalse(text(root).contains("PRIVATE_TITLE"));
   View upload=find(root,"上传脱敏诊断");assertNotNull(upload);assertFalse(upload.isEnabled());
   ins.runOnMainSync(()->checkbox(root).setChecked(true));assertTrue(upload.isEnabled());ins.runOnMainSync(upload::performClick);
   end=SystemClock.uptimeMillis()+60000;while(!text(root).contains("日志编号：654321")&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);
   assertTrue("real HTTPS upload returned a receipt: "+text(root),text(root).contains("日志编号：654321"));
   ins.runOnMainSync(()->((ScrollView)findScroll(root)).fullScroll(View.FOCUS_DOWN));
   android.util.Log.i("TakeoverHotfixUploadTest","UPLOAD_PASS code=654321 realHttp=true nativeRelease=true");SystemClock.sleep(8000);
   ins.runOnMainSync(()->find(root,"删除已上传诊断").performClick());end=SystemClock.uptimeMillis()+30000;
   while(!text(root).contains("已删除这份诊断。")&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);
   assertTrue(text(root).contains("已删除这份诊断。"));android.util.Log.i("TakeoverHotfixUploadTest","DELETE_PASS");
  }finally{if(activity!=null){Activity owner=activity;ins.runOnMainSync(owner::finish);}ProxySelector.setDefault(original);Security.setProperty("ssl.TrustManagerFactory.algorithm",algorithm);Security.removeProvider(provider.getName());}
 }
 static View findScroll(View view){if(view instanceof ScrollView)return view;if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++){View child=findScroll(((ViewGroup)view).getChildAt(i));if(child!=null)return child;}return null;}
}
