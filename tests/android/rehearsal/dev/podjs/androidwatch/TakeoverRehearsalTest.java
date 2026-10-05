package dev.podjs.androidwatch;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import dev.podjs.runtime.PodTakeover;
import dev.podjs.runtime.PodRuntimeView;
import java.io.File;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Read-only production-root/render acceptance. Never seeds or mutates fixtures. */
@RunWith(AndroidJUnit4.class)
public final class TakeoverRehearsalTest {
    private TextureView texture(View view) {
        if(view instanceof PodRuntimeView)return (TextureView)view;
        if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++) {
            TextureView found=texture(((ViewGroup)view).getChildAt(i));if(found!=null)return found;
        }
        return null;
    }
    @Test public void activeProductionStoresAndGuestFrame() throws Exception {
        android.app.Instrumentation registry=InstrumentationRegistry.getInstrumentation();
        Context context=registry.getTargetContext();
        assertEquals("com.lightningstudio.watchrss.podjs.rehearsal",context.getPackageName());
        assertEquals("ACTIVE",PodTakeover.status(context).getString("phase"));
        assertTrue(PodTakeover.ready(context));
        File database=PodTakeover.database(context);
        assertTrue(database.getCanonicalPath().contains("/files/package-takeover/generations/g-"));
        try(SQLiteDatabase db=SQLiteDatabase.openDatabase(database.getPath(),null,SQLiteDatabase.OPEN_READONLY)) {
            for(String table:new String[]{"channels","articles","article_reading_state","article_saved_states"})
                try(Cursor rows=db.rawQuery("SELECT count(*) FROM "+table,null)){assertTrue(rows.moveToFirst());assertTrue(rows.getLong(0)>=0);}
        }
        new JSONObject(new String(Files.readAllBytes(new File(PodTakeover.dataRoot(context),"podjs-kv.json").toPath()),java.nio.charset.StandardCharsets.UTF_8));
        Activity activity=registry.startActivitySync(new Intent().setClassName(context.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            boolean rendered=false;long end=SystemClock.uptimeMillis()+30000;
            while(SystemClock.uptimeMillis()<end && !rendered) {
                final boolean[] frame={false};
                registry.runOnMainSync(() -> {
                    TextureView view=texture(activity.getWindow().getDecorView());
                    if(view==null||!view.isAvailable())return;
                    Bitmap bitmap=view.getBitmap();if(bitmap==null)return;
                    try {int first=bitmap.getPixel(0,0);for(int y=0;y<bitmap.getHeight();y+=8)for(int x=0;x<bitmap.getWidth();x+=8)if(bitmap.getPixel(x,y)!=first)frame[0]=true;}
                    finally {bitmap.recycle();}
                });
                rendered=frame[0];if(!rendered)SystemClock.sleep(100);
            }
            assertTrue("guest frame not rendered",rendered);
            assertEquals("ACTIVE",PodTakeover.status(context).getString("phase"));
        } finally {registry.runOnMainSync(activity::finish);}
    }
}
