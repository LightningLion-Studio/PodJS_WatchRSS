package dev.podjs.runtime;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Synthetic Room producer contract, large enough to cross cursor batches. No network. */
public final class PodTakeoverMigrationTest {
    static final int ARTICLES=6006;
    static File sandbox()throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        if(InstrumentationRegistry.getArguments().getString("productionSandbox","").equals("true")) {
            assertEquals("com.lightningstudio.watchrss.podjs.rehearsal",context.getPackageName());
            return new File(context.getApplicationInfo().dataDir).getCanonicalFile();
        }
        return new File(context.getFilesDir(),"migration-rehearsal").getCanonicalFile();
    }
    static void write(File f,byte[] bytes)throws Exception {
        Files.createDirectories(f.getParentFile().toPath());Files.write(f.toPath(),bytes);
    }
    static byte[] bodyBytes()throws Exception{return "书籍正文 😀\n".repeat(10000).getBytes("UTF-8");}
    @Test public void writePostActiveEdit()throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.lightningstudio.watchrss.podjs.rehearsal",context.getPackageName());
        try(PodRoomV18Converter.Db db=new PodRoomAndroidDb(PodTakeover.database(context))){db.exec("UPDATE memo_notes SET title='post-active-edit' WHERE note_id='noteId-1'");}
    }
    @Test public void verifyPostActiveEdit()throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.lightningstudio.watchrss.podjs.rehearsal",context.getPackageName());
        try(PodRoomV18Converter.Db db=new PodRoomAndroidDb(PodTakeover.database(context))){
            assertEquals("post-active-edit",PodRoomV18Converter.scalar(db,"SELECT title FROM memo_notes WHERE note_id='noteId-1'"));
            assertEquals(ARTICLES,PodRoomV18Converter.number(PodRoomV18Converter.scalar(db,"SELECT count(*) FROM articles")));
        }
        Properties journal=PodTakeoverCoordinator.read(new File(sandbox(),"files/package-takeover/journal"));
        new dev.podjs.takeover.NativeBackup(sandbox()).verify(journal.getProperty("generation"));
    }
    static File recoveryRoot()throws IOException {
        return new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),"admission-recovery").getCanonicalFile();
    }
    @Test public void prepareKilledActiveWriter()throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root=recoveryRoot(),base=new File(root,"files/package-takeover"),g=new File(base,"generations/g-recovery");
        if(root.exists())try(java.util.stream.Stream<Path> paths=Files.walk(root.toPath())){for(Path p:(Iterable<Path>)paths.sorted(Comparator.reverseOrder())::iterator)Files.delete(p);}
        new File(g,"podjs/files").mkdirs();
        write(new File(g,"podjs/podjs-kv.json"),"{}".getBytes("UTF-8"));
        write(new File(g,"podjs/secure.store"),new PodStoreAndroidCrypto(context).seal(new org.json.JSONObject()));
        write(new File(g,"stores-snapshot.json"),"{\"version\":\"watchrss-stores-3-isolated\"}".getBytes("UTF-8"));
        Properties pointer=new Properties();pointer.setProperty("generation","g-recovery");pointer.setProperty("receipt","b".repeat(64));
        PodTakeoverCoordinator.atomic(new File(base,"active"),pointer);PodTakeoverCoordinator.atomic(new File(g,"activation-receipt"),pointer);
        Properties journal=new Properties();journal.putAll(pointer);journal.setProperty("protocol","1");journal.setProperty("phase","ACTIVE");PodTakeoverCoordinator.atomic(new File(base,"journal"),journal);
        try(PodRoomV18Converter.Db db=new PodRoomAndroidDb(new File(g,"podjs.sqlite"))) {
            org.json.JSONArray schema=new org.json.JSONArray(PodRoomV18Converter.resource("watchrss-schema.json"));
            for(int i=0;i<schema.length();i++)db.exec(schema.getString(i));
            db.exec("INSERT INTO sync_local_identity(id,device_id,device_order) VALUES(1,'recovery','recovery')");
            db.exec("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://recovery.invalid','recovery',1)");
            db.exec("BEGIN IMMEDIATE");
            for(int i=1;i<=128;i++)db.exec("INSERT INTO articles(id,channel_id,title,content,dedup_key,fetched_at) VALUES(?,1,?,?,?,1)",i,"committed-"+i,"c".repeat(16384),"row-"+i);
            db.exec("COMMIT");
            String mode=InstrumentationRegistry.getArguments().getString("journalMode","DELETE");
            assertTrue(mode.equals("DELETE")||mode.equals("WAL"));db.query("PRAGMA journal_mode="+mode);
            db.exec("PRAGMA cache_size=4");db.exec("PRAGMA cache_spill=ON");
            db.exec("BEGIN IMMEDIATE");db.exec("UPDATE articles SET title='uncommitted',content=replace(content,'c','u')");
            write(new File(root,"writer-ready"),new byte[]{1});Thread.sleep(120000);fail("external process kill was not injected");
        }
    }
    @Test public void activeColdAdmissionRecoversTheKilledWriter()throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();File root=recoveryRoot();
        java.lang.reflect.Method factory=PodTakeover.class.getDeclaredMethod("coordinator",Context.class,File.class);factory.setAccessible(true);
        PodTakeoverCoordinator c=(PodTakeoverCoordinator)factory.invoke(null,context,root);
        Properties p=c.run();assertEquals(p.toString(),"ACTIVE",p.getProperty("phase"));
        File g=c.activeGeneration(p);
        try(PodRoomV18Converter.Db db=new PodRoomAndroidDb(new File(g,"podjs.sqlite"))) {
            assertEquals(128,PodRoomV18Converter.number(PodRoomV18Converter.scalar(db,"SELECT count(*) FROM articles WHERE title='committed-'||id")));
            assertEquals(0,PodRoomV18Converter.number(PodRoomV18Converter.scalar(db,"SELECT count(*) FROM articles WHERE title='uncommitted'")));
            db.exec("UPDATE articles SET title='new-user-edit' WHERE id=1");
        }
        assertEquals("ACTIVE",c.run().getProperty("phase"));
        try(PodRoomV18Converter.Db db=new PodRoomAndroidDb(new File(g,"podjs.sqlite"))) {assertEquals("new-user-edit",PodRoomV18Converter.scalar(db,"SELECT title FROM articles WHERE id=1"));}
    }
    @Test public void migrate()throws Exception {
        File root=sandbox();String stop=InstrumentationRegistry.getArguments().getString("stopPhase","");
        String stopWork=InstrumentationRegistry.getArguments().getString("stopWork","");boolean[] heldWork={false};
        boolean production=InstrumentationRegistry.getArguments().getString("productionSandbox","").equals("true");
        PodTakeoverCoordinator.Converter converter=new PodTakeoverConverters(
            new PodRoomVersionsConverter(new File(root,"databases/watchrss.db"),PodRoomAndroidDb::new,g->PodStoreConverter.identity(new File(g,"stores-source")),bytes->{}),
            new PodStoreConverter(root,new PodStoreAndroidCrypto()),new PodFileConverter(root,PodRoomAndroidDb::new,(f,n)->{},b->{},bytes->{},"source.fixture","com.lightningstudio.watchrss.podjs.rehearsal"));
        PodTakeoverCoordinator coordinator;
        if(production) {
            // Invoke the exact host factory. Instrumentation wraps its private
            // checkpoint solely to hold a durable phase for an external exit.
            // No test hook is installed in the shipped host or guest API.
            java.lang.reflect.Method factory=PodTakeover.class.getDeclaredMethod("coordinator",Context.class,File.class);factory.setAccessible(true);
            coordinator=(PodTakeoverCoordinator)factory.invoke(null,InstrumentationRegistry.getInstrumentation().getTargetContext(),root);
            java.lang.reflect.Field field=PodTakeoverCoordinator.class.getDeclaredField("checkpoint");field.setAccessible(true);
            PodTakeoverCoordinator.Checkpoint original=(PodTakeoverCoordinator.Checkpoint)field.get(coordinator);
            field.set(coordinator,new PodTakeoverCoordinator.Checkpoint(){
                public void saved(PodTakeoverCoordinator.Phase phase){original.saved(phase);hold(root,stop,phase);}
                public void worked(String step,long done,long total){
                    original.worked(step,done,total);
                    if(step.equals(stopWork)&&done>=1024&&done<total&&!heldWork[0]) {
                        heldWork[0]=true;
                        try{write(new File(root,"work-checkpoint"),("done="+done+"\ntotal="+total+"\n").getBytes("US-ASCII"));}catch(Exception e){throw new RuntimeException(e);}
                        hold(root,"COPYING",PodTakeoverCoordinator.Phase.COPYING);
                    }
                }
                public void timed(String step,long nanos){original.timed(step,nanos);}
                public void published(){original.published();}
                public void failed(PodTakeoverCoordinator.Phase phase,Exception error){original.failed(phase,error);}
            });
        } else coordinator=new PodTakeoverCoordinator(new File(root,"files/package-takeover"),
            ()->PodTakeoverSource.detect(root,true),converter,new PodTakeoverCoordinator.Checkpoint(){
                public void saved(PodTakeoverCoordinator.Phase phase) {
                    android.util.Log.i("MigrationRehearsal","phase="+phase);
                    hold(root,stop,phase);
                }
                public void failed(PodTakeoverCoordinator.Phase phase,Exception error){PodTakeoverDiagnostics.warn(phase.name(),error);}
            });
        Properties p=coordinator.run();assertEquals(p.toString(),"ACTIVE",p.getProperty("phase"));
        File g=coordinator.activeGeneration(p);
        try(PodRoomV18Converter.Db db=new PodRoomAndroidDb(new File(g,"podjs.sqlite"))) {
            assertEquals(ARTICLES,PodRoomV18Converter.number(PodRoomV18Converter.scalar(db,"SELECT count(*) FROM articles")));
            assertEquals(400,PodRoomV18Converter.number(PodRoomV18Converter.scalar(db,"SELECT count(*) FROM memo_notes")));
            assertEquals(600,PodRoomV18Converter.number(PodRoomV18Converter.scalar(db,"SELECT count(*) FROM article_saved_states")));
        }
        assertArrayEquals(bodyBytes(),Files.readAllBytes(new File(g,"podjs/files/article_content/body.txt").toPath()));
        // A live Activity can start guest schema transactions as soon as the
        // production gate releases. Do not run a second cold gate over it.
        if(!production)assertEquals("ACTIVE",coordinator.run().getProperty("phase"));
        if(production&&InstrumentationRegistry.getArguments().getString("keepAlive","").equals("true")) {
            // Instrumentation.finish kills its target process. Let the external
            // controller inspect the returning Activity before it ends this UID.
            write(new File(root,"instrumentation-complete"),"phase=ACTIVE\n".getBytes("US-ASCII"));
            Thread.sleep(120000);fail("external controller did not stop completed instrumentation");
        }
    }
    static void hold(File root,String stop,PodTakeoverCoordinator.Phase phase) {
        if(!phase.name().equals(stop))return;
        try {
            File gate=new File(root,"stopped");write(gate,phase.name().getBytes("US-ASCII"));
            long until=android.os.SystemClock.uptimeMillis()+120000;
            while(gate.exists()&&android.os.SystemClock.uptimeMillis()<until)Thread.sleep(50);
            assertFalse("external controller did not release phase",gate.exists());
        }catch(Exception error){throw new RuntimeException(error);}
    }
}
