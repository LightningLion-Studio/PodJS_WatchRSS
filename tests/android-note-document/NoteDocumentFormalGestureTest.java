package dev.podjs.androidwatch;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.EditText;
import android.widget.ScrollView;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;

/** Runs against the installed formal app and never writes note text. */
public final class NoteDocumentFormalGestureTest {
 @Test public void existingLongNoteMovesCaretWithoutOpeningKeyboard() throws Exception {
  Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
  Context context=instrumentation.getTargetContext();
  assertEquals("com.lightningstudio.watchrss.podjs",context.getPackageName());
  Activity activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  try {
   click(instrumentation,"备忘录 纯文本编辑");
   click(instrumentation,"备忘录：README");
   click(instrumentation,"编辑备忘录");
   final EditText[] body={null};final ScrollView[] scroll={null};
   long deadline=SystemClock.uptimeMillis()+10000;
   while(SystemClock.uptimeMillis()<deadline){
    instrumentation.runOnMainSync(()->{
     body[0]=findBody(activity.getWindow().getDecorView());
     scroll[0]=findScroll(activity.getWindow().getDecorView());
    });
    if(body[0]!=null&&scroll[0]!=null)break;
    Thread.sleep(100);
   }
   assertNotNull("formal note body not mounted",body[0]);
   assertNotNull("shared document scroll missing",scroll[0]);
   final int[] before={0},point=new int[2],step={0};
   instrumentation.runOnMainSync(()->{
    assertFalse("opening note should not focus body",body[0].hasFocus());
    assertTrue("expected a long formal note",body[0].length()>20000);
    before[0]=body[0].getSelectionStart();
    scroll[0].getLocationOnScreen(point);
    point[0]+=scroll[0].getWidth()/2;
    point[1]+=Math.round(scroll[0].getHeight()*0.7f);
    step[0]=Math.round(context.getResources().getDisplayMetrics().density*24);
   });
   long started=SystemClock.uptimeMillis();
   pointer(instrumentation,started,started,MotionEvent.ACTION_DOWN,point[0],point[1]);
   pointer(instrumentation,started,started+50,MotionEvent.ACTION_MOVE,point[0],point[1]-step[0]);
   pointer(instrumentation,started,started+100,MotionEvent.ACTION_MOVE,point[0],point[1]-step[0]*2);
   pointer(instrumentation,started,started+150,MotionEvent.ACTION_UP,point[0],point[1]-step[0]*2);
   instrumentation.waitForIdleSync();
   instrumentation.runOnMainSync(()->{
    int after=body[0].getSelectionStart();
    assertTrue("formal swipe did not advance caret: "+before[0]+" -> "+after,after>before[0]);
    assertFalse("formal swipe unexpectedly focused body",body[0].hasFocus());
    android.util.Log.i("NoteDocumentFormal","caret="+before[0]+"->"+after
        +" visualLine="+body[0].getLayout().getLineForOffset(before[0])+"->"
        +body[0].getLayout().getLineForOffset(after)+" scrollY="+scroll[0].getScrollY());
   });
   instrumentation.runOnMainSync(()->{
    int prior=body[0].getSelectionStart();
    long now=SystemClock.uptimeMillis();
    for(int index=0;index<=5;index++){
     MotionEvent event=crown(-1f,now+index*40L);
     try{assertTrue("document crown was not consumed",activity.dispatchGenericMotionEvent(event));}
     finally{event.recycle();}
    }
    int after=body[0].getSelectionStart();
    assertTrue("formal crown did not advance body code point: "+prior+" -> "+after,after>prior);
    assertFalse("crown unexpectedly focused body",body[0].hasFocus());
    android.util.Log.i("NoteDocumentFormal","crownBody="+prior+"->"+after);
   });
   instrumentation.runOnMainSync(()->{
    EditText title=findTitle(activity.getWindow().getDecorView());
    assertNotNull("formal title field missing",title);
    title.setSelection(0);
    title.requestFocus();
    MotionEvent event=crown(-1f,SystemClock.uptimeMillis());
    try{assertTrue("title crown was not consumed",activity.dispatchGenericMotionEvent(event));}
    finally{event.recycle();}
    assertEquals("title crown must move one code point",1,title.getSelectionStart());
    android.util.Log.i("NoteDocumentFormal","crownTitle=0->"+title.getSelectionStart());
   });
   click(instrumentation,"关闭编辑，");
  }finally{instrumentation.runOnMainSync(activity::finish);}
 }
 private static void click(Instrumentation instrumentation,String prefix)throws Exception {
  long deadline=SystemClock.uptimeMillis()+10000;
  while(SystemClock.uptimeMillis()<deadline){
   AccessibilityNodeInfo node=findDescription(instrumentation.getUiAutomation().getRootInActiveWindow(),prefix);
   if(node!=null&&node.performAction(AccessibilityNodeInfo.ACTION_CLICK)){instrumentation.waitForIdleSync();return;}
   Thread.sleep(100);
  }
  fail("missing clickable element: "+prefix);
 }
 private static AccessibilityNodeInfo findDescription(AccessibilityNodeInfo node,String prefix){
  if(node==null)return null;
  if(node.getContentDescription()!=null&&node.getContentDescription().toString().startsWith(prefix))return node;
  for(int index=0;index<node.getChildCount();index++){
   AccessibilityNodeInfo found=findDescription(node.getChild(index),prefix);
   if(found!=null)return found;
  }
  return null;
 }
 private static EditText findBody(View view){
  if(view instanceof EditText&&"直接输入原始文本".contentEquals(((EditText)view).getHint()))return (EditText)view;
  if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int index=0;index<group.getChildCount();index++){
   EditText found=findBody(group.getChildAt(index));if(found!=null)return found;
  }}
  return null;
 }
 private static EditText findTitle(View view){
  if(view instanceof EditText&&"未命名笔记".contentEquals(((EditText)view).getHint()))return (EditText)view;
  if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int index=0;index<group.getChildCount();index++){
   EditText found=findTitle(group.getChildAt(index));if(found!=null)return found;
  }}
  return null;
 }
 private static ScrollView findScroll(View view){
  if(view instanceof ScrollView)return (ScrollView)view;
  if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int index=0;index<group.getChildCount();index++){
   ScrollView found=findScroll(group.getChildAt(index));if(found!=null)return found;
  }}
  return null;
 }
 private static void pointer(Instrumentation instrumentation,long down,long now,int action,float x,float y){
  MotionEvent event=MotionEvent.obtain(down,now,action,x,y,0);
  try{instrumentation.sendPointerSync(event);}finally{event.recycle();}
 }
 private static MotionEvent crown(float vertical,long uptime){
  MotionEvent.PointerProperties pointer=new MotionEvent.PointerProperties();
  pointer.id=0;pointer.toolType=MotionEvent.TOOL_TYPE_MOUSE;
  MotionEvent.PointerCoords coords=new MotionEvent.PointerCoords();
  coords.setAxisValue(MotionEvent.AXIS_VSCROLL,vertical);
  return MotionEvent.obtain(0,uptime,MotionEvent.ACTION_SCROLL,1,
      new MotionEvent.PointerProperties[]{pointer},new MotionEvent.PointerCoords[]{coords},
      0,0,1f,1f,0,0,InputDevice.SOURCE_ROTARY_ENCODER,0);
 }
}
