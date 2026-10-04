package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.app.Instrumentation;import android.os.SystemClock;import android.view.*;import android.graphics.Bitmap;import android.app.Activity;import android.content.*;import android.os.Build;
import androidx.test.platform.app.InstrumentationRegistry;import org.junit.Test;import org.json.*;
import java.io.*;import java.lang.reflect.*;import java.nio.charset.StandardCharsets;import java.nio.file.Files;
public final class SystemShareRuntimeTest {
 public static final class CaptureActivity extends Activity {
  Intent chooser;int count;
  void bind(Context context){attachBaseContext(context);}
  @Override public void startActivity(Intent intent){chooser=intent;count++;}
 }
 @Test public void chooserPayloadMatchesNativeHelpersWithoutSending()throws Exception{
  android.app.Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();Context target=instrumentation.getTargetContext();assertEquals("dev.podjs.tests.systemshare",target.getPackageName());
  ClassLoader loader=new dalvik.system.PathClassLoader(InstrumentationRegistry.getArguments().getString("nativeReferenceApk"),ClassLoader.getSystemClassLoader());
  JSONArray matrix=new JSONArray(new String(read(instrumentation.getContext().getAssets().open("cases.json")),StandardCharsets.UTF_8));
  CaptureActivity[] holder=new CaptureActivity[1];instrumentation.runOnMainSync(()->{holder[0]=new CaptureActivity();holder[0].bind(target);});CaptureActivity activity=holder[0];JSONArray result=new JSONArray();
  for(int index=0;index<matrix.length();index++){
   JSONObject row=matrix.getJSONObject(index);String origin=row.getString("origin"),className=origin.equals("channel")?"com.lightningstudio.watchrss.ChannelDetailActivityKt":origin.equals("bili-detail")?"com.lightningstudio.watchrss.BiliDetailActivityKt":"com.lightningstudio.watchrss.ui.screen.rss.DetailBehaviorSupportKt";
   Method method=loader.loadClass(className).getDeclaredMethod("shareCurrent",Context.class,String.class,String.class);method.setAccessible(true);activity.chooser=null;activity.count=0;
   method.invoke(null,activity,row.getString("title"),row.isNull("link")?null:row.getString("link"));
   if(row.isNull("expected")){assertEquals(0,activity.count);result.put(new JSONObject().put("case",index).put("sent",false));continue;}
   assertEquals(1,activity.count);String expected=row.getString("expected");assertPayload(activity.chooser,expected);
   Intent nativeChooser=activity.chooser;activity.chooser=null;
   new PodSharingServices(activity).text(new JSONObject().put("text",expected).put("chooserTitle","分享"));assertPayload(activity.chooser,expected);
   assertEquals(nativeChooser.getStringExtra(Intent.EXTRA_TITLE),activity.chooser.getStringExtra(Intent.EXTRA_TITLE));result.put(new JSONObject().put("case",index).put("sent",false).put("chooserMatched",true));
  }
  JSONObject environment=new PodSharingServices(activity).environment();boolean nativeSupport=(Boolean)loader.loadClass("com.lightningstudio.watchrss.ui.util.SystemShareCompatKt").getDeclaredMethod("isSystemShareSettingSupported",Context.class).invoke(null,activity);
  assertEquals(Build.VERSION.SDK_INT,environment.getInt("sdkInt"));assertEquals(nativeSupport,environment.getInt("sdkInt")>=31&&!environment.getBoolean("wearOs"));
  for(Object invalid:new Object[]{JSONObject.NULL,17,""}){try{new PodSharingServices(activity).text(new JSONObject().put("text",invalid));fail("Invalid payload accepted");}catch(IllegalArgumentException expected){}}
  try{new PodSharingServices(target).text(new JSONObject().put("text","test"));fail("Non Activity accepted");}catch(IllegalStateException expected){}
  java.util.concurrent.LinkedBlockingQueue<String> replies=new java.util.concurrent.LinkedBlockingQueue<>();
  try(PodServices bridge=new PodServices(activity,replies::add)){
   activity.count=0;
   instrumentation.runOnMainSync(()->{try{bridge.dispatch(command(1,"share.text",new JSONObject().put("text","cancelled")));bridge.dispatch(new JSONObject().put("t","service.cancel").put("id",1));}catch(Exception error){throw new RuntimeException(error);}});
   instrumentation.waitForIdleSync();assertEquals(0,activity.count);replies.clear();
   bridge.dispatch(command(2,"share.text",new JSONObject().put("text","bridge text").put("chooserTitle","分享")));
   String event=replies.poll(5,java.util.concurrent.TimeUnit.SECONDS);assertNotNull(event);JSONObject reply=new JSONObject(event);assertTrue(reply.toString(),reply.getBoolean("ok"));assertEquals(2,reply.getInt("id"));assertEquals(1,activity.count);assertPayload(activity.chooser,"bridge text");
   bridge.dispatch(command(3,"share.environment",new JSONObject()));event=replies.poll(5,java.util.concurrent.TimeUnit.SECONDS);assertNotNull(event);reply=new JSONObject(event);assertTrue(reply.getBoolean("ok"));assertEquals(environment.toString(),reply.getJSONObject("value").toString());
  }
  JSONArray qrCases=new JSONArray(new String(read(instrumentation.getContext().getAssets().open("qr-cases.json")),StandardCharsets.UTF_8));
  for(int n=0;n<qrCases.length();n++){
   JSONObject qrCase=qrCases.getJSONObject(n);int size=qrCase.getInt("size");String link=qrCase.getString("link");
   byte[] rgba=read(instrumentation.getContext().getAssets().open("qr-"+n+".rgba"));assertEquals(size*size*4,rgba.length);int[] pixels=new int[size*size];int white=0,black=0;
   for(int k=0;k<pixels.length;k++){int v=rgba[k*4]&255;assertTrue(v==0||v==255);assertEquals(v,rgba[k*4+1]&255);assertEquals(v,rgba[k*4+2]&255);assertEquals(255,rgba[k*4+3]&255);pixels[k]=0xff000000|(v<<16)|(v<<8)|v;if(v==0)black++;else white++;}
   assertTrue(black>0&&white>0);Bitmap bitmap=Bitmap.createBitmap(size+64,size+64,Bitmap.Config.ARGB_8888);bitmap.eraseColor(0xff000000);bitmap.setPixels(pixels,0,size,32,32,size,size);
   try{assertEquals(link,decodeQr(loader,bitmap));}catch(Exception error){throw new AssertionError("QR case "+n+" size "+size,error);}finally{bitmap.recycle();}
  }
  JSONObject proof=new JSONObject().put("passed",true).put("cases",result).put("environment",environment).put("nativeSupported",nativeSupport).put("bridgeDispatchVerified",true).put("cancelledBeforeLaunchVerified",true).put("recipientSelected",false).put("realChooserUiVerified",false).put("qrDecodedCases",qrCases.length()).put("qrFullNativePixelsEqual",false);
  Files.write(new File(target.getFilesDir(),"system-share-native-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
 }
 private static String decodeQr(ClassLoader loader,Bitmap bitmap)throws Exception{
  int[] pixels=new int[bitmap.getWidth()*bitmap.getHeight()];bitmap.getPixels(pixels,0,bitmap.getWidth(),0,0,bitmap.getWidth(),bitmap.getHeight());for(int n=0;n<pixels.length;n++)pixels[n]=0xff000000|(~pixels[n]&0xffffff);
  Class<?> luminance=loader.loadClass("com.google.zxing.LuminanceSource"),binarizer=loader.loadClass("com.google.zxing.Binarizer"),binary=loader.loadClass("com.google.zxing.BinaryBitmap");Object source=loader.loadClass("com.google.zxing.RGBLuminanceSource").getConstructor(int.class,int.class,int[].class).newInstance(bitmap.getWidth(),bitmap.getHeight(),pixels);Object bin=loader.loadClass("com.google.zxing.common.HybridBinarizer").getConstructor(luminance).newInstance(source);Object frame=binary.getConstructor(binarizer).newInstance(bin);Class<?> hints=loader.loadClass("com.google.zxing.DecodeHintType");java.util.Map<Object,Object> map=new java.util.HashMap<>();map.put(hints.getField("TRY_HARDER").get(null),true);map.put(hints.getField("CHARACTER_SET").get(null),"UTF-8");Class<?> reader=loader.loadClass("com.google.zxing.qrcode.QRCodeReader");Object decoded=reader.getMethod("decode",binary,java.util.Map.class).invoke(reader.getConstructor().newInstance(),frame,map);return (String)decoded.getClass().getMethod("getText").invoke(decoded);
 }
 @Test public void productionQrAndSettingsRenderOnWatch()throws Exception{
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();assertEquals("dev.podjs.tests.systemshare",ctx.getPackageName());
  ClassLoader loader=new dalvik.system.PathClassLoader(InstrumentationRegistry.getArguments().getString("nativeReferenceApk"),ClassLoader.getSystemClassLoader());
  Activity activity=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  JSONArray captured=new JSONArray();
  try{
   PodRuntimeView view=awaitView(activity);
   String[] links={"https://example.com/article/123","https://例子.test/文章?标题=中文&emoji=⌚","https://example.com/"+new String(new char[450]).replace('\0','a')};
   for(String stage:new String[]{"qr-0","qr-1","qr-2","channel","system-off","system-on"}){
    awaitStage(ctx,stage,45000);Bitmap[] holder=new Bitmap[1];i.runOnMainSync(()->holder[0]=view.getBitmap());Bitmap frame=holder[0];assertNotNull(frame);assertEquals(466,frame.getWidth());assertEquals(466,frame.getHeight());
    try{
     if(stage.startsWith("qr-")||stage.equals("channel")){Bitmap region=Bitmap.createBitmap(frame,83,140,300,300);try{assertEquals(stage.equals("channel")?links[1]:links[Integer.parseInt(stage.substring(3))],decodeQr(loader,region));}finally{region.recycle();}}
     try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"share-"+stage+".png"))){assertTrue(frame.compress(Bitmap.CompressFormat.PNG,100,out));}
     captured.put(stage);
    }finally{frame.recycle();}
    File advance=new File(ctx.getFilesDir(),"podjs/files/share-advance-"+stage);advance.getParentFile().mkdirs();assertTrue(advance.createNewFile());
   }
   awaitStage(ctx,"done",15000);JSONObject proof=result(ctx);assertEquals("passed",proof.getString("state"));assertTrue(proof.getBoolean("unsupportedRowHidden"));proof.put("captured",captured).put("qrDecodedFromGpuFrame",true).put("nativeUiPixelEquality",false);
   Files.write(new File(ctx.getFilesDir(),"system-share-ui-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  }finally{i.runOnMainSync(activity::finish);i.waitForIdleSync();}
 }
 static JSONObject result(Context ctx)throws Exception{File f=new File(ctx.getFilesDir(),"podjs/podjs-kv.json");return f.isFile()?new JSONObject(new String(Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8)).optJSONObject("system-share-ui-result"):null;}
 static void awaitStage(Context ctx,String stage,long timeout)throws Exception{long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject r=result(ctx);if(r!=null){assertNotEquals(r.toString(),"failed",r.optString("state"));if(stage.equals(r.optString("stage")))return;}SystemClock.sleep(100);}throw new AssertionError("Missing stage "+stage+": "+result(ctx));}
 static PodRuntimeView awaitView(Activity activity){long end=SystemClock.uptimeMillis()+30000;PodRuntimeView view;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);return view;}
 static PodRuntimeView find(View v){if(v instanceof PodRuntimeView)return(PodRuntimeView)v;if(v instanceof ViewGroup)for(int n=0;n<((ViewGroup)v).getChildCount();n++){PodRuntimeView view=find(((ViewGroup)v).getChildAt(n));if(view!=null)return view;}return null;}
 static JSONObject command(int id,String method,JSONObject args)throws JSONException{return new JSONObject().put("t","service.request").put("version",1).put("id",id).put("method",method).put("args",args);}
 static void assertPayload(Intent chooser,String expected){assertEquals(Intent.ACTION_CHOOSER,chooser.getAction());assertEquals("分享",chooser.getStringExtra(Intent.EXTRA_TITLE));Intent send=chooser.getParcelableExtra(Intent.EXTRA_INTENT);assertNotNull(send);assertEquals(Intent.ACTION_SEND,send.getAction());assertEquals("text/plain",send.getType());assertEquals(expected,send.getStringExtra(Intent.EXTRA_TEXT));assertFalse(send.hasExtra(Intent.EXTRA_SUBJECT));}
 static byte[] read(InputStream in)throws IOException{try(InputStream input=in;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[4096];int n;while((n=input.read(b))!=-1)out.write(b,0,n);return out.toByteArray();}}
}
