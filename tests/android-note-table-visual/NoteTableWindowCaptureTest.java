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
import android.view.PixelCopy;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

/** Capture the app window behind a device-wide charging overlay. */
public final class NoteTableWindowCaptureTest {
 @Test public void captureProductionTableComponentWindow() throws Exception {
  Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
  Context context=instrumentation.getTargetContext();
  Intent launch=context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
  assertNotNull(launch);
  launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK);
  Activity activity=instrumentation.startActivitySync(launch);
  assertNotNull(activity);
  SystemClock.sleep(6000);
  int width=activity.getWindow().getDecorView().getWidth(),height=activity.getWindow().getDecorView().getHeight();
  assertTrue(width>0&&height>0);
  Bitmap bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);
  CountDownLatch done=new CountDownLatch(1);AtomicInteger code=new AtomicInteger(PixelCopy.ERROR_UNKNOWN);
  instrumentation.runOnMainSync(()->PixelCopy.request(activity.getWindow(),bitmap,result->{code.set(result);done.countDown();},new Handler(Looper.getMainLooper())));
  assertTrue("PixelCopy timeout",done.await(5,TimeUnit.SECONDS));
  assertEquals("PixelCopy result",PixelCopy.SUCCESS,code.get());
  try(FileOutputStream out=context.openFileOutput("note-table-window.png",Context.MODE_PRIVATE)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}
  bitmap.recycle();
 }
}
