package dev.podjs.androidwatch;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.platform.app.InstrumentationRegistry;
import dev.podjs.runtime.PodRuntimeView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Captures the actual imported chapter TextureView without generating user input. */
public final class TxtNovelReaderUiTest {
 @Test public void largeImportedChapterRenders() throws Exception {
  Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
  Context target=instrumentation.getTargetContext();
  assertEquals("dev.podjs.tests.phonetxtnovel",target.getPackageName());
  Intent intent=new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity")
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_REORDER_TO_FRONT|Intent.FLAG_ACTIVITY_SINGLE_TOP);
  Activity activity=instrumentation.startActivitySync(intent);
  try {
   PodRuntimeView view=null;long deadline=SystemClock.uptimeMillis()+30000;
   while(SystemClock.uptimeMillis()<deadline){
    final View root=activity.getWindow().getDecorView();
    view=find(root);
    if(view!=null&&view.isAvailable()&&result(target).optString("renderStage").equals("article-loaded"))break;
    SystemClock.sleep(100);
   }
   assertNotNull("Runtime TextureView missing",view);
   assertTrue("Runtime TextureView unavailable",view.isAvailable());
   assertEquals("passed",result(target).optString("state"));
   final PodRuntimeView texture=view;final Bitmap[] capture=new Bitmap[1];
   int visible=0;long renderedDeadline=SystemClock.uptimeMillis()+30000;
   do {
    instrumentation.runOnMainSync(()->capture[0]=texture.getBitmap());
    if(capture[0]!=null){
     Bitmap candidate=capture[0];visible=0;
     for(int y=0;y<candidate.getHeight();y+=3)for(int x=0;x<candidate.getWidth();x+=3)
      if((candidate.getPixel(x,y)&0x00ffffff)!=0)visible++;
     if(visible>250)break;
     candidate.recycle();capture[0]=null;
    }
    SystemClock.sleep(250);
   }while(SystemClock.uptimeMillis()<renderedDeadline);
   assertNotNull("No renderer bitmap",capture[0]);
   capture[0].recycle();
   SystemClock.sleep(5000);
   instrumentation.runOnMainSync(()->capture[0]=texture.getBitmap());
   assertNotNull("Delayed renderer bitmap missing",capture[0]);
   Bitmap image=capture[0];
   assertTrue("Renderer bitmap is black",visible>250);
   File out=new File(target.getFilesDir(),"txt-novel-reader-large.png");
   try(FileOutputStream stream=new FileOutputStream(out)){assertTrue(image.compress(Bitmap.CompressFormat.PNG,100,stream));}
   image.recycle();
  } finally {instrumentation.runOnMainSync(activity::finish);}
 }
 private static PodRuntimeView find(View root){
  if(root instanceof PodRuntimeView)return (PodRuntimeView)root;
  if(root instanceof ViewGroup){ViewGroup group=(ViewGroup)root;for(int index=0;index<group.getChildCount();index++){
   PodRuntimeView child=find(group.getChildAt(index));if(child!=null)return child;
  }}return null;
 }
 private static JSONObject result(Context target)throws Exception{
  File file=new File(target.getFilesDir(),"podjs/podjs-kv.json");
  if(!file.isFile())return new JSONObject();
  JSONObject kv=new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
  return kv.optJSONObject("phone-txt-novel-peer-result")==null?new JSONObject():kv.getJSONObject("phone-txt-novel-peer-result");
 }
}
