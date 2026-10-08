package dev.podjs.runtime;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.database.sqlite.SQLiteDatabase;
import android.database.Cursor;
import android.os.Bundle;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.WorkManager;
import java.io.*;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Synthetic post-activation data; injected into instrumentation only. */
public final class T6PodDataTest {
    private Context context() {
        Context c=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.lightningstudio.watchrss.podjs.rehearsal",c.getPackageName());
        assertTrue((c.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE)!=0);
        PodTakeover.requireReady(c);assertEquals("ACTIVE",PodTakeover.status(c).optString("phase"));return c;
    }
    private void report(String stage) {
        Bundle b=new Bundle();b.putString("stage",stage);b.putBoolean("dataMatches",true);
        b.putBoolean("workManagerAvailable",true);InstrumentationRegistry.getInstrumentation().sendStatus(0,b);
    }
    @Test public void verifyMigratedBusiness() throws Exception {
        Context c=context();
        try(SQLiteDatabase db=SQLiteDatabase.openDatabase(PodTakeover.database(c).getPath(),null,SQLiteDatabase.OPEN_READONLY)) {
            for(String query:new String[]{"SELECT COUNT(*) FROM channels WHERE title LIKE 'T6 Synthetic %'","SELECT COUNT(*) FROM articles WHERE title LIKE 'T6 Article %'"}) {
                try(Cursor rows=db.rawQuery(query,null)){assertTrue(rows.moveToFirst());assertEquals(3,rows.getInt(0));}
            }
            try(Cursor rows=db.rawQuery("SELECT COUNT(*) FROM memo_notes WHERE markdown=?",new String[]{"# T6 native synthetic note\nrestore baseline"})){assertTrue(rows.moveToFirst());assertEquals(1,rows.getInt(0));}
            try(Cursor rows=db.rawQuery("SELECT COUNT(*) FROM offline_media",null)){assertTrue(rows.moveToFirst());assertEquals(1,rows.getInt(0));}
        }
        org.json.JSONObject values=new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(new File(PodTakeover.dataRoot(c),"podjs-kv.json").toPath()),java.nio.charset.StandardCharsets.UTF_8));
        org.json.JSONObject settings=values.getJSONObject("watchrss.settings");
        assertFalse("native_phone_flag_preserved",settings.getBoolean("phoneConnectionEnabled"));
        assertEquals("native_font_size_preserved",18,settings.getInt("fontSizeSp"));
        assertTrue("reader_catalog_mapped",values.getJSONObject("watchrss.reader-presets").getJSONArray("records").length()>0);
        for(String path:new String[]{"offline/rss/t6/t6.png","offline/rss/t6/interrupt.bin","reader_assets/fonts/t6-system.ttf","reader_assets/backgrounds/t6.png"})
            assertTrue("resource_migrated",new File(PodTakeover.filesRoot(c),path).isFile());
        try(SQLiteDatabase db=SQLiteDatabase.openDatabase(PodTakeover.database(c).getPath(),null,SQLiteDatabase.OPEN_READONLY);
            Cursor rows=db.rawQuery("SELECT is_read,reading_progress FROM articles WHERE title='T6 Article 2'",null)){
            assertTrue(rows.moveToFirst());assertEquals(1,rows.getInt(0));assertEquals(.5,rows.getDouble(1),.00001);
        }
        assertNotNull(WorkManager.getInstance(c));report("podjs-business");
    }
    @Test public void addSyntheticNoteAndArchiveMarker() throws Exception {
        Context c=context();String body="# T6 PodJS synthetic note\narchive after recovery";
        String hash=dev.podjs.takeover.NativeBackup.hash(writeBody(c,body));
        try(SQLiteDatabase db=SQLiteDatabase.openDatabase(PodTakeover.database(c).getPath(),null,SQLiteDatabase.OPEN_READWRITE)) {
            try(Cursor rows=db.rawQuery("SELECT COUNT(*) FROM memo_notes WHERE note_id='t6-podjs-note'",null)){assertTrue(rows.moveToFirst());assertEquals(0,rows.getInt(0));}
            db.execSQL("INSERT INTO memo_notes(note_id,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at) VALUES(?,NULL,?,?,?,?,?,?,0,?,?,?,0,0)",new Object[]{"t6-podjs-note","T6 PodJS synthetic note",body,body,hash,hash,body,1700000000000L,1700000000000L,"t6-podjs-synthetic"});
        }
        report("podjs-new-note");
    }
    private File writeBody(Context c,String body) throws Exception {
        File file=new File(PodTakeover.filesRoot(c),"t6-new-note.txt");assertFalse(file.exists());
        assertTrue(file.getParentFile().isDirectory()||file.getParentFile().mkdirs());
        try(FileOutputStream out=new FileOutputStream(file)){out.write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));out.getFD().sync();}return file;
    }
}
