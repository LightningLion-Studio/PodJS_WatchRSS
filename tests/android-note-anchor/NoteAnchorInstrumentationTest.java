package dev.podjs.androidwatch;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.EditText;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;

/** Runs against a disposable note-reader fixture, without touching the user's notes. */
public final class NoteAnchorInstrumentationTest {
 @Test public void editStartsAtVisibleReadingPosition() throws Exception {
  Instrumentation i=InstrumentationRegistry.getInstrumentation();
  Context context=i.getTargetContext();
  assertEquals("dev.podjs.tests.noteanchor",context.getPackageName());
  Activity activity=i.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try {
   Thread.sleep(1800);
   long deadline=SystemClock.uptimeMillis()+10000;
   AccessibilityNodeInfo edit=null;
   while(SystemClock.uptimeMillis()<deadline){edit=findDescription(i.getUiAutomation().getRootInActiveWindow(),"编辑备忘录");if(edit!=null)break;Thread.sleep(100);}
   assertNotNull("edit action missing",edit);
   assertTrue("edit action refused click",edit.performAction(AccessibilityNodeInfo.ACTION_CLICK));
   EditText body=null;
   while(SystemClock.uptimeMillis()<deadline+5000){final EditText[] found={null};i.runOnMainSync(()->found[0]=findField(activity.getWindow().getDecorView(),"正文"));body=found[0];if(body!=null)break;Thread.sleep(100);}
   assertNotNull("body field missing",body);
   final EditText field=body;final int[] selection={-1},length={0};
   i.runOnMainSync(()->{selection[0]=field.getSelectionStart();length[0]=field.length();});
   android.util.Log.i("NoteAnchorTest","selection="+selection[0]+" length="+length[0]);
   assertTrue("scrolled reader selection remained near start: "+selection[0],selection[0]>100);
   assertTrue("reader-center selection jumped to end: "+selection[0]+"/"+length[0],selection[0]<length[0]-20);
  }finally{i.runOnMainSync(activity::finish);}
 }
 private static EditText findField(View view,String hint){
  if(view instanceof EditText&&hint.contentEquals(((EditText)view).getHint()))return (EditText)view;
  if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int n=0;n<group.getChildCount();n++){EditText found=findField(group.getChildAt(n),hint);if(found!=null)return found;}}
  return null;
 }
 private static AccessibilityNodeInfo findDescription(AccessibilityNodeInfo node,String label){
  if(node==null)return null;
  if(node.getContentDescription()!=null&&label.contentEquals(node.getContentDescription()))return node;
  for(int n=0;n<node.getChildCount();n++){AccessibilityNodeInfo found=findDescription(node.getChild(n),label);if(found!=null)return found;}
  return null;
 }
}
