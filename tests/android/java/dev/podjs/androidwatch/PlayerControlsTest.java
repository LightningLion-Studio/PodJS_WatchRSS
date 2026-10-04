package dev.podjs.androidwatch;
import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.*;
import androidx.test.platform.app.InstrumentationRegistry;
import dev.podjs.runtime.*;
import org.json.JSONObject;
import org.junit.Test;
import java.io.*;
import java.lang.reflect.Field;
import java.util.concurrent.*;
import static org.junit.Assert.*;
public final class PlayerControlsTest {
 private final Instrumentation i=InstrumentationRegistry.getInstrumentation();
 private Object field(Object o,String name)throws Exception{Field f=o.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(o);}
 private PodRuntimeView find(View v){if(v instanceof PodRuntimeView)return (PodRuntimeView)v;if(v instanceof ViewGroup)for(int n=0;n<((ViewGroup)v).getChildCount();n++){PodRuntimeView p=find(((ViewGroup)v).getChildAt(n));if(p!=null)return p;}return null;}
 private JSONObject call(PodVideoServices service,String method,JSONObject args)throws Exception{CountDownLatch latch=new CountDownLatch(1);String[] error={null};JSONObject[] value={null};service.dispatch(method,args,new PodVideoServices.Callback(){public void complete(JSONObject r){value[0]=r;latch.countDown();}public void fail(String c,String m){error[0]=c+":"+m;latch.countDown();}});assertTrue(method,latch.await(8,TimeUnit.SECONDS));assertNull(error[0]);return value[0];}
 private JSONObject state(PodVideoServices s)throws Exception{return call(s,"video.state",new JSONObject());}
 private void event(Activity a,long down,int action,float x,float y){i.runOnMainSync(()->{MotionEvent e=MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,x,y,0);a.dispatchTouchEvent(e);e.recycle();});}
 private void tap(Activity a,int x,int y){long down=SystemClock.uptimeMillis();event(a,down,0,x,y);SystemClock.sleep(100);event(a,down,1,x,y);SystemClock.sleep(650);}
 private void swipe(Activity a,int x,int y,int ex,int ey){long down=SystemClock.uptimeMillis();event(a,down,0,x,y);for(int n=1;n<=10;n++){SystemClock.sleep(25);event(a,down,2,x+(ex-x)*n/10,y+(ey-y)*n/10);}event(a,down,1,ex,ey);SystemClock.sleep(700);}
 private void shot(Context c,String name)throws Exception{Bitmap b=i.getUiAutomation().takeScreenshot();assertNotNull(b);int white=0;for(int y=0;y<b.getHeight();y++)for(int x=0;x<b.getWidth();x++){int color=b.getPixel(x,y);if(((color>>16)&255)>170&&((color>>8)&255)>170&&(color&255)>170){white++;if(name.startsWith("player-black-"))assertTrue("control ink outside circular safe area: "+name+" "+x+","+y,Math.hypot(x-b.getWidth()/2.0,y-b.getHeight()/2.0)<=Math.min(b.getWidth(),b.getHeight())/2.0-1);}}if(name.startsWith("player-black-")){if(name.contains("hidden"))assertEquals("hidden controls must contain no white ink",0,white);else assertTrue("visible controls must remain on screen: "+name,white>500);}try(FileOutputStream f=new FileOutputStream(new File(c.getFilesDir(),name))){b.compress(Bitmap.CompressFormat.PNG,100,f);}b.recycle();}
 @Test public void blackBackgroundAndPlaybackControls()throws Exception{
  Context ctx=i.getTargetContext();Activity a=i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  PodVideoServices s=null;double oldVolume=-1;
  try{SystemClock.sleep(2000);PodRuntimeView view=find(a.getWindow().getDecorView());assertNotNull(view);s=(PodVideoServices)field(field(view,"services"),"video");
   tap(a,233,390);SystemClock.sleep(2500);tap(a,233,220);SystemClock.sleep(1800);swipe(a,233,390,233,70);tap(a,233,205);
   long deadline=SystemClock.uptimeMillis()+25000;JSONObject current;do{SystemClock.sleep(400);current=state(s);}while(!current.optString("state").equals("playing")&&SystemClock.uptimeMillis()<deadline);assertEquals("playing",current.optString("state"));oldVolume=current.getDouble("volume");
   tap(a,233,416);assertEquals("paused",state(s).getString("state"));long before=state(s).getLong("positionMs");tap(a,327,416);assertEquals(before+4000,state(s).getLong("positionMs"),1000);tap(a,139,416);assertEquals(before,state(s).getLong("positionMs"),1000);
   tap(a,183,56);assertEquals("expanded",field(s,"scaleMode"));tap(a,183,56);assertEquals("shrunk",field(s,"scaleMode"));tap(a,183,56);assertEquals("standard",field(s,"scaleMode"));
   for(int repeat=0;repeat<2;repeat++){for(int n=0;n<2;n++){long down=SystemClock.uptimeMillis();event(a,down,0,233,220);SystemClock.sleep(70);event(a,down,1,233,220);SystemClock.sleep(70);}SystemClock.sleep(500);assertEquals(repeat==0?"playing":"paused",state(s).getString("state"));}
   long hold=SystemClock.uptimeMillis();long pos=state(s).getLong("positionMs");event(a,hold,0,327,416);SystemClock.sleep(1000);event(a,hold,1,327,416);SystemClock.sleep(500);assertTrue("hold must repeat seek",state(s).getLong("positionMs")>=pos+8000);
   call(s,"video.seek",new JSONObject().put("positionMs",6000));SystemClock.sleep(800);
   TextureView texture=(TextureView)field(s,"videoView");View backdrop=(View)field(s,"backdrop");i.runOnMainSync(()->{texture.setAlpha(0f);if(backdrop!=null)backdrop.setVisibility(View.GONE);});SystemClock.sleep(400);shot(ctx,"player-black-controls.png");
   tap(a,233,220);shot(ctx,"player-black-hidden.png");tap(a,233,220);shot(ctx,"player-black-restored.png");
   tap(a,283,56);assertEquals(90f,(Float)field(s,"rotationDeg"),.1f);shot(ctx,"player-black-rotated.png");
   tap(a,410,283);assertEquals(180f,(Float)field(s,"rotationDeg"),.1f);shot(ctx,"player-black-180.png");tap(a,183,410);assertEquals(270f,(Float)field(s,"rotationDeg"),.1f);shot(ctx,"player-black-270.png");tap(a,56,183);assertEquals(360f,(Float)field(s,"rotationDeg"),.1f);
   i.runOnMainSync(()->{texture.setAlpha(1f);});SystemClock.sleep(500);shot(ctx,"player-real-rotated.png");
   call(s,"video.setVolume",new JSONObject().put("volume",0));SystemClock.sleep(600);
   i.runOnMainSync(()->{MotionEvent.PointerProperties p=new MotionEvent.PointerProperties();p.id=0;p.toolType=MotionEvent.TOOL_TYPE_MOUSE;MotionEvent.PointerCoords c=new MotionEvent.PointerCoords();c.setAxisValue(MotionEvent.AXIS_VSCROLL,-1);long now=SystemClock.uptimeMillis();MotionEvent e=MotionEvent.obtain(now,now,MotionEvent.ACTION_SCROLL,1,new MotionEvent.PointerProperties[]{p},new MotionEvent.PointerCoords[]{c},0,0,1,1,0,0,InputDevice.SOURCE_MOUSE,0);a.dispatchGenericMotionEvent(e);e.recycle();});SystemClock.sleep(500);assertTrue("normalized positive crown must increase volume",state(s).getDouble("volume")>0);
   swipe(a,60,233,410,233);assertEquals("stopped",state(s).getString("state"));shot(ctx,"player-return-detail.png");
  }finally{if(s!=null&&oldVolume>=0)call(s,"video.setVolume",new JSONObject().put("volume",oldVolume));i.runOnMainSync(a::finish);}
 }
}
