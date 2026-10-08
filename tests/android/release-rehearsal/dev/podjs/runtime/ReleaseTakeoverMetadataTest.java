package dev.podjs.runtime;

import android.app.Activity;
import android.content.*;
import android.content.pm.ApplicationInfo;
import android.database.sqlite.SQLiteDatabase;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import dev.podjs.takeover.NativeBackup;
import dev.podjs.takeover.TakeoverDigest;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Synthetic same-sandbox release rehearsal. Refuses every other package and existing source. */
@RunWith(AndroidJUnit4.class)
public final class ReleaseTakeoverMetadataTest {
    private static final String PACKAGE="com.lightningstudio.watchrss.podjs.rehearsal";
    private static void write(File file,byte[] bytes)throws Exception {
        Files.createDirectories(file.getParentFile().toPath());Files.write(file.toPath(),bytes);
    }
    private static void row(SQLiteDatabase db,JSONObject schema,String table)throws Exception {
        JSONArray columns=schema.getJSONObject("tables").getJSONArray(table);ContentValues values=new ContentValues();
        for(int i=0;i<columns.length();i++) {
            JSONObject column=columns.getJSONObject(i);String name=column.getString("name");
            if(column.getInt("notnull")==0&&column.getInt("pk")==0){values.putNull(name);continue;}
            if(column.getString("type").equals("TEXT"))values.put(name,"");else values.put(name,0);
        }
        values.put("id",1);values.put("title","T15 synthetic release fixture");
        if(table.equals("rss_channels")){values.put("url","https://example.invalid/t15-feed");values.put("createdAt",1);}
        else {
            values.put("channelId",1);values.put("link","https://example.invalid/t15-article");
            values.put("dedupKey","t15-synthetic");values.put("content","watchrss-watch-content:fixture.txt");
            values.put("syncChunkHashesJson","[]");values.put("isRead",1);values.put("readingProgress",0.5);
        }
        assertTrue(db.insertOrThrow(table,null,values)>0);
    }
    @Test public void nonDebuggablePausedTakeoverThenRealProfileInstaller()throws Exception {
        android.app.Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context context=registry.getTargetContext();
        assertEquals(PACKAGE,context.getPackageName());assertEquals(0,context.getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE);
        File sandbox=PodTakeover.sandbox(context),source=new File(sandbox,"databases/watchrss.db"),control=new File(sandbox,"files/package-takeover");
        assertFalse("requires clean rehearsal install",source.exists());assertFalse(control.exists());
        JSONObject schema=new JSONObject(PodRoomV18Converter.resource("room-v18.json"));
        Files.createDirectories(source.getParentFile().toPath());
        try(SQLiteDatabase db=SQLiteDatabase.openOrCreateDatabase(source,null)) {
            JSONArray sql=schema.getJSONArray("sql");
            for(int i=0;i<sql.length();i++) {
                String statement=sql.getString(i);
                if(statement.startsWith("CREATE TABLE IF NOT EXISTS `rss_items`")) {
                    List<String> appended=new ArrayList<>();
                    for(String name:new String[]{"isLiked","readingProgress","summary","previewImageUrl","originalContent"}) {
                        java.util.regex.Matcher matcher=java.util.regex.Pattern.compile("`"+name+"` [^,]+, ").matcher(statement);
                        assertTrue(matcher.find());String declaration=matcher.group();appended.add(declaration.substring(0,declaration.length()-2));statement=statement.replace(declaration,"");
                    }
                    db.execSQL(statement);for(String declaration:appended)db.execSQL("ALTER TABLE rss_items ADD COLUMN "+declaration+(declaration.contains("NOT NULL")?" DEFAULT 0":""));
                }else db.execSQL(statement);
            }
            db.execSQL("PRAGMA user_version=18");row(db,schema,"rss_channels");row(db,schema,"rss_items");
        }
        write(new File(sandbox,"shared_prefs/watch_device_identity.xml"),"<?xml version='1.0' encoding='utf-8' standalone='yes'?><map><string name=\"device_id\">t15-synthetic-device</string></map>".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] body="T15 synthetic body\n".repeat(4096).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        write(new File(sandbox,"files/article_content/fixture.txt"),body);
        File marker=new File(sandbox,"files/profileinstaller_profileWrittenFor_lastUpdateTime.dat");write(marker,new byte[8]);
        write(new File(sandbox,"files/profileInstalled"),new byte[24]);
        write(new File(sandbox,"no_backup/t15-native-synthetic.bin"),new byte[]{4,5,6});
        // Wait longer than the old initializer delay: no profile writer should have started.
        SystemClock.sleep(7000);assertArrayEquals(new byte[8],Files.readAllBytes(marker.toPath()));
        Properties pre=TakeoverDigest.snapshot(sandbox,Collections.emptyMap());
        for(String line:TakeoverDigest.digestManifest(pre,"SNAPSHOTTED","g-t15-fixture-pre"))android.util.Log.i("T15RehearsalPre",line);
        // Seed the exact legacy DETECTED/stage_failed journal shape and two retained partials.
        Properties journal=new Properties();journal.setProperty("protocol","1");
        journal.setProperty("converter","watchrss-room-v18-1+watchrss-stores-3+watchrss-files-3");
        journal.setProperty("phase","PAUSED");journal.setProperty("resumePhase","DETECTED");journal.setProperty("reason","stage_failed");journal.setProperty("generation","g-t15-v1001");
        for(String generation:new String[]{"g-t15-v1000","g-t15-v1001"})write(new File(control,"generations/"+generation+"/files-source/retained.part"),new byte[]{7,8,9});
        PodTakeoverCoordinator.atomic(new File(control,"journal"),journal);
        Activity activity=registry.startActivitySync(new Intent().setClassName(PACKAGE,"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            long deadline=SystemClock.uptimeMillis()+120000;
            while(!"ACTIVE".equals(PodTakeover.status(context).optString("phase"))&&SystemClock.uptimeMillis()<deadline)SystemClock.sleep(100);
            assertEquals("ACTIVE",PodTakeover.status(context).getString("phase"));assertTrue(PodTakeover.ready(context));
            Properties admitted=PodTakeoverCoordinator.read(new File(control,"journal"));String generation=admitted.getProperty("generation");
            assertNotEquals("g-t15-v1001",generation);
            for(String old:new String[]{"g-t15-v1000","g-t15-v1001"})assertArrayEquals(new byte[]{7,8,9},Files.readAllBytes(new File(control,"generations/"+old+"/files-source/retained.part").toPath()));
            List<String> before=TakeoverDigest.digestManifest(pre,"ACTIVE",generation),after=TakeoverDigest.activeLines(sandbox,generation);
            assertEquals("all synthetic native roots preserved in sealed backup",before,after);
            assertArrayEquals(body,Files.readAllBytes(new File(PodTakeover.filesRoot(context),"article_content/fixture.txt").toPath()));
            JSONObject files=PodStoreConverter.json(new File(control,"generations/"+generation+"/files-snapshot.json")).getJSONObject("entries");
            assertFalse(files.has("files/profileInstalled"));assertFalse(files.has("files/profileinstaller_profileWrittenFor_lastUpdateTime.dat"));
            try(SQLiteDatabase db=SQLiteDatabase.openDatabase(PodTakeover.database(context).getPath(),null,SQLiteDatabase.OPEN_READONLY)) {
                try(android.database.Cursor rows=db.rawQuery("SELECT title FROM articles",null)){assertTrue(rows.moveToFirst());assertEquals("T15 synthetic release fixture",rows.getString(0));}
            }
            long updated=context.getPackageManager().getPackageInfo(PACKAGE,0).lastUpdateTime;deadline=SystemClock.uptimeMillis()+20000;boolean installed=false;
            while(SystemClock.uptimeMillis()<deadline&&!installed) {
                if(marker.exists())try(DataInputStream input=new DataInputStream(new FileInputStream(marker))){installed=marker.length()==8&&input.readLong()==updated;}
                if(!installed)SystemClock.sleep(100);
            }
            assertTrue("actual ProfileInstaller successful write after ACTIVE",installed);
            assertArrayEquals(new byte[8],Files.readAllBytes(new File(sandbox,NativeBackup.BACKUP+"/"+generation+"/data/files/profileinstaller_profileWrittenFor_lastUpdateTime.dat").toPath()));
            assertEquals(after,TakeoverDigest.activeLines(sandbox,generation));
            android.util.Log.i("T15Rehearsal","release=true migratedRoom=true legacyPausedCandidates=2 retained=true phase=ACTIVE nativeRootsEqual=true platformImported=false profileInstallerWrite=true");
        }finally{registry.runOnMainSync(activity::finish);}
    }
}
