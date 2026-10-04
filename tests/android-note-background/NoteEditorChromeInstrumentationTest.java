package dev.podjs.androidwatch;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.FileOutputStream;
import org.junit.Test;

/** Checks the production editor component in a disposable, private-data APK. */
public final class NoteEditorChromeInstrumentationTest {
 @Test public void centeredDocumentEditorClosesAndSaves() throws Exception {
  Instrumentation i=InstrumentationRegistry.getInstrumentation();
  Context context=i.getTargetContext();
  assertEquals("dev.podjs.tests.notebackground",context.getPackageName());
  Activity activity=i.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try {
   EditText title=waitForField(i,activity,"新建备忘录",10000),body=waitForField(i,activity,"直接输入原始文本",10000);
   assertNotNull("centered title missing",title);assertNotNull("raw body missing",body);
   final int[] titlePosition=new int[2],bodyPosition=new int[2];
   i.runOnMainSync(()->{
    assertEquals(Gravity.CENTER_HORIZONTAL,title.getGravity()&Gravity.HORIZONTAL_GRAVITY_MASK);
    title.getLocationOnScreen(titlePosition);body.getLocationOnScreen(bodyPosition);
    title.setText("居中标题");body.setText("关闭按钮仍保存正文");
    InputMethodManager imm=(InputMethodManager)context.getSystemService(Context.INPUT_METHOD_SERVICE);
    imm.hideSoftInputFromWindow(body.getWindowToken(),0);body.clearFocus();
   });
   assertEquals("title top",85,titlePosition[1]);
   assertEquals("body top",161,bodyPosition[1]);
   AccessibilityNodeInfo close=null;
   long closeDeadline=SystemClock.uptimeMillis()+6000;
   while(SystemClock.uptimeMillis()<closeDeadline){
    close=findDescriptionPrefix(i.getUiAutomation().getRootInActiveWindow(),"关闭编辑，");
    if(close!=null)break;
    Thread.sleep(100);
   }
   assertNotNull("native-style close button missing",close);
   Rect bounds=new Rect();close.getBoundsInScreen(bounds);
   assertTrue("close not centered: "+bounds,Math.abs(bounds.centerX()-233)<=4);
   assertTrue("close outside bottom toolbar: "+bounds,bounds.top>=352&&bounds.bottom<=466);
   Bitmap capture=i.getUiAutomation().takeScreenshot();
   assertNotNull("editor screenshot missing",capture);
   try(FileOutputStream file=new FileOutputStream(context.getFilesDir().getAbsolutePath()+"/editor-chrome.png")){assertTrue(capture.compress(Bitmap.CompressFormat.PNG,100,file));}
   assertTrue("close action failed",close.performAction(AccessibilityNodeInfo.ACTION_CLICK));
   long deadline=SystemClock.uptimeMillis()+6000;
   while(SystemClock.uptimeMillis()<deadline){if(saved(context))return;Thread.sleep(100);}
   fail("close did not persist title and body");
  }finally{i.runOnMainSync(activity::finish);}
 }
 private static boolean saved(Context context){
  try(SQLiteDatabase db=context.openOrCreateDatabase("podjs.sqlite",0,null);Cursor cursor=db.rawQuery("SELECT title,markdown FROM memo_notes WHERE deleted=0",null)){
   return cursor.moveToFirst()&&"居中标题".equals(cursor.getString(0))&&"关闭按钮仍保存正文".equals(cursor.getString(1))&&!cursor.moveToNext();
  }catch(Exception error){return false;}
 }
 private static EditText waitForField(Instrumentation i,Activity activity,String hint,long timeout)throws Exception{
  long deadline=SystemClock.uptimeMillis()+timeout;
  do{final EditText[] found={null};i.runOnMainSync(()->found[0]=find(activity.getWindow().getDecorView(),hint));if(found[0]!=null)return found[0];Thread.sleep(100);}while(SystemClock.uptimeMillis()<deadline);
  return null;
 }
 private static EditText find(View view,String hint){
  if(view instanceof EditText&&hint.contentEquals(((EditText)view).getHint()))return (EditText)view;
  if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int n=0;n<group.getChildCount();n++){EditText found=find(group.getChildAt(n),hint);if(found!=null)return found;}}
  return null;
 }
 private static AccessibilityNodeInfo findDescriptionPrefix(AccessibilityNodeInfo node,String prefix){
  if(node==null)return null;
  if(node.getContentDescription()!=null&&node.getContentDescription().toString().startsWith(prefix))return node;
  for(int n=0;n<node.getChildCount();n++){AccessibilityNodeInfo found=findDescriptionPrefix(node.getChild(n),prefix);if(found!=null)return found;}
  return null;
 }
}
