package dev.podjs.runtime;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Test;

/** Read-only renderer probe; no touch, crown, keyboard or account mutation. */
public final class AccountStatusRuntimeTest {
  @Test public void accountStatesRenderInAnIsolatedPackage() throws Exception {
    Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    Context context = instrumentation.getTargetContext();
    assertEquals("dev.podjs.tests.accountstatus", context.getPackageName());
    Activity activity = instrumentation.startActivitySync(new Intent()
      .setClassName(context.getPackageName(), "dev.podjs.androidwatch.MainActivity")
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    try {
      PodRuntimeView view = awaitView(activity);
      Bitmap previous = null;
      for (String stage : new String[]{"unbound", "bound", "expired"}) {
        awaitStage(context, stage);
        Bitmap[] holder = new Bitmap[1];
        instrumentation.runOnMainSync(() -> holder[0] = view.getBitmap());
        Bitmap frame = holder[0];
        assertNotNull(stage, frame);
        assertEquals(466, frame.getWidth());
        assertEquals(466, frame.getHeight());
        int visible = 0, changed = 0;
        for (int y = 30; y < 400; y++) for (int x = 30; x < 436; x++) {
          int rgb = frame.getPixel(x, y) & 0xffffff;
          if (rgb != 0 && rgb != 0x050507) visible++;
          if (previous != null && frame.getPixel(x, y) != previous.getPixel(x, y)) changed++;
        }
        assertTrue(stage + " contains no visible content", visible > 500);
        if (previous != null) assertTrue(stage + " did not redraw account content", changed > 500);
        try (FileOutputStream out = new FileOutputStream(new File(context.getFilesDir(), "account-" + stage + ".png"))) {
          assertTrue(frame.compress(Bitmap.CompressFormat.PNG, 100, out));
        }
        if (previous != null) previous.recycle();
        previous = frame;
        File gate = new File(context.getFilesDir(), "podjs/files/account-advance-" + stage);
        assertTrue(gate.getParentFile().mkdirs() || gate.getParentFile().isDirectory());
        assertTrue(gate.createNewFile());
      }
      if (previous != null) previous.recycle();
      awaitStage(context, "done");
      JSONObject result = result(context);
      assertEquals("passed", result.getString("state"));
    } finally {
      instrumentation.runOnMainSync(activity::finish);
      instrumentation.waitForIdleSync();
    }
  }

  private static JSONObject result(Context context) throws Exception {
    File file = new File(context.getFilesDir(), "podjs/podjs-kv.json");
    if (!file.isFile()) return null;
    return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8))
      .optJSONObject("account-status-ui-result");
  }

  private static void awaitStage(Context context, String stage) throws Exception {
    long deadline = SystemClock.uptimeMillis() + 30000;
    while (SystemClock.uptimeMillis() < deadline) {
      JSONObject state = result(context);
      if (state != null) {
        assertNotEquals(state.toString(), "failed", state.optString("state"));
        if (stage.equals(state.optString("stage"))) return;
      }
      SystemClock.sleep(100);
    }
    throw new AssertionError("Missing stage " + stage + ": " + result(context));
  }

  private static PodRuntimeView awaitView(Activity activity) {
    long deadline = SystemClock.uptimeMillis() + 30000;
    PodRuntimeView view;
    while ((view = find(activity.getWindow().getDecorView())) == null && SystemClock.uptimeMillis() < deadline)
      SystemClock.sleep(100);
    assertNotNull(view);
    return view;
  }

  private static PodRuntimeView find(View view) {
    if (view instanceof PodRuntimeView) return (PodRuntimeView) view;
    if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
      PodRuntimeView nested = find(((ViewGroup) view).getChildAt(i));
      if (nested != null) return nested;
    }
    return null;
  }
}
