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
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
/** Production volume rows in an isolated package; captures are not a native pixel oracle. */
public final class RemoteInputHttpTest {
 @Test public void productionScreenReceivesHttpAndClosesListener()throws Exception {
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();assertEquals("dev.podjs.tests.remoteinput",ctx.getPackageName());
  Activity activity=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try{PodRuntimeView view=null;long end=SystemClock.uptimeMillis()+30000;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);
   awaitStage(ctx,"ready",30000);JSONObject state=result(ctx);int port=state.getInt("port");Bitmap frame=bitmap(i,view);
   try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"remote-input-ready.png"))){assertTrue(frame.compress(Bitmap.CompressFormat.PNG,100,out));}frame.recycle();
   JSONObject proof=new JSONObject();NativeRemoteInputOracle oracle=new NativeRemoteInputOracle(InstrumentationRegistry.getArguments().getString("nativeReferenceApk"));JSONObject kv=new JSONObject(new String(java.nio.file.Files.readAllBytes(new File(ctx.getFilesDir(),"podjs/podjs-kv.json").toPath()),StandardCharsets.UTF_8));JSONArray cases=kv.getJSONArray("remote-input-native-cases");
   for(int c=0;c<cases.length();c++){JSONObject item=cases.getJSONObject(c),expected=oracle.route(item.getJSONObject("request")),actual=item.getJSONObject("response");android.util.Log.i("RemoteInputOracle", "case="+c+" nativeType="+expected.getString("type")+" podType="+actual.getString("type"));if(expected.getString("type").startsWith("application/json")){NativeRemoteInputOracle.same(new JSONObject(expected.getString("body")),new JSONObject(actual.getString("body")));expected.remove("body");actual.remove("body");}NativeRemoteInputOracle.same(expected,actual);}proof.put("nativeHandlerCases",cases.length());proof.put("health",request(port,"GET","/health",null,200));proof.put("ability",request(port,"GET","/getCurrentActivationAbility",null,200));proof.put("abilities",request(port,"GET","/getAbilities",null,200));
   assertEquals("ok",proof.getJSONObject("health").getString("status"));assertEquals("dc40517c-a09c-419c-8c4d-d3883258992e",proof.getJSONObject("ability").getString("code"));assertEquals(1,proof.getJSONObject("abilities").getJSONArray("abilities").length());
   try(java.net.Socket partial=new java.net.Socket("127.0.0.1",port)){partial.setSoTimeout(3000);partial.getOutputStream().write("POST /remoteEnterRSSURL HTTP/1.1\r\nContent-Length: 100\r\n\r\nx".getBytes(StandardCharsets.UTF_8));partial.getOutputStream().flush();awaitPendingRead(view);new File(ctx.getFilesDir(),"podjs/files/remote-input-reopen").createNewFile();awaitStage(ctx,"closed",10000);assertEquals(-1,partial.getInputStream().read());}
   try(java.net.Socket socket=new java.net.Socket()){socket.connect(new java.net.InetSocketAddress("127.0.0.1",port),500);fail("Cancelled page listener leaked");}catch(java.io.IOException expected){}
   proof.put("screenExitReleasedListener",true).put("pendingReadCancelled",true);new File(ctx.getFilesDir(),"podjs/files/remote-input-open").createNewFile();awaitStage(ctx,"reopened",10000);port=result(ctx).getInt("port");
   JSONObject missing=request(port,"POST","/remoteEnterRSSURL","{}",400);assertFalse(missing.getBoolean("success"));
   String url="https://example.invalid/中文.xml?one=1&two=2";assertTrue(request(port,"POST","/remoteEnterRSSURL",new JSONObject().put("url",url).toString(),200).getBoolean("success"));
   awaitStage(ctx,"qr",15000);SystemClock.sleep(300);Bitmap qr=bitmap(i,view);try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"remote-input-qr.png"))){assertTrue(qr.compress(Bitmap.CompressFormat.PNG,100,out));}
   String decoded=decodeQr(oracle.loader,qr);assertEquals(result(ctx).getString("qrValue"),decoded);proof.put("qrDecoded",decoded);qr.recycle();new File(ctx.getFilesDir(),"podjs/files/qr-advance").createNewFile();
   awaitStage(ctx,"done",15000);assertEquals(url,result(ctx).getString("received"));assertEquals("passed",result(ctx).getString("state"));
   try(java.net.Socket socket=new java.net.Socket()){socket.connect(new java.net.InetSocketAddress("127.0.0.1",port),500);fail("HTTP listener leaked");}catch(java.io.IOException expected){}
   proof.put("result",result(ctx)).put("portClosed",true).put("transport","device-loopback").put("wifiLanVerified",false).put("passed",true);
   try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"remote-input-http-proof.json"))){out.write(proof.toString().getBytes(StandardCharsets.UTF_8));}
  }finally{i.runOnMainSync(activity::finish);}
 }
 private static void awaitPendingRead(PodRuntimeView view)throws Exception{
  Field services=PodRuntimeView.class.getDeclaredField("services");services.setAccessible(true);Object host=services.get(view);Field requests=PodServices.class.getDeclaredField("requests");requests.setAccessible(true);long end=SystemClock.uptimeMillis()+3000;
  while(SystemClock.uptimeMillis()<end){for(Object request:((java.util.Map<?,?>)requests.get(host)).values()){Field method=request.getClass().getDeclaredField("method");method.setAccessible(true);if("stream.read".equals(method.get(request)))return;}SystemClock.sleep(10);}throw new AssertionError("No pending HTTP read");
 }
 private static String decodeQr(ClassLoader loader,Bitmap bitmap)throws Exception{
  int[] pixels=new int[bitmap.getWidth()*bitmap.getHeight()];bitmap.getPixels(pixels,0,bitmap.getWidth(),0,0,bitmap.getWidth(),bitmap.getHeight());for(int n=0;n<pixels.length;n++)pixels[n]=0xff000000|(~pixels[n]&0xffffff);
  Class<?> luminance=loader.loadClass("com.google.zxing.LuminanceSource"),binarizer=loader.loadClass("com.google.zxing.Binarizer"),binary=loader.loadClass("com.google.zxing.BinaryBitmap");Object source=loader.loadClass("com.google.zxing.RGBLuminanceSource").getConstructor(int.class,int.class,int[].class).newInstance(bitmap.getWidth(),bitmap.getHeight(),pixels);Object bin=loader.loadClass("com.google.zxing.common.HybridBinarizer").getConstructor(luminance).newInstance(source);Object frame=binary.getConstructor(binarizer).newInstance(bin);Class<?> hints=loader.loadClass("com.google.zxing.DecodeHintType");java.util.Map<Object,Object> map=new java.util.HashMap<>();map.put(hints.getField("TRY_HARDER").get(null),true);map.put(hints.getField("CHARACTER_SET").get(null),"UTF-8");Class<?> reader=loader.loadClass("com.google.zxing.qrcode.QRCodeReader");Object decoded=reader.getMethod("decode",binary,java.util.Map.class).invoke(reader.getConstructor().newInstance(),frame,map);return (String)decoded.getClass().getMethod("getText").invoke(decoded);
 }
 private static JSONObject request(int port,String method,String path,String body,int status)throws Exception{
  java.net.HttpURLConnection connection=(java.net.HttpURLConnection)new java.net.URL("http://127.0.0.1:"+port+path).openConnection();connection.setRequestMethod(method);connection.setConnectTimeout(3000);connection.setReadTimeout(10000);connection.setRequestProperty("Content-Type","application/json");try{
   if(body!=null){byte[] bytes=body.getBytes(StandardCharsets.UTF_8);connection.setDoOutput(true);connection.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=connection.getOutputStream()){out.write(bytes);}}
   assertEquals(status,connection.getResponseCode());try(InputStream in=status>=400?connection.getErrorStream():connection.getInputStream()){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[1024];int n;while((n=in.read(buffer))!=-1)out.write(buffer,0,n);return new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));}
  }finally{connection.disconnect();}
 }
 private static JSONObject result(Context ctx)throws Exception{File file=new File(ctx.getFilesDir(),"podjs/podjs-kv.json");if(!file.isFile())return new JSONObject();return new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)).optJSONObject("remote-input-result");}
 private static void awaitStage(Context ctx,String stage,long timeout)throws Exception{long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject r=result(ctx);if(r!=null){assertNotEquals(r.toString(),"failed",r.optString("state"));if(stage.equals(r.optString("stage")))return;}SystemClock.sleep(100);}throw new AssertionError("No stage "+stage+": "+result(ctx));}
 private static PodRuntimeView find(View view){if(view instanceof PodRuntimeView)return (PodRuntimeView)view;if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int j=0;j<group.getChildCount();j++){PodRuntimeView found=find(group.getChildAt(j));if(found!=null)return found;}}return null;}
 private static Bitmap bitmap(Instrumentation i,TextureView view){Bitmap[] value=new Bitmap[1];i.runOnMainSync(()->value[0]=view.getBitmap());return value[0];}
 private static boolean awake(Instrumentation i,Activity a){boolean[] value=new boolean[1];i.runOnMainSync(()->value[0]=(a.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)!=0);return value[0];}
 private static String semantics(Instrumentation i,PodRuntimeView view)throws Exception{String[] result=new String[1];i.runOnMainSync(()->{try{Field h=PodRuntimeView.class.getDeclaredField("host");h.setAccessible(true);long host=h.getLong(view);assertTrue(host!=0);Method enabled=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilityEnabled",long.class,boolean.class),frame=PodRuntimeView.class.getDeclaredMethod("nativeFrame",long.class),snapshot=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilitySnapshot",long.class,long[].class);enabled.setAccessible(true);frame.setAccessible(true);snapshot.setAccessible(true);Field flag=PodRuntimeView.class.getDeclaredField("accessibilityEnabled");flag.setAccessible(true);boolean original=flag.getBoolean(view);try{enabled.invoke(null,host,false);enabled.invoke(null,host,true);frame.invoke(null,host);byte[] bytes=(byte[])snapshot.invoke(null,host,new long[3]);assertNotNull(bytes);result[0]=new String(bytes,StandardCharsets.UTF_8);}finally{enabled.invoke(null,host,original);}}catch(Exception e){throw new AssertionError(e);}});return result[0];}
}
