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
/** Actual production ReaderBody and ReaderPreviewScreen, without synthesized input. */
public final class ReaderParagraphUiTest {
 @Test public void paragraphUiMatchesNative()throws Exception {
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();assertEquals("dev.podjs.tests.readerparagraphs",ctx.getPackageName());
  LocaleList previous=LocaleList.getDefault();LocaleList.setDefault(new LocaleList(java.util.Locale.US));
  String apk=InstrumentationRegistry.getArguments().getString("nativeReferenceApk");ReaderParagraphReference reference=new ReaderParagraphReference(apk);
  Activity activity=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try{PodRuntimeView view=null;long end=SystemClock.uptimeMillis()+30000;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);JSONObject proof=new JSONObject();
   for(String mode:new String[]{"preview","body"})for(String name:new String[]{"start","center","justify","hyphen","both","animated"}){
    String stage=mode+"-"+name;awaitStage(ctx,stage,45000);SystemClock.sleep(1500);JSONObject state=result(ctx);Bitmap frame=bitmap(i,view);assertNotNull(frame);float scale=(float)(frame.getWidth()/state.getDouble("logicalWidth"));JSONObject preset=state.getJSONObject("nativePreset"),style=preset.getJSONObject("body");Bitmap nativeFrame;
    if(mode.equals("preview"))nativeFrame=ReaderNativePreviewReference.render(ctx,apk,preset,frame.getWidth(),frame.getHeight(),scale);
    else{nativeFrame=Bitmap.createBitmap(frame.getWidth(),frame.getHeight(),Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(nativeFrame);canvas.drawColor(Color.BLACK);canvas.translate(14*scale,0);
     JSONObject args=new JSONObject().put("text",state.getString("text")).put("fontSizePx",style.getDouble("fontSizeSp")*scale).put("widthPx",Math.round(frame.getWidth()-28*scale)).put("lineHeightPx",style.getDouble("fontSizeSp")*style.getDouble("lineHeightEm")*scale).put("lineHeightMode","span").put("lineBreak","highQuality").put("align",style.getString("alignment").equals("CENTER")?"center":"left").put("justify",style.getString("alignment").equals("JUSTIFY")).put("hyphenation",style.getString("hyphenation").equals("AUTO")?"full":"none").put("textMotion",style.getString("renderMode").equals("LINEAR_SMOOTH")?"animated":"static").put("colorArgb",style.getLong("colorArgb"));
     reference.draw(reference.paragraph(ctx,args,false),canvas,(int)style.getLong("colorArgb"));
    }
    for(String kind:new String[]{"actual","native"})try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"paragraph-"+stage+"-"+kind+".png"))){assertTrue((kind.equals("actual")?frame:nativeFrame).compress(Bitmap.CompressFormat.PNG,100,out));}
    int changed=0;for(int y=mode.equals("preview")?80:0;y<frame.getHeight();y++)for(int x=0;x<frame.getWidth();x++)if(frame.getPixel(x,y)!=nativeFrame.getPixel(x,y))changed++;
    proof.put(stage,new JSONObject().put("changedPixels",changed).put("state",state));
    try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"paragraph-ui-proof.json"))){out.write(proof.toString().getBytes(StandardCharsets.UTF_8));}
    assertEquals(stage+" native paragraph pixels",0,changed);frame.recycle();nativeFrame.recycle();new File(ctx.getFilesDir(),"podjs/files/paragraph-advance-"+stage).createNewFile();
   }
   awaitStage(ctx,"done",15000);proof.put("result",result(ctx)).put("noSyntheticInput",true).put("passed",true);assertEquals("passed",result(ctx).getString("state"));try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"paragraph-ui-proof.json"))){out.write(proof.toString().getBytes(StandardCharsets.UTF_8));}
  }finally{i.runOnMainSync(activity::finish);LocaleList.setDefault(previous);}
 }
 private static JSONObject result(Context ctx)throws Exception{File file=new File(ctx.getFilesDir(),"podjs/podjs-kv.json");if(!file.isFile())return new JSONObject();return new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)).optJSONObject("reader-paragraph-result");}
 private static void awaitStage(Context ctx,String stage,long timeout)throws Exception{long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject r=result(ctx);if(r!=null){assertNotEquals(r.toString(),"failed",r.optString("state"));if(stage.equals(r.optString("stage")))return;}SystemClock.sleep(100);}throw new AssertionError("No stage "+stage+": "+result(ctx));}
 private static PodRuntimeView find(View view){if(view instanceof PodRuntimeView)return (PodRuntimeView)view;if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int j=0;j<group.getChildCount();j++){PodRuntimeView found=find(group.getChildAt(j));if(found!=null)return found;}}return null;}
 private static Bitmap bitmap(Instrumentation i,TextureView view){Bitmap[] value=new Bitmap[1];i.runOnMainSync(()->value[0]=view.getBitmap());return value[0];}
 private static boolean awake(Instrumentation i,Activity a){boolean[] value=new boolean[1];i.runOnMainSync(()->value[0]=(a.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)!=0);return value[0];}
 private static String semantics(Instrumentation i,PodRuntimeView view)throws Exception{String[] result=new String[1];i.runOnMainSync(()->{try{Field h=PodRuntimeView.class.getDeclaredField("host");h.setAccessible(true);long host=h.getLong(view);assertTrue(host!=0);Method enabled=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilityEnabled",long.class,boolean.class),frame=PodRuntimeView.class.getDeclaredMethod("nativeFrame",long.class),snapshot=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilitySnapshot",long.class,long[].class);enabled.setAccessible(true);frame.setAccessible(true);snapshot.setAccessible(true);Field flag=PodRuntimeView.class.getDeclaredField("accessibilityEnabled");flag.setAccessible(true);boolean original=flag.getBoolean(view);try{enabled.invoke(null,host,false);enabled.invoke(null,host,true);frame.invoke(null,host);byte[] bytes=(byte[])snapshot.invoke(null,host,new long[3]);assertNotNull(bytes);result[0]=new String(bytes,StandardCharsets.UTF_8);}finally{enabled.invoke(null,host,original);}}catch(Exception e){throw new AssertionError(e);}});return result[0];}
}
