package dev.podjs.runtime;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.PixelCopy;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

/** Exercise the isolated app window while the watch's charging overlay owns system focus. */
public final class NoteImageFailureDialogTest {
 @Test public void missingImageLinkOpensDownloadDialog() throws Exception {
  Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
  Context context=instrumentation.getTargetContext();
  Intent launch=context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
  assertNotNull(launch);
  launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK);
  Activity activity=instrumentation.startActivitySync(launch);
  assertNotNull(activity);
  SystemClock.sleep(6000);
  Bitmap before=capture(instrumentation,activity);
  save(context,before,"note-image-failure-before.png");
  before.recycle();
  long time=SystemClock.uptimeMillis();
  MotionEvent down=MotionEvent.obtain(time,time,MotionEvent.ACTION_DOWN,233f,356f,0);
  MotionEvent up=MotionEvent.obtain(time,time+90,MotionEvent.ACTION_UP,233f,356f,0);
  instrumentation.runOnMainSync(()->{activity.dispatchTouchEvent(down);activity.dispatchTouchEvent(up);});
  down.recycle();up.recycle();
  SystemClock.sleep(1300);
  Bitmap bitmap=capture(instrumentation,activity);
  save(context,bitmap,"note-image-failure-dialog.png");
  int corner=bitmap.getPixel(0,0);
  assertTrue("download dialog should darken the light reader background",((corner>>16)&255)<100&&((corner>>8)&255)<100&&(corner&255)<100);
  bitmap.recycle();
 }
 private static Bitmap capture(Instrumentation instrumentation,Activity activity) throws Exception {
  Bitmap bitmap=Bitmap.createBitmap(activity.getWindow().getDecorView().getWidth(),activity.getWindow().getDecorView().getHeight(),Bitmap.Config.ARGB_8888);
  CountDownLatch done=new CountDownLatch(1);AtomicInteger code=new AtomicInteger(PixelCopy.ERROR_UNKNOWN);
  instrumentation.runOnMainSync(()->PixelCopy.request(activity.getWindow(),bitmap,result->{code.set(result);done.countDown();},new Handler(Looper.getMainLooper())));
  assertTrue(done.await(5,TimeUnit.SECONDS));
  assertEquals(PixelCopy.SUCCESS,code.get());
  return bitmap;
 }
 private static void save(Context context,Bitmap bitmap,String name) throws Exception {
  try(FileOutputStream out=context.openFileOutput(name,Context.MODE_PRIVATE)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}
 }
}
