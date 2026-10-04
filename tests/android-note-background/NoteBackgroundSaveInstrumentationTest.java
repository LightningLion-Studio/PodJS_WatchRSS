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
import android.widget.EditText;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;

/** Uses only a disposable editor package and its private database. */
public final class NoteBackgroundSaveInstrumentationTest {
 @Test public void pauseFlushesDraftBeforeForegroundDebounce() throws Exception {
  Instrumentation i=InstrumentationRegistry.getInstrumentation();
  Context context=i.getTargetContext();
  assertEquals("dev.podjs.tests.notebackground",context.getPackageName());
  Activity activity=i.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try {
   EditText title=waitForField(i,activity,"新建备忘录",10000),body=waitForField(i,activity,"直接输入原始文本",10000);
   assertNotNull("title field missing",title);assertNotNull("body field missing",body);
   i.runOnMainSync(()->{title.setText("后台保存标题");body.setText("快速退后台仍需保存的正文");});
   Thread.sleep(90);
   assertEquals("debounce unexpectedly completed before background",0,rowCount(context));
   long backgroundAt=SystemClock.uptimeMillis();
   i.runOnMainSync(()->assertTrue(activity.moveTaskToBack(true)));
   long deadline=backgroundAt+5000;
   while(SystemClock.uptimeMillis()<deadline){
    if(saved(context)){android.util.Log.i("NoteBackgroundSaveTest","savedAfterBackgroundMs="+(SystemClock.uptimeMillis()-backgroundAt));return;}
    Thread.sleep(50);
   }
   fail("draft did not save after Activity entered background");
  }finally{i.runOnMainSync(activity::finish);}
 }
 private static boolean saved(Context context){
  try(SQLiteDatabase db=context.openOrCreateDatabase("podjs.sqlite",0,null);Cursor cursor=db.rawQuery("SELECT title,markdown FROM memo_notes WHERE deleted=0",null)){
   return cursor.moveToFirst()&&"后台保存标题".equals(cursor.getString(0))&&"快速退后台仍需保存的正文".equals(cursor.getString(1))&&!cursor.moveToNext();
  }catch(Exception e){return false;}
 }
 private static int rowCount(Context context){
  try(SQLiteDatabase db=context.openOrCreateDatabase("podjs.sqlite",0,null);Cursor cursor=db.rawQuery("SELECT count(*) FROM memo_notes",null)){return cursor.moveToFirst()?cursor.getInt(0):-1;}
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
}
