package dev.podjs.androidwatch;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;

/** Injects a single physical-style pointer stream only into the isolated fixture app. */
public final class SavedGestureInstrumentationTest {
    @Test public void longPressDragReordersAcrossRowsAndUndoRestores() throws Exception {
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Context context=instrumentation.getTargetContext();
        assertEquals("dev.podjs.tests.savedgesture",context.getPackageName());
        Activity activity=instrumentation.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            assertTrue("fixture not ready",waitForDescription(instrumentation,"READY:A,B,C",5000));
            // Scroll enough to expose the first and second cards together.
            injectSwipe(instrumentation,230,420,230,320,250);
            Thread.sleep(600);
            AccessibilityNodeInfo root=instrumentation.getUiAutomation().getRootInActiveWindow();
            String before=findDescription(root,"READY:");
            assertNotNull(before);
            // At density 2, card A is about y=110..280 physical pixels. Hold
            // within it for the framework's 0.5 s long-press deadline, then drag
            // through card B. All samples share one Android downTime and pointer.
            long down=SystemClock.uptimeMillis();
            inject(instrumentation,down,down,MotionEvent.ACTION_DOWN,230,195);
            Thread.sleep(750);
            long now=SystemClock.uptimeMillis();
            for(int i=1;i<=8;i++){
                float y=195+(180f*i/8f);
                inject(instrumentation,down,now+(i*35),MotionEvent.ACTION_MOVE,230,y);
                Thread.sleep(35);
            }
            long up=SystemClock.uptimeMillis();
            inject(instrumentation,down,up,MotionEvent.ACTION_UP,230,375);
            assertTrue("drag did not report cross-row reorder: "+description(instrumentation),waitForDescription(instrumentation,"REORDER:bravo,alpha,charlie",3000));
            assertTrue("reordered callback order incorrect: "+description(instrumentation),description(instrumentation).contains("REORDER:bravo,alpha,charlie"));
            // Remove alpha after it occupies row two, then tap the actual undo
            // surface to prove the callback and restored list order.
            injectSwipe(instrumentation,430,360,230,360,400);
            assertTrue("remove after reorder did not fire: "+description(instrumentation),waitForDescription(instrumentation,"REMOVE:fixture:alpha",3000));
            injectTap(instrumentation,233,60);
            assertTrue("undo click did not restore the removed alpha item: "+description(instrumentation),waitForDescription(instrumentation,"UNDO:fixture:alpha",3000));
            String finalDescription=description(instrumentation);
            String visibleOrder=visibleCardOrder(instrumentation.getUiAutomation().getRootInActiveWindow());
            assertTrue("undo did not restore alpha before bravo: "+visibleOrder,visibleOrder.indexOf("A")>=0&&visibleOrder.indexOf("A")<visibleOrder.indexOf("B"));
            android.util.Log.i("SavedGestureFixture","TRACE="+finalDescription+";VISIBLE_ORDER="+visibleOrder);
            android.graphics.Bitmap screenshot=instrumentation.getUiAutomation().takeScreenshot();
            if(screenshot!=null){
                java.io.File output=new java.io.File(context.getExternalFilesDir(null),"saved-gesture-final.png");
                try(java.io.FileOutputStream stream=new java.io.FileOutputStream(output)){screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,stream);}
                screenshot.recycle();
            }
        } finally { instrumentation.runOnMainSync(activity::finish); }
    }
    private static void injectSwipe(Instrumentation i,float x1,float y1,float x2,float y2,long duration)throws Exception {
        long down=SystemClock.uptimeMillis();inject(i,down,down,MotionEvent.ACTION_DOWN,x1,y1);
        int count=10;for(int n=1;n<=count;n++){long t=down+duration*n/count;inject(i,down,t,MotionEvent.ACTION_MOVE,x1+(x2-x1)*n/count,y1+(y2-y1)*n/count);Thread.sleep(duration/count);}
        long up=SystemClock.uptimeMillis();inject(i,down,up,MotionEvent.ACTION_UP,x2,y2);
    }
    private static void injectTap(Instrumentation i,float x,float y)throws Exception {
        long down=SystemClock.uptimeMillis();inject(i,down,down,MotionEvent.ACTION_DOWN,x,y);Thread.sleep(80);inject(i,down,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,x,y);
    }
    private static void inject(Instrumentation i,long down,long time,int action,float x,float y){
        MotionEvent event=MotionEvent.obtain(down,time,action,x,y,0);event.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        try{assertTrue("MotionEvent injection rejected",i.getUiAutomation().injectInputEvent(event,true));}finally{event.recycle();}
    }
    private static boolean waitForDescription(Instrumentation i,String needle,long timeout)throws Exception {
        long deadline=SystemClock.uptimeMillis()+timeout;do{if(description(i).contains(needle))return true;Thread.sleep(100);}while(SystemClock.uptimeMillis()<deadline);return false;
    }
    private static String description(Instrumentation i){return findDescription(i.getUiAutomation().getRootInActiveWindow(),"READY:");}
    private static String findDescription(AccessibilityNodeInfo node,String prefix){
        if(node==null)return "";CharSequence d=node.getContentDescription();if(d!=null&&d.toString().startsWith(prefix))return d.toString();
        for(int n=0;n<node.getChildCount();n++){String found=findDescription(node.getChild(n),prefix);if(!found.isEmpty())return found;}return "";
    }
    private static String visibleCardOrder(AccessibilityNodeInfo node){
        if(node==null)return "";StringBuilder out=new StringBuilder();collectCards(node,out);return out.toString();
    }
    private static void collectCards(AccessibilityNodeInfo node,StringBuilder out){
        CharSequence d=node.getContentDescription();if(d!=null){String value=d.toString();if(value.startsWith("文章：")){if(out.length()>0)out.append(',');out.append(value.contains("A：")?"A":value.contains("B：")?"B":value.contains("C：")?"C":"?");}}
        for(int n=0;n<node.getChildCount();n++)collectCards(node.getChild(n),out);
    }
}
