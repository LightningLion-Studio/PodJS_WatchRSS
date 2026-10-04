package dev.podjs.androidwatch;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.EditText;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;

/** Edits only the isolated fixture's native fields; never injects production input. */
public final class NoteEditorHistoryRegressionTest {
 @Test public void titleAndMultilineBodyAutosaveWithoutLosingRawTitle() throws Exception {
  Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
  Context context=instrumentation.getTargetContext();
  assertEquals("dev.podjs.tests.notebackground",context.getPackageName());
  Activity activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try {
   EditText title=waitForField(instrumentation,activity,"新建备忘录",6000),body=waitForField(instrumentation,activity,"直接输入原始文本",6000);
   assertNotNull("title input missing",title);assertNotNull("body input missing",body);
   instrumentation.runOnMainSync(()->title.setText("  原始标题  "));
   assertRow(context,"  原始标题  ","",6000);
   instrumentation.runOnMainSync(()->body.setText("第一行\n第二行"));
   assertRow(context,"  原始标题  ","第一行\n第二行",6000);
   instrumentation.runOnMainSync(()->body.setText("第一行\n第二行\n第三行"));
   assertRow(context,"  原始标题  ","第一行\n第二行\n第三行",6000);
   clickDescription(instrumentation,"撤销");
   waitForText(instrumentation,body,"第一行\n第二行",6000);
   assertRow(context,"  原始标题  ","第一行\n第二行",6000);
   clickDescription(instrumentation,"重做");
   waitForText(instrumentation,body,"第一行\n第二行\n第三行",6000);
   assertRow(context,"  原始标题  ","第一行\n第二行\n第三行",6000);
   instrumentation.runOnMainSync(()->title.setText(""));
   assertRow(context,"","第一行\n第二行\n第三行",6000);
   instrumentation.runOnMainSync(()->title.setText("关闭前的新标题"));
   instrumentation.runOnMainSync(()->{InputMethodManager imm=(InputMethodManager)context.getSystemService(Context.INPUT_METHOD_SERVICE);imm.hideSoftInputFromWindow(body.getWindowToken(),0);body.clearFocus();});
   Thread.sleep(300);
   AccessibilityNodeInfo done=findDescription(instrumentation.getUiAutomation().getRootInActiveWindow(),"关闭编辑，");
   assertNotNull("finish button missing",done);
   assertTrue("finish button refused click",done.performAction(AccessibilityNodeInfo.ACTION_CLICK));
   assertRow(context,"关闭前的新标题","第一行\n第二行\n第三行",6000);
  } finally {instrumentation.runOnMainSync(activity::finish);}
 }
 private static EditText waitForField(Instrumentation i,Activity activity,String hint,long timeout)throws Exception {
  long deadline=SystemClock.uptimeMillis()+timeout;
  do {final EditText[] result={null};i.runOnMainSync(()->result[0]=find(activity.getWindow().getDecorView(),hint));if(result[0]!=null)return result[0];Thread.sleep(100);}while(SystemClock.uptimeMillis()<deadline);
  return null;
 }
 private static EditText find(View view,String hint){
  if(view instanceof EditText&&hint.contentEquals(((EditText)view).getHint()))return (EditText)view;
  if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int n=0;n<group.getChildCount();n++){EditText found=find(group.getChildAt(n),hint);if(found!=null)return found;}}
  return null;
 }
 private static AccessibilityNodeInfo findDescription(AccessibilityNodeInfo node,String description){
  if(node==null)return null;
  if(node.getContentDescription()!=null&&node.getContentDescription().toString().startsWith(description))return node;
  for(int i=0;i<node.getChildCount();i++){AccessibilityNodeInfo found=findDescription(node.getChild(i),description);if(found!=null)return found;}
  return null;
 }
 private static void clickDescription(Instrumentation instrumentation,String description)throws Exception {
  long deadline=SystemClock.uptimeMillis()+6000;
  do {
   AccessibilityNodeInfo found=findDescription(instrumentation.getUiAutomation().getRootInActiveWindow(),description);
   if(found!=null&&found.performAction(AccessibilityNodeInfo.ACTION_CLICK))return;
   Thread.sleep(100);
  }while(SystemClock.uptimeMillis()<deadline);
  fail("button missing or refused click: "+description);
 }
 private static void waitForText(Instrumentation instrumentation,EditText field,String expected,long timeout)throws Exception {
  long deadline=SystemClock.uptimeMillis()+timeout;
  do {final String[] value={null};instrumentation.runOnMainSync(()->value[0]=field.getText().toString());if(expected.equals(value[0]))return;Thread.sleep(100);}while(SystemClock.uptimeMillis()<deadline);
  fail("field text did not become: "+expected);
 }
 private static void assertRow(Context context,String title,String markdown,long timeout)throws Exception {
  long deadline=SystemClock.uptimeMillis()+timeout;String last="missing";
  do {
   try(SQLiteDatabase db=context.openOrCreateDatabase("podjs.sqlite",0,null);Cursor cursor=db.rawQuery("SELECT title,markdown FROM memo_notes WHERE deleted=0",null)){
    if(cursor.moveToFirst()){last=cursor.getString(0)+"|"+cursor.getString(1);if(title.equals(cursor.getString(0))&&markdown.equals(cursor.getString(1))&&!cursor.moveToNext())return;}
   }
   Thread.sleep(100);
  }while(SystemClock.uptimeMillis()<deadline);
  fail("expected raw title/body not saved; observed="+last);
 }
}
