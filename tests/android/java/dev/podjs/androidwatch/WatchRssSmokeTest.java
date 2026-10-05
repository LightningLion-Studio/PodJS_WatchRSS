package dev.podjs.androidwatch;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.widget.Button;
import android.widget.EditText;
import android.view.TextureView;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import dev.podjs.runtime.PodRuntimeView;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.lang.reflect.Field;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Renderer-level smoke check for the externally packaged WatchRSS application. */
public final class WatchRssSmokeTest {
    private static final long TIMEOUT_MS = 20_000L;
    private static final String ISOLATED_ACCEPTANCE_PACKAGE = "com.lightningstudio.watchrss.podjs.acceptance";

    private static void assertIsolatedAcceptancePackage(Context target) {
        assertEquals("WatchRssSmokeTest must never target the formal package",
                ISOLATED_ACCEPTANCE_PACKAGE, target.getPackageName());
    }

    /** Scripted engine for controller/UI integration only. Never delegates synthesis to a real engine. */
    private static final class SilentSpeechEngine extends android.speech.tts.TextToSpeech {
        final java.util.List<String> utterances=new java.util.ArrayList<>();
        final java.util.List<Float> rates=new java.util.ArrayList<>();
        final java.util.List<String> ids=new java.util.ArrayList<>();
        volatile android.speech.tts.UtteranceProgressListener listener;
        volatile float rate=1;volatile int stops=0;
        SilentSpeechEngine(Context context){super(context,status->{});}
        @Override public int setLanguage(java.util.Locale locale){return SUCCESS;}
        @Override public int setSpeechRate(float value){rate=value;return SUCCESS;}
        @Override public synchronized int speak(CharSequence text,int mode,android.os.Bundle params,String id){utterances.add(text.toString());rates.add(rate);ids.add(id);return SUCCESS;}
        @Override public int setOnUtteranceProgressListener(android.speech.tts.UtteranceProgressListener value){listener=value;return SUCCESS;}
        void started(int index){listener.onStart(ids.get(index));}
        void range(int index,int start,int end){listener.onRangeStart(ids.get(index),start,end,0);}
        void done(int index){listener.onDone(ids.get(index));}
        @Override public int stop(){stops++;return SUCCESS;}
        synchronized int count(){return utterances.size();}
        synchronized String text(int index){return utterances.get(index);}
        synchronized float rateAt(int index){return rates.get(index);}
    }
    private static Object speechField(Object object,String name) throws Exception {Field field=object.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(object);}
    private static void speechField(Object object,String name,Object value) throws Exception {Field field=object.getClass().getDeclaredField(name);field.setAccessible(true);field.set(object,value);}
    private static void awaitUtterances(SilentSpeechEngine engine,int count) throws Exception {
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;while(engine.count()<count&&SystemClock.uptimeMillis()<deadline)SystemClock.sleep(50);
        assertEquals("scripted TTS utterance count",count,engine.count());SystemClock.sleep(350);
    }
    private static void awaitSpeechLabel(Instrumentation registry,TextureView texture,String label) throws Exception {
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;
        while(SystemClock.uptimeMillis()<deadline){org.json.JSONArray nodes=semanticNodes(registry,texture);for(int n=nodes.length()-1;n>=0;n--)if(nodes.getJSONObject(n).optString("label").contains(label))return;SystemClock.sleep(100);}
        throw new AssertionError("speech label missing: "+label+" "+semanticNodes(registry,texture));
    }
    private static void completeScriptedSpeech(Instrumentation registry,Object media,boolean error) {
        registry.runOnMainSync(()->{try{speechField(media,"ttsSpeaking",false);speechField(media,"activeUtterance",null);speechField(media,"ttsError",error?"scripted_tts_failure":null);}catch(Exception e){throw new AssertionError(e);}});
    }

    @Test public void speechPlaybackQueuePauseRateAndErrorThroughScriptedEngine() throws Exception { runSpeechPlayback(false,true); }
    @Test public void speechCrownVolumeGuardAndOverlayThroughRawInput() throws Exception { runSpeechPlayback(true,true); }
    @Test public void disabledSpeechCrownDoesNotAdjustVolume() throws Exception { runSpeechPlayback(true,false); }
    private void runSpeechPlayback(boolean crownTest,boolean volumeEnabled) throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject prior=readerKv(target);Object settingsBackup=prior.opt("watchrss.settings"),presetBackup=prior.opt("watchrss.reader-presets");prior.put("watchrss.settings",new org.json.JSONObject().put("fontSizeSp",14).put("mediaVolumeControl",volumeEnabled).put("mediaVolumeGuard",crownTest).put("playbackStartVolumeLimit",10).put("cacheLimitMb",512).put("mediaCacheMode","前 4 项").put("syncMediaKeepAlive",false).put("shareUseSystem",false));prior.remove("watchrss.reader-presets");writeReaderKv(target,prior);
        Activity activity=null;long channelId=0,firstId=0,secondId=0;String marker="codex-speech-"+SystemClock.uptimeMillis();
        try {
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)) {
                database.execSQL("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)",new Object[]{"https://example.test/"+marker,"朗读验证",System.currentTimeMillis()});try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://example.test/"+marker})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                for(int index=0;index<2;index++){
                    database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,?)",new Object[]{channelId,index==0?"朗读验证第一篇":"朗读验证第二篇","正文","<p>朗读验证正文。</p>","https://example.test/"+marker+"/"+index,marker+"-"+index,System.currentTimeMillis()+100-index*1000,index==0?1:0});
                    try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{marker+"-"+index})){assertTrue(c.moveToFirst());if(index==0)firstId=c.getLong(0);else secondId=c.getLong(0);}
                }
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000005)",new Object[]{firstId,System.currentTimeMillis()});
            }
            final Object media=speechField(speechField(texture,"services"),"media");final SilentSpeechEngine[] scripted=new SilentSpeechEngine[1];
            registry.runOnMainSync(()->{try{scripted[0]=new SilentSpeechEngine(target);speechField(media,"tts",scripted[0]);speechField(media,"ttsInitialized",true);}catch(Exception e){throw new AssertionError(e);}});
            // The production JS service bridge writes only to this isolated stream adapter.
            java.util.concurrent.atomic.AtomicInteger volumeIndex=new java.util.concurrent.atomic.AtomicInteger(12),volumeWrites=new java.util.concurrent.atomic.AtomicInteger();
            Class<?> volumeType=Class.forName("dev.podjs.runtime.PodMediaServices$VolumeAccess");
            Object isolatedVolume=java.lang.reflect.Proxy.newProxyInstance(volumeType.getClassLoader(),new Class<?>[]{volumeType},(proxy,method,args)->{
                switch(method.getName()) {
                    case "min":return 0;case "max":return 15;case "current":return volumeIndex.get();case "fixed":return false;
                    case "set":volumeWrites.incrementAndGet();volumeIndex.set((Integer)args[0]);return null;
                    default:throw new UnsupportedOperationException(method.getName());
                }
            });
            registry.runOnMainSync(()->{try{speechField(media,"volumeAccess",isolatedVolume);}catch(Exception e){throw new AssertionError(e);}});
            SilentSpeechEngine engine=scripted[0];
            openFirstSavedReader(registry,activity,texture,target,false);SystemClock.sleep(500);
            tapExactPresetLabel(registry,activity,texture,"大声朗读");awaitUtterances(engine,1);assertEquals("朗读验证第一篇。",engine.text(0));assertEquals(1,volumeWrites.get());assertEquals(2,volumeIndex.get());
            assertFalse("button should stay in article",semanticNodes(registry,texture).toString().contains("朗读播控"));
            long down=SystemClock.uptimeMillis();dispatch(registry,activity,down,MotionEvent.ACTION_DOWN,233,280);SystemClock.sleep(850);dispatch(registry,activity,down,MotionEvent.ACTION_UP,233,280);awaitSpeechLabel(registry,texture,"朗读播控");SystemClock.sleep(500);saveRssStage(registry,texture,target,"speech-playing");assertEquals(1,engine.count());
            if(crownTest) {
                volumeIndex.set(0);
                dispatchRawScroll(registry,activity,-400,android.view.InputDevice.SOURCE_MOUSE,MotionEvent.AXIS_VSCROLL);
                dispatchRotary(registry,activity,-400);
                if(!volumeEnabled) {
                    SystemClock.sleep(500);assertEquals(1,volumeWrites.get());assertEquals(0,volumeIndex.get());
                    assertFalse(semanticNodes(registry,texture).toString().contains("：21%"));return;
                }
                awaitSpeechLabel(registry,texture,"：21%");assertEquals(3,volumeIndex.get());assertEquals(2,volumeWrites.get());
                saveRssStage(registry,texture,target,"speech-volume-guarded");
                SystemClock.sleep(1400);assertFalse("overlay did not hide",semanticNodes(registry,texture).toString().contains("：21%"));
                dispatchRotary(registry,activity,-400);awaitSpeechLabel(registry,texture,"：45%");assertEquals(7,volumeIndex.get());
                dispatchRotary(registry,activity,1000);awaitSpeechLabel(registry,texture,"：0%");assertEquals(0,volumeIndex.get());
                dispatchRawScroll(registry,activity,-400,android.view.InputDevice.SOURCE_MOUSE,MotionEvent.AXIS_VSCROLL);
                awaitSpeechLabel(registry,texture,"：21%");assertEquals(3,volumeIndex.get());
                tap(registry,activity,233,410);awaitSpeechLabel(registry,texture,"大声朗读");
                int before=volumeWrites.get();dispatchRotary(registry,activity,-400);SystemClock.sleep(400);assertEquals(before,volumeWrites.get());
                org.json.JSONObject report=new org.json.JSONObject().put("adapter","isolated volume indices; production Android MotionEvent -> raw host event -> JS controller -> host write")
                    .put("realSystemVolumeWritten",false).put("mouseAndRotarySourceVerified",true).put("guardPercent",21).put("idlePercent",45).put("reversePercent",0).put("volumeWrites",volumeWrites.get()).put("hiddenAfterMs",1400).put("inactivePageWrites",0);
                try(FileOutputStream out=new FileOutputStream(new File(target.getFilesDir(),"watchrss-speech-volume-scripted.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
                return;
            }
            tap(registry,activity,188,228);awaitSpeechLabel(registry,texture,"已暂停");SystemClock.sleep(300);saveRssStage(registry,texture,target,"speech-paused");
            tap(registry,activity,398,340);awaitSpeechLabel(registry,texture,"1.15x");tap(registry,activity,116,340);SystemClock.sleep(350);saveRssStage(registry,texture,target,"speech-auto-off");assertEquals(1,engine.count());
            volumeIndex.set(12); // A user volume increase survives pause/resume and article navigation.
            tap(registry,activity,188,228);awaitUtterances(engine,2);assertEquals(engine.text(0),engine.text(1));assertEquals(1.15f,engine.rateAt(1),.001f);
            tap(registry,activity,294,228);awaitUtterances(engine,3);assertEquals("朗读验证第二篇。",engine.text(2));
            tap(registry,activity,83,228);awaitUtterances(engine,4);assertEquals("朗读验证第一篇。",engine.text(3));assertEquals(1,volumeWrites.get());assertEquals(12,volumeIndex.get());
            completeScriptedSpeech(registry,media,false);awaitUtterances(engine,5);assertEquals("朗读验证正文。",engine.text(4));
            completeScriptedSpeech(registry,media,false);awaitSpeechLabel(registry,texture,"已暂停");SystemClock.sleep(400);assertEquals(5,engine.count());
            tap(registry,activity,294,228);awaitUtterances(engine,6);tap(registry,activity,116,340);
            completeScriptedSpeech(registry,media,false);awaitUtterances(engine,7);completeScriptedSpeech(registry,media,false);awaitSpeechLabel(registry,texture,"尚未开始朗读");saveRssStage(registry,texture,target,"speech-finished");
            tap(registry,activity,383,228);SystemClock.sleep(400);awaitSpeechLabel(registry,texture,"大声朗读");
            // Header is still visible: a body long press must start in the body, not the title.
            org.json.JSONObject bodyBounds=null;org.json.JSONArray readerNodes=semanticNodes(registry,texture);
            for(int i=0;i<readerNodes.length();i++){org.json.JSONObject node=readerNodes.getJSONObject(i);if(node.optString("label").equals("朗读验证正文。"))bodyBounds=node.getJSONObject("bounds");}
            assertNotNull("body text layout",bodyBounds);
            int bodyX=(bodyBounds.getInt("left")+1)*2,bodyY=bodyBounds.getInt("top")+bodyBounds.getInt("bottom");
            saveRssStage(registry,texture,target,"speech-anchor-before");
            down=SystemClock.uptimeMillis();dispatch(registry,activity,down,MotionEvent.ACTION_DOWN,bodyX,bodyY);SystemClock.sleep(850);dispatch(registry,activity,down,MotionEvent.ACTION_UP,bodyX,bodyY);awaitUtterances(engine,8);awaitSpeechLabel(registry,texture,"朗读播控");assertEquals("朗读验证正文。",engine.text(7));assertEquals(2,volumeWrites.get());assertEquals(2,volumeIndex.get());volumeIndex.set(11);
            completeScriptedSpeech(registry,media,true);awaitSpeechLabel(registry,texture,"播放异常");SystemClock.sleep(400);saveRssStage(registry,texture,target,"speech-error");
            // Error text adds two lines above the controls.
            tap(registry,activity,188,302);awaitUtterances(engine,9);assertEquals("朗读验证正文。",engine.text(8));assertEquals(2,volumeWrites.get());assertEquals(11,volumeIndex.get());
            tap(registry,activity,383,228);SystemClock.sleep(500);awaitSpeechLabel(registry,texture,"大声朗读");assertTrue("native stop was not reached",engine.stops>=6);
            org.json.JSONObject report=new org.json.JSONObject().put("speechAdapter","scripted TextToSpeech subclass; completion/error fields controlled by instrumentation").put("realAudioVerified",false).put("volumeAdapter","isolated stream indices behind production JS bridge; real system volume not written").put("startLimitPercent",10).put("volumeWrites",volumeWrites.get()).put("finalIsolatedVolumeIndex",volumeIndex.get()).put("bodyPressX",bodyX).put("bodyPressY",bodyY).put("bodyBounds",bodyBounds).put("utterances",new org.json.JSONArray(engine.utterances)).put("rates",new org.json.JSONArray(engine.rates)).put("stops",engine.stops);
            try(FileOutputStream out=new FileOutputStream(new File(target.getFilesDir(),"watchrss-speech-scripted.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
        } finally {
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(600);}
            org.json.JSONObject latest=readerKv(target);if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);if(presetBackup==null)latest.remove("watchrss.reader-presets");else latest.put("watchrss.reader-presets",presetBackup);if(firstId>0)latest.remove("watchrss.reader.progress."+firstId);if(secondId>0)latest.remove("watchrss.reader.progress."+secondId);writeReaderKv(target,latest);
            if(channelId>0)try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){database.execSQL("DELETE FROM article_saved_states WHERE article_id IN (SELECT id FROM articles WHERE channel_id=?)",new Object[]{channelId});database.execSQL("DELETE FROM articles WHERE channel_id=?",new Object[]{channelId});database.execSQL("DELETE FROM channels WHERE id=?",new Object[]{channelId});}
        }
    }


    private static org.json.JSONObject speechHighlightBounds(Instrumentation registry,TextureView texture) throws Exception {
        Bitmap bitmap=getBitmap(registry,texture);int left=bitmap.getWidth(),top=bitmap.getHeight(),right=-1,bottom=-1,pixels=0;
        try {for(int y=0;y<bitmap.getHeight();y++)for(int x=0;x<bitmap.getWidth();x++){
            int color=bitmap.getPixel(x,y),red=(color>>16)&255,green=(color>>8)&255,blue=color&255;
            // Default dark preset: #ff5a36 at 34% alpha on the black reader.
            if(Math.abs(red-87)<=2&&Math.abs(green-31)<=2&&Math.abs(blue-18)<=2){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);pixels++;}
        }}finally{bitmap.recycle();}
        return new org.json.JSONObject().put("left",left).put("right",right).put("top",top).put("bottom",bottom).put("pixels",pixels);
    }
    private static double highlightY(org.json.JSONObject bounds) throws Exception {return (bounds.getInt("top")+bounds.getInt("bottom"))/2.0;}

    @Test public void speechRangesHighlightAndFollowReaderWithManualGrace() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject prior=readerKv(target);Object settingsBackup=prior.opt("watchrss.settings"),presetBackup=prior.opt("watchrss.reader-presets");prior.remove("watchrss.settings");prior.remove("watchrss.reader-presets");writeReaderKv(target,prior);
        Activity activity=null;long channelId=0,articleId=0;String marker="codex-highlight-"+SystemClock.uptimeMillis();
        try {
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            StringBuilder content=new StringBuilder("<p>");for(int n=0;n<40;n++)content.append("第").append(n).append("句正文甲乙丙丁戊己庚辛壬癸。");content.append("</p>");
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)) {
                database.execSQL("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)",new Object[]{"https://example.test/"+marker,"高亮验证",System.currentTimeMillis()});try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://example.test/"+marker})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,?)",new Object[]{channelId,"朗读高亮验证标题","正文",content.toString(),"https://example.test/"+marker,marker,System.currentTimeMillis(),1});
                try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{marker})){assertTrue(c.moveToFirst());articleId=c.getLong(0);}
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000006)",new Object[]{articleId,System.currentTimeMillis()});
            }
            final Object media=speechField(speechField(texture,"services"),"media");final SilentSpeechEngine[] scripted=new SilentSpeechEngine[1];
            registry.runOnMainSync(()->{try{scripted[0]=new SilentSpeechEngine(target);speechField(media,"tts",scripted[0]);speechField(media,"ttsInitialized",true);}catch(Exception e){throw new AssertionError(e);}});
            SilentSpeechEngine engine=scripted[0];openFirstSavedReader(registry,activity,texture,target,false);SystemClock.sleep(500);
            // Production Compose oracle: 205 dp, 14 sp, Paragraph mode, first source line ends at UTF-16 14.
            boolean paragraphMatched=false;long layoutDeadline=SystemClock.uptimeMillis()+5000;
            while(SystemClock.uptimeMillis()<layoutDeadline&&!paragraphMatched){org.json.JSONArray nodes=semanticNodes(registry,texture);for(int n=0;n<nodes.length();n++)if(nodes.getJSONObject(n).optString("label").equals("第0句正文甲乙丙丁戊己庚辛壬"))paragraphMatched=true;if(!paragraphMatched)SystemClock.sleep(100);}
            assertTrue("rendered reader did not adopt native paragraph line break: "+semanticNodes(registry,texture),paragraphMatched);

            tapExactPresetLabel(registry,activity,texture,"大声朗读");awaitUtterances(engine,1);engine.started(0);engine.range(0,2,5);SystemClock.sleep(500);
            saveRssStage(registry,texture,target,"highlight-title");org.json.JSONObject title=speechHighlightBounds(registry,texture);assertTrue("title highlight absent: "+title,title.getInt("pixels")>30);
            engine.done(0);awaitUtterances(engine,2);assertTrue(engine.text(1).length()>156);
            org.json.JSONObject fallbackInitial=speechHighlightBounds(registry,texture);saveRssStage(registry,texture,target,"highlight-fallback-initial");
            engine.started(1);SystemClock.sleep(1150);org.json.JSONObject fallbackAdvanced=speechHighlightBounds(registry,texture);saveRssStage(registry,texture,target,"highlight-fallback-advanced");
            assertTrue("estimated highlight did not advance without ranges: "+fallbackInitial+" -> "+fallbackAdvanced,fallbackInitial.getInt("pixels")>30&&fallbackAdvanced.getInt("pixels")>30&&Math.abs(fallbackAdvanced.getInt("left")-fallbackInitial.getInt("left"))>5);
            engine.range(1,150,156);SystemClock.sleep(3800);
            saveRssStage(registry,texture,target,"highlight-centered");org.json.JSONObject centered=speechHighlightBounds(registry,texture);assertTrue("body highlight absent: "+centered,centered.getInt("pixels")>30);assertTrue("range not centered: "+centered,Math.abs(highlightY(centered)-233)<35);
            int topInk=0;Bitmap centeredFrame=getBitmap(registry,texture);
            try {for(int y=0;y<20;y++)for(int x=28;x<438;x++){int color=centeredFrame.getPixel(x,y);if(((color>>16)&255)>180&&((color>>8)&255)>180&&(color&255)>180)topInk++;}}
            finally {centeredFrame.recycle();}
            assertTrue("partially visible top line disappeared during follow: "+topInk,topInk>50);
            engine.range(0,0,1);SystemClock.sleep(500);assertEquals("stale title range changed body",centered.toString(),speechHighlightBounds(registry,texture).toString());
            swipe(registry,activity,233,350,233,230,false);SystemClock.sleep(700);org.json.JSONObject manual=speechHighlightBounds(registry,texture);saveRssStage(registry,texture,target,"highlight-manual-grace");
            assertTrue("follow overrode manual scroll before grace: "+manual,manual.getInt("pixels")==0||Math.abs(highlightY(manual)-233)>35);
            SystemClock.sleep(3100);org.json.JSONObject resumed=speechHighlightBounds(registry,texture);saveRssStage(registry,texture,target,"highlight-follow-resumed");assertTrue("follow failed to resume: "+resumed,resumed.getInt("pixels")>30&&Math.abs(highlightY(resumed)-233)<35);
            long down=SystemClock.uptimeMillis();dispatch(registry,activity,down,MotionEvent.ACTION_DOWN,233,280);SystemClock.sleep(850);dispatch(registry,activity,down,MotionEvent.ACTION_UP,233,280);awaitSpeechLabel(registry,texture,"朗读播控");tap(registry,activity,188,228);awaitSpeechLabel(registry,texture,"已暂停");
            engine.range(1,0,1);tap(registry,activity,233,431);SystemClock.sleep(800);saveRssStage(registry,texture,target,"highlight-paused");org.json.JSONObject paused=speechHighlightBounds(registry,texture);assertTrue("pause lost highlight",paused.getInt("pixels")>30);
            org.json.JSONObject report=new org.json.JSONObject().put("realAudioVerified",false).put("callbackPath","scripted engine invokes production UtteranceProgressListener -> speech.progress -> ReaderSpeech -> SpeechPlayback -> rendered rectangles")
                .put("topVisibleTextPixels",topInk).put("fallbackInitial",fallbackInitial).put("fallbackAdvanced",fallbackAdvanced).put("rangeStart",150).put("rangeEnd",156).put("segmentText",engine.text(1)).put("title",title).put("centered",centered).put("manualWithinGrace",manual).put("resumed",resumed).put("paused",paused).put("utterances",engine.count());
            try(FileOutputStream out=new FileOutputStream(new File(target.getFilesDir(),"watchrss-highlight-scripted.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
        } finally {
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(600);}
            org.json.JSONObject latest=readerKv(target);if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);if(presetBackup==null)latest.remove("watchrss.reader-presets");else latest.put("watchrss.reader-presets",presetBackup);if(articleId>0)latest.remove("watchrss.reader.progress."+articleId);writeReaderKv(target,latest);
            if(channelId>0)try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){database.execSQL("DELETE FROM article_saved_states WHERE article_id IN (SELECT id FROM articles WHERE channel_id=?)",new Object[]{channelId});database.execSQL("DELETE FROM articles WHERE channel_id=?",new Object[]{channelId});database.execSQL("DELETE FROM channels WHERE id=?",new Object[]{channelId});}
        }
    }

    @Test public void importedTextStreamsAcrossUtf8BoundaryThroughScriptedEngine() throws Exception { runImportedSpeech(false); }
    @Test public void importedTextLongPressStartsAtTouchedChunk() throws Exception { runImportedSpeech(true); }
    @Test public void importedTextRendersComposedColorEmoji() throws Exception { runImportedSpeech(false,true); }
    private void runImportedSpeech(boolean fromBody) throws Exception { runImportedSpeech(fromBody,false); }
    private void runImportedSpeech(boolean fromBody,boolean composed) throws Exception {
        final String sourceText=composed?"汉😀导入正文。 👩‍💻 🇨🇳 👍🏽":"汉😀导入正文。";
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject prior=readerKv(target);Object settingsBackup=prior.opt("watchrss.settings"),presetBackup=prior.opt("watchrss.reader-presets");prior.remove("watchrss.settings");prior.remove("watchrss.reader-presets");writeReaderKv(target,prior);
        String key="codex-imported-"+SystemClock.uptimeMillis();File file=new File(target.getFilesDir(),"podjs/files/article_content/"+key+".txt");
        Activity activity=null;long channelId=0,articleId=0;
        try {
            assertTrue(file.getParentFile().isDirectory()||file.getParentFile().mkdirs());
            StringBuilder content=new StringBuilder();for(int i=0;i<16383;i++)content.append(' ');content.append(sourceText);
            try(FileOutputStream out=new FileOutputStream(file)){out.write(content.toString().getBytes(StandardCharsets.UTF_8));}
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)) {
                database.execSQL("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)",new Object[]{"https://watchrss.local/import-content/"+key,"导入朗读验证",System.currentTimeMillis()});try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://watchrss.local/import-content/"+key})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,?)",new Object[]{channelId,"导入朗读标题","导入正文","watchrss-watch-content:"+key+".txt","https://watchrss.local/import-content/txt/"+key,key,System.currentTimeMillis(),1});
                try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{key})){assertTrue(c.moveToFirst());articleId=c.getLong(0);}
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000008)",new Object[]{articleId,System.currentTimeMillis()});
            }
            final Object media=speechField(speechField(texture,"services"),"media");final SilentSpeechEngine[] scripted=new SilentSpeechEngine[1];
            Class<?> volumeType=Class.forName("dev.podjs.runtime.PodMediaServices$VolumeAccess");
            Object isolatedVolume=java.lang.reflect.Proxy.newProxyInstance(volumeType.getClassLoader(),new Class<?>[]{volumeType},(proxy,method,args)->{switch(method.getName()){case "min":return 0;case "max":return 15;case "current":return 5;case "fixed":return false;case "set":return null;default:throw new UnsupportedOperationException(method.getName());}});
            registry.runOnMainSync(()->{try{scripted[0]=new SilentSpeechEngine(target);speechField(media,"tts",scripted[0]);speechField(media,"ttsInitialized",true);speechField(media,"volumeAccess",isolatedVolume);}catch(Exception e){throw new AssertionError(e);}});
            SilentSpeechEngine engine=scripted[0];openFirstSavedReader(registry,activity,texture,target,false);SystemClock.sleep(500);
            awaitSpeechLabel(registry,texture,"汉😀导入正文。");
            SystemClock.sleep(700);Bitmap emojiFrame=getBitmap(registry,texture);int emojiColors=0;try{assertNotNull(emojiFrame);for(int y=180;y<310;y++)for(int x=25;x<440;x++){int pixel=emojiFrame.getPixel(x,y),r=(pixel>>>16)&255,g=(pixel>>>8)&255,b=pixel&255;if(r>180&&g>130&&b<130)emojiColors++;}saveBitmap(emojiFrame,new File(target.getFilesDir(),composed?"watchrss-emoji-composed.png":fromBody?"watchrss-emoji-touch.png":"watchrss-emoji-simple.png"));}finally{if(emojiFrame!=null)emojiFrame.recycle();}assertTrue("system emoji pixels absent: "+emojiColors,emojiColors>20);
            org.json.JSONArray readerNodes=semanticNodes(registry,texture);assertFalse("file marker leaked into reader",readerNodes.toString().contains("watchrss-watch-content:"));
            float touchX=233,touchY=80;
            if(fromBody){boolean found=false;for(int i=0;i<readerNodes.length();i++){org.json.JSONObject node=readerNodes.getJSONObject(i);if(node.optString("label").equals("汉😀导入正文。")){org.json.JSONObject bounds=node.getJSONObject("bounds");touchX=(float)((bounds.getDouble("left")+1)*2);touchY=(float)(bounds.getDouble("top")+bounds.getDouble("bottom"));found=true;break;}}assertTrue("body coordinates unavailable",found);}
            long down=SystemClock.uptimeMillis();dispatch(registry,activity,down,MotionEvent.ACTION_DOWN,touchX,touchY);SystemClock.sleep(850);dispatch(registry,activity,down,MotionEvent.ACTION_UP,touchX,touchY);awaitSpeechLabel(registry,texture,"朗读播控");
            awaitUtterances(engine,1);
            if(!fromBody){assertEquals("导入朗读标题。",engine.text(0));engine.started(0);engine.done(0);awaitUtterances(engine,2);}
            int bodyIndex=fromBody?0:1;assertEquals(sourceText,engine.text(bodyIndex));engine.started(bodyIndex);
            awaitSpeechLabel(registry,texture,fromBody?"第 1 段":"第 2 段");
            saveRssStage(registry,texture,target,fromBody?"imported-speech-touch":"imported-speech");
            engine.range(bodyIndex,0,5);tap(registry,activity,233,426);SystemClock.sleep(1000);
            org.json.JSONObject importedHighlight=speechHighlightBounds(registry,texture);assertTrue("imported body highlight absent: "+importedHighlight,importedHighlight.getInt("pixels")>30);saveRssStage(registry,texture,target,fromBody?"imported-touch-highlight":"imported-highlight");
            org.json.JSONObject report=new org.json.JSONObject().put("composed",composed).put("emojiColorPixels",emojiColors).put("highlight",importedHighlight).put("realAudioVerified",false).put("fileBytes",file.length()).put("chunkBytes",16384).put("fromBody",fromBody).put("first",engine.text(0)).put("body",engine.text(bodyIndex)).put("reader",readerNodes).put("status",semanticNodes(registry,texture));
            try(FileOutputStream out=new FileOutputStream(new File(target.getFilesDir(),composed?"watchrss-emoji-composed.json":fromBody?"watchrss-imported-speech-touch-scripted.json":"watchrss-imported-speech-scripted.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
        } finally {
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(600);}
            org.json.JSONObject latest=readerKv(target);if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);if(presetBackup==null)latest.remove("watchrss.reader-presets");else latest.put("watchrss.reader-presets",presetBackup);if(articleId>0)latest.remove("watchrss.reader.progress."+articleId);writeReaderKv(target,latest);
            if(channelId>0)try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){database.execSQL("DELETE FROM article_saved_states WHERE article_id IN (SELECT id FROM articles WHERE channel_id=?)",new Object[]{channelId});database.execSQL("DELETE FROM articles WHERE channel_id=?",new Object[]{channelId});database.execSQL("DELETE FROM channels WHERE id=?",new Object[]{channelId});}
            if(file.exists())assertTrue(file.delete());
        }
    }

    @Test public void importedTextRestoresMiddleChunkAcrossReopen() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject originalKv=readerKv(target);Object settingsBackup=originalKv.opt("watchrss.settings"),presetBackup=originalKv.opt("watchrss.reader-presets");originalKv.remove("watchrss.settings");originalKv.remove("watchrss.reader-presets");writeReaderKv(target,originalKv);
        String key="codex-imported-position-"+SystemClock.uptimeMillis();File file=new File(target.getFilesDir(),"podjs/files/article_content/"+key+".txt");
        Activity activity=null;long articleId=0,channelId=0;Bitmap before=null,after=null;
        try {
            assertTrue(file.getParentFile().isDirectory()||file.getParentFile().mkdirs());
            try(FileOutputStream out=new FileOutputStream(file)){
                for(int chunk=0;chunk<4;chunk++){
                    StringBuilder content=new StringBuilder();for(int line=0;line<300;line++)content.append("块").append(chunk).append("行").append(line).append("正文甲乙丙丁。\n");
                    byte[] bytes=content.toString().getBytes(StandardCharsets.UTF_8);assertTrue(bytes.length<16384);out.write(bytes);for(int remaining=16384-bytes.length;remaining>0;remaining--)out.write('x');
                }
            }
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)) {
                database.execSQL("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)",new Object[]{"https://watchrss.local/import-content/"+key,"导入位置验证",System.currentTimeMillis()});try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://watchrss.local/import-content/"+key})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,1)",new Object[]{channelId,"导入位置恢复","正文","watchrss-watch-content:"+key+".txt","https://watchrss.local/import-content/txt/"+key,key,System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{key})){assertTrue(c.moveToFirst());articleId=c.getLong(0);}
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000009)",new Object[]{articleId,System.currentTimeMillis()});
            }
            Activity initial=activity;registry.runOnMainSync(initial::finish);SystemClock.sleep(600);
            org.json.JSONObject seeded=readerKv(target);seeded.put("watchrss.reader.progress."+articleId,new org.json.JSONObject().put("offset",0).put("progress",.6).put("updatedAt",System.currentTimeMillis()).toString());writeReaderKv(target,seeded);
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));texture=awaitTextureView(activity);awaitHomeBitmap(registry,texture);openFirstSavedReader(registry,activity,texture,target,false);
            awaitSpeechLabel(registry,texture,"块2行");SystemClock.sleep(800);dispatchRotary(registry,activity,1);SystemClock.sleep(1600);
            org.json.JSONObject saved=new org.json.JSONObject(readerKv(target).getString("watchrss.reader.progress."+articleId));org.json.JSONObject anchor=saved.getJSONObject("importedAnchor");assertEquals(2,anchor.getInt("chunkIndex"));assertTrue(anchor.getInt("charOffset")>0);assertTrue(saved.getDouble("progress")>.5&&saved.getDouble("progress")<.75);
            before=getBitmap(registry,texture);assertNotNull(before);saveBitmap(before,new File(target.getFilesDir(),"watchrss-imported-position-before.png"));
            Activity first=activity;registry.runOnMainSync(first::finish);SystemClock.sleep(600);
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));texture=awaitTextureView(activity);awaitHomeBitmap(registry,texture);openFirstSavedReader(registry,activity,texture,target,false);awaitSpeechLabel(registry,texture,"块2行");SystemClock.sleep(1000);
            after=getBitmap(registry,texture);assertNotNull(after);saveBitmap(after,new File(target.getFilesDir(),"watchrss-imported-position-after.png"));assertTrue("imported reading position changed on reopen",bitmapsEqual(before,after));
            org.json.JSONObject report=new org.json.JSONObject().put("byteLength",file.length()).put("seedProgress",.6).put("saved",saved).put("reopenedPixelsEqual",true).put("physicalInputVerified",false);
            try(FileOutputStream out=new FileOutputStream(new File(target.getFilesDir(),"watchrss-imported-position.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
        } finally {
            if(before!=null)before.recycle();if(after!=null)after.recycle();if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(600);}
            org.json.JSONObject latest=readerKv(target);if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);if(presetBackup==null)latest.remove("watchrss.reader-presets");else latest.put("watchrss.reader-presets",presetBackup);if(articleId>0)latest.remove("watchrss.reader.progress."+articleId);writeReaderKv(target,latest);
            if(channelId>0)try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){database.execSQL("DELETE FROM article_saved_states WHERE article_id IN (SELECT id FROM articles WHERE channel_id=?)",new Object[]{channelId});database.execSQL("DELETE FROM articles WHERE channel_id=?",new Object[]{channelId});database.execSQL("DELETE FROM channels WHERE id=?",new Object[]{channelId});}
            if(file.exists())assertTrue(file.delete());
        }
    }

    @Test public void launchesRendersAndInitializesChannelsDatabase() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);

        Intent intent = new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = registry.startActivitySync(intent);
        try {
            TextureView texture = awaitTextureView(activity);
            assertNotNull(texture);
            assertTrue("TextureView never became available", texture.isAvailable());
            awaitChannelsTable(target);
            // Allow final host completions and the demand-rendered empty state to reach the texture.
            SystemClock.sleep(750L);

            final Bitmap[] capture = new Bitmap[1];
            registry.runOnMainSync(() -> capture[0] = texture.getBitmap());
            assertNotNull("renderer returned no bitmap", capture[0]);
            Bitmap bitmap = capture[0];
            File output = new File(target.getFilesDir(), "watchrss-render.png");
            try (FileOutputStream stream = new FileOutputStream(output)) {
                assertTrue("render capture could not be encoded", bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream));
            } finally {
                int nonBlack = 0;
                for (int y = 0; y < bitmap.getHeight(); y += 4) {
                    for (int x = 0; x < bitmap.getWidth(); x += 4) {
                        if ((bitmap.getPixel(x, y) & 0x00ffffff) != 0) nonBlack++;
                    }
                }
                bitmap.recycle();
                assertTrue("renderer produced an all-black frame", nonBlack > 0);
            }
            assertTrue("render capture missing", output.isFile() && output.length() > 0);
            // Send through the app window to test hit routing while the system charging
            // overlay blocks ADB input; this is not physical touch acceptance.
            registry.runOnMainSync(() -> {
                long now = SystemClock.uptimeMillis();
                MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, 233, 90, 0);
                activity.dispatchTouchEvent(down); down.recycle();
            });
            SystemClock.sleep(100L);
            registry.runOnMainSync(() -> {
                long now = SystemClock.uptimeMillis();
                MotionEvent up = MotionEvent.obtain(now - 100, now, MotionEvent.ACTION_UP, 233, 90, 0);
                activity.dispatchTouchEvent(up); up.recycle();
            });
            SystemClock.sleep(750L);
            registry.runOnMainSync(() -> capture[0] = texture.getBitmap());
            assertNotNull("profile capture missing", capture[0]);
            assertEquals("profile entry did not navigate to the pill menu", 0x2a2a2a,
                    capture[0].getPixel(233, 170) & 0xffffff);
            try (FileOutputStream stream = new FileOutputStream(new File(target.getFilesDir(), "watchrss-profile.png"))) {
                assertTrue(capture[0].compress(Bitmap.CompressFormat.PNG, 100, stream));
            } finally { capture[0].recycle(); }
            registry.runOnMainSync(activity::onBackPressed);
            SystemClock.sleep(500L);
            registry.runOnMainSync(() -> capture[0] = texture.getBitmap());
            assertNotNull(capture[0]);
            try {
                assertEquals("back did not restore the home route", 0,
                        capture[0].getPixel(233, 170) & 0xffffff);
            } finally { capture[0].recycle(); }
        } finally {
            registry.runOnMainSync(activity::finish);
        }
    }

    @Test public void pauseResumeKeepsRenderedSurfaceAndFinishDestroysHost() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        Intent intent = new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = registry.startActivitySync(intent);
        TextureView texture = awaitTextureView(activity);
        assertTrue(texture instanceof PodRuntimeView);
        assertTrue("native host never booted", host((PodRuntimeView) texture) != 0);
        try {
            assertNotNull("TextureView never became available", texture);
            awaitBitmap(registry, texture);

            registry.runOnMainSync(() -> registry.callActivityOnPause(activity));
            registry.runOnMainSync(() -> registry.callActivityOnResume(activity));
            SystemClock.sleep(750L);
            Bitmap resumed = getBitmap(registry, texture);
            try {
                assertNotNull("surface lost its bitmap after pause/resume", resumed);
                assertTrue("resumed surface is all black", hasNonBlackPixel(resumed));
            } finally { if (resumed != null) resumed.recycle(); }

            registry.runOnMainSync(() -> {
                long now = SystemClock.uptimeMillis();
                MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, 233, 90, 0);
                activity.dispatchTouchEvent(down); down.recycle();
            });
            SystemClock.sleep(100L);
            registry.runOnMainSync(() -> {
                long now = SystemClock.uptimeMillis();
                MotionEvent up = MotionEvent.obtain(now - 100, now, MotionEvent.ACTION_UP, 233, 90, 0);
                activity.dispatchTouchEvent(up); up.recycle();
            });
            SystemClock.sleep(750L);
            Bitmap profile = getBitmap(registry, texture);
                saveBitmap(profile, new File(target.getFilesDir(), "watchrss-back-before.png"));
            try {
                assertNotNull("profile bitmap missing after pause/resume", profile);
                assertEquals("profile entry did not navigate after pause/resume", 0x2a2a2a,
                        profile.getPixel(233, 170) & 0xffffff);
            } finally { if (profile != null) profile.recycle(); }
        } finally {
            registry.runOnMainSync(activity::finish);
        }
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline && host((PodRuntimeView) texture) != 0) SystemClock.sleep(100L);
        assertEquals("PodRuntimeView host survived Activity finish", 0L, host((PodRuntimeView) texture));
    }

    private static String awaitSyncIdentity(TextureView texture) throws Exception {
        Field servicesField=PodRuntimeView.class.getDeclaredField("services");servicesField.setAccessible(true);
        Object services=servicesField.get(texture);Field ownerField=services.getClass().getDeclaredField("installedSync");ownerField.setAccessible(true);
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;
        while(SystemClock.uptimeMillis()<deadline){
            Object owner=ownerField.get(services);
            if(owner!=null){Field clientField=owner.getClass().getDeclaredField("client");clientField.setAccessible(true);Object client=clientField.get(owner);return (String)client.getClass().getMethod("localDeviceId").invoke(client);}
            SystemClock.sleep(50);
        }
        throw new AssertionError("installed sync owner never became available");
    }

    @Test public void activityRecreationCreatesFreshRenderedHost() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        Activity original = registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        TextureView oldTexture = awaitTextureView(original);
        awaitBitmap(registry, oldTexture);
        assertTrue(oldTexture instanceof PodRuntimeView);
        String oldSyncIdentity=awaitSyncIdentity(oldTexture);
        java.util.concurrent.atomic.AtomicReference<Activity> replacement = new java.util.concurrent.atomic.AtomicReference<>();
        android.app.Application application = (android.app.Application) target.getApplicationContext();
        android.app.Application.ActivityLifecycleCallbacks observer = new android.app.Application.ActivityLifecycleCallbacks() {
            public void onActivityCreated(Activity a, android.os.Bundle b) {}
            public void onActivityStarted(Activity a) {}
            public void onActivityResumed(Activity a) {
                if (a != original && a.getClass() == original.getClass()) replacement.set(a);
            }
            public void onActivityPaused(Activity a) {}
            public void onActivityStopped(Activity a) {}
            public void onActivitySaveInstanceState(Activity a, android.os.Bundle b) {}
            public void onActivityDestroyed(Activity a) {}
        };
        registry.runOnMainSync(() -> application.registerActivityLifecycleCallbacks(observer));
        try {
            registry.runOnMainSync(original::recreate);
            long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
            while (replacement.get() == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50L);
            assertNotNull("Activity recreation never resumed", replacement.get());
            TextureView newTexture = awaitTextureView(replacement.get());
            awaitBitmap(registry, newTexture);
            assertTrue("recreation reused the destroyed surface", newTexture != oldTexture);
            assertEquals("recreation leaked old native host", 0L, host((PodRuntimeView) oldTexture));
            assertTrue("new native host missing", host((PodRuntimeView) newTexture) != 0);
            assertEquals("recreation lost the installed sync identity",oldSyncIdentity,awaitSyncIdentity(newTexture));
        } finally {
            registry.runOnMainSync(() -> {
                application.unregisterActivityLifecycleCallbacks(observer);
                if (replacement.get() != null) replacement.get().finish();
                if (!original.isDestroyed()) original.finish();
            });
        }
    }

    @Test public void avatarBorderKeepsShapeDuringSlowDrag() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        final Activity activity = registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            TextureView texture = awaitTextureView(activity);
            awaitBitmap(registry, texture);
            SystemClock.sleep(500L);
            String reference = avatarBorderMask(getBitmap(registry, texture));
            int initialTop = lastCapturedAvatarTop, minimumTop = initialTop;
            long downTime = SystemClock.uptimeMillis();
            registry.runOnMainSync(() -> {
                MotionEvent event = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, 233, 250, 0);
                activity.dispatchTouchEvent(event); event.recycle();
            });
            for (int step = 1; step <= 40; step++) {
                final float y = 250f - step * 0.5f;
                registry.runOnMainSync(() -> {
                    MotionEvent event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, 233, y, 0);
                    activity.dispatchTouchEvent(event); event.recycle();
                });
                SystemClock.sleep(65L);
                assertEquals("avatar border changed at physical drag step " + step,
                        reference, avatarBorderMask(getBitmap(registry, texture)));
                minimumTop = Math.min(minimumTop, lastCapturedAvatarTop);
            }
            assertTrue("drag never moved the avatar", minimumTop < initialTop - 4);
            registry.runOnMainSync(() -> {
                MotionEvent event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, 233, 230, 0);
                activity.dispatchTouchEvent(event); event.recycle();
            });
        } finally { registry.runOnMainSync(activity::finish); }
    }

    @Test public void profileHorizontalBackFollowsFingerAndHonorsCancelCommit() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        Activity activity = registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            TextureView texture = awaitTextureView(activity);
            awaitBitmap(registry, texture);
            SystemClock.sleep(500L);
            Bitmap home = getBitmap(registry, texture);
            assertNotNull("home bitmap missing before profile gesture", home);
            try {
                tap(registry, activity, 233, 88);
                SystemClock.sleep(750L);
                Bitmap profileBeforeVertical = getBitmap(registry, texture);
                assertNotNull("profile bitmap missing", profileBeforeVertical);
                try {
                    assertEquals("profile entry did not navigate to the pill menu", 0x2a2a2a,
                            profileBeforeVertical.getPixel(233, 170) & 0xffffff);
                } finally { profileBeforeVertical.recycle(); }

                // A vertical profile scroll must stay on the profile route.
                swipe(registry, activity, 233, 233, 233, 180, false);
                SystemClock.sleep(800L); // Let any vertical fling settle before taking the profile baseline.
                Bitmap afterVertical = getBitmap(registry, texture);
                assertNotNull("profile bitmap missing after vertical scroll", afterVertical);
                try {
                    assertTrue("vertical scroll unexpectedly navigated away from profile",
                            containsColor(afterVertical, 0x2a2a2a));
                } finally { afterVertical.recycle(); }

                Bitmap profile = getBitmap(registry, texture);
                saveBitmap(profile, new File(target.getFilesDir(), "watchrss-back-before.png"));
                assertNotNull("profile bitmap missing before cancel gesture", profile);
                try {
                    long downTime = SystemClock.uptimeMillis();
                    dispatch(registry, activity, downTime, MotionEvent.ACTION_DOWN, 60, 233);
                    dispatch(registry, activity, downTime, MotionEvent.ACTION_MOVE, 160, 233);
                    SystemClock.sleep(250L); // Hold with the finger down.
                    Bitmap held = getBitmap(registry, texture);
                    assertNotNull("profile bitmap missing during held back gesture", held);
                    try {
                        saveBitmap(held, new File(target.getFilesDir(), "watchrss-back-held.png"));
                        assertFalse("partial back gesture did not move the rendered surface",
                                bitmapsEqual(profile, held));
                    } finally { held.recycle(); }
                    dispatch(registry, activity, downTime, MotionEvent.ACTION_CANCEL, 160, 233);
                    SystemClock.sleep(500L);
                    Bitmap afterCancel = getBitmap(registry, texture);
                    assertNotNull("profile bitmap missing after cancelled back gesture", afterCancel);
                    saveBitmap(afterCancel, new File(target.getFilesDir(), "watchrss-back-cancel.png"));
                    try {
                        assertTrue("cancelled back gesture did not restore profile pixels",
                                bitmapsEqual(profile, afterCancel));
                    } finally { afterCancel.recycle(); }

                    // Crossing 45% of the 466px physical surface commits back to home.
                    downTime = SystemClock.uptimeMillis();
                    dispatch(registry, activity, downTime, MotionEvent.ACTION_DOWN, 60, 233);
                    dispatch(registry, activity, downTime, MotionEvent.ACTION_MOVE, 300, 233);
                    dispatch(registry, activity, downTime, MotionEvent.ACTION_UP, 300, 233);
                    SystemClock.sleep(750L);
                    Bitmap afterCommit = getBitmap(registry, texture);
                    assertNotNull("home bitmap missing after committed back gesture", afterCommit);
                    try {
                        assertTrue("committed back gesture did not restore retained home pixels",
                                bitmapsEqual(home, afterCommit));
                    } finally { afterCommit.recycle(); }
                } finally { profile.recycle(); }
            } finally { home.recycle(); }
        } finally { registry.runOnMainSync(activity::finish); }
    }

    private static void tap(Instrumentation registry, Activity activity, float x, float y) {
        long downTime = SystemClock.uptimeMillis();
        dispatch(registry, activity, downTime, MotionEvent.ACTION_DOWN, x, y);
        dispatch(registry, activity, downTime, MotionEvent.ACTION_UP, x, y);
        android.util.Log.i("WatchRssInputTiming","tap="+x+","+y+" begin="+downTime+" elapsed="+(SystemClock.uptimeMillis()-downTime));
    }

    private static void swipe(Instrumentation registry, Activity activity,
                              float startX, float startY, float endX, float endY, boolean cancel) {
        long downTime = SystemClock.uptimeMillis();
        dispatch(registry, activity, downTime, MotionEvent.ACTION_DOWN, startX, startY);
        for (int step = 1; step <= 8; step++) dispatch(registry, activity, downTime, MotionEvent.ACTION_MOVE, startX + (endX-startX)*step/8f, startY + (endY-startY)*step/8f);
        SystemClock.sleep(300L);
        dispatch(registry, activity, downTime,
                cancel ? MotionEvent.ACTION_CANCEL : MotionEvent.ACTION_UP, endX, endY);
    }

    private static void dispatch(Instrumentation registry, Activity activity, long downTime,
                                 int action, float x, float y) {
        registry.runOnMainSync(() -> {
            MotionEvent event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0);
            activity.dispatchTouchEvent(event);
            event.recycle();
        });
        // The renderer polls native input once per frame; keep each state visible to it.
        SystemClock.sleep(60L);
    }

    @Test public void rotaryScrollDirectionMatchesPhysicalWheel() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        Activity activity = registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            TextureView texture = awaitTextureView(activity);
            awaitBitmap(registry, texture);
            SystemClock.sleep(500L);
            avatarBorderMask(getBitmap(registry, texture));
            int initialTop = lastCapturedAvatarTop;

            dispatchRotary(registry, activity, -0.1f);
            SystemClock.sleep(300L);
            avatarBorderMask(getBitmap(registry, texture));
            int afterNegativeTop = lastCapturedAvatarTop;
            assertTrue("negative rotary scroll did not move the home list upward: " + initialTop + " -> " + afterNegativeTop,
                    afterNegativeTop < initialTop - 2);

            dispatchRotary(registry, activity, 0.1f);
            SystemClock.sleep(300L);
            avatarBorderMask(getBitmap(registry, texture));
            int afterPositiveTop = lastCapturedAvatarTop;
            assertTrue("positive rotary scroll did not reverse the home list direction",
                    afterPositiveTop > afterNegativeTop + 2);
        } finally { registry.runOnMainSync(activity::finish); }
    }

    @Test public void rootFallbackBackWaitsForReleaseAndHonorsCancel() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        MainActivity activity = (MainActivity) registry.startActivitySync(new Intent().setClassName(
                target.getPackageName(), "dev.podjs.androidwatch.MainActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        java.util.concurrent.atomic.AtomicBoolean stopped = new java.util.concurrent.atomic.AtomicBoolean();
        android.app.Application application = (android.app.Application) target.getApplicationContext();
        android.app.Application.ActivityLifecycleCallbacks observer = new android.app.Application.ActivityLifecycleCallbacks() {
            public void onActivityCreated(Activity a, android.os.Bundle b) {}
            public void onActivityStarted(Activity a) {}
            public void onActivityResumed(Activity a) {}
            public void onActivityPaused(Activity a) {}
            public void onActivityStopped(Activity a) { if (a == activity) stopped.set(true); }
            public void onActivitySaveInstanceState(Activity a, android.os.Bundle b) {}
            public void onActivityDestroyed(Activity a) {}
        };
        registry.runOnMainSync(() -> application.registerActivityLifecycleCallbacks(observer));
        try {
            TextureView texture = awaitTextureView(activity);
            awaitBitmap(registry, texture);
            SystemClock.sleep(500L);
            registry.runOnMainSync(() -> assertFalse("home published an internal back stack", ((PodRuntimeView)texture).canNavigateBack()));
            // Exercise the non-OPPO fallback branch even when the test host reports platform dismissal.
            Field platformSwipeDismiss = MainActivity.class.getDeclaredField("platformSwipeDismiss");
            platformSwipeDismiss.setAccessible(true);
            registry.runOnMainSync(() -> {
                try { platformSwipeDismiss.setBoolean(activity, false); }
                catch (IllegalAccessException error) { throw new AssertionError(error); }
            });

            long downTime = SystemClock.uptimeMillis();
            dispatch(registry, activity, downTime, MotionEvent.ACTION_DOWN, 60, 233);
            dispatch(registry, activity, downTime, MotionEvent.ACTION_MOVE, 310, 233);
            assertTrue("fallback back finished Activity while the finger was held", !activity.isFinishing() && !stopped.get());
            dispatch(registry, activity, downTime, MotionEvent.ACTION_CANCEL, 310, 233);
            assertTrue("cancelled fallback back finished Activity", !activity.isFinishing() && !stopped.get());

            downTime = SystemClock.uptimeMillis();
            dispatch(registry, activity, downTime, MotionEvent.ACTION_DOWN, 60, 233);
            dispatch(registry, activity, downTime, MotionEvent.ACTION_MOVE, 310, 233);
            dispatch(registry, activity, downTime, MotionEvent.ACTION_UP, 310, 233);
            long deadline = SystemClock.uptimeMillis() + 2_000L;
            while (!stopped.get() && !activity.isFinishing() && !activity.isDestroyed()
                    && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50L);
            assertTrue("committed fallback back did not leave the foreground",
                    stopped.get() || activity.isFinishing() || activity.isDestroyed());
        } finally {
            registry.runOnMainSync(() -> application.unregisterActivityLifecycleCallbacks(observer));
            if (!activity.isFinishing() && !activity.isDestroyed()) registry.runOnMainSync(activity::finish);
        }
    }

    @Test public void roundBackClipsWholeMovingPageToCircle() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        Activity activity = registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Bitmap home = null, profile = null, held = null;
        try {
            TextureView texture = awaitTextureView(activity);
            awaitBitmap(registry, texture); SystemClock.sleep(500L);
            home = getBitmap(registry, texture);
            tap(registry, activity, 233, 88); SystemClock.sleep(500L);
            profile = getBitmap(registry, texture);
            long downTime = SystemClock.uptimeMillis();
            dispatch(registry, activity, downTime, MotionEvent.ACTION_DOWN, 60, 233);
            dispatch(registry, activity, downTime, MotionEvent.ACTION_MOVE, 160, 233);
            SystemClock.sleep(200L);
            held = getBitmap(registry, texture);
            saveBitmap(held, new File(target.getFilesDir(), "watchrss-circle-back-held.png"));
            int outsideChecks = 0, insideChecks = 0, uncoveredInk = 0;
            // A 466px circle translates 100px with the finger. Exclude its
            // two-pixel boundary so coverage rounding is not mistaken for a leak.
            for (int y = 0; y < 466; y++) for (int x = 100; x < 466; x++) {
                double distance = Math.hypot(x + .5 - 333, y + .5 - 233);
                if (distance > 235) {
                    assertEquals("moving circle leaked at " + x + "," + y,
                            home.getPixel(x,y), held.getPixel(x,y));
                    outsideChecks++;
                    if ((home.getPixel(x,y) & 0xffffff) != 0) uncoveredInk++;
                } else if (distance < 231) {
                    assertEquals("circle changed page content at " + x + "," + y,
                            profile.getPixel(x-100,y), held.getPixel(x,y));
                    insideChecks++;
                }
            }
            assertTrue("circle checks missed exposed previous page", outsideChecks > 10000 && uncoveredInk > 1000);
            assertTrue("circle checks missed page content", insideChecks > 50000);
            dispatch(registry, activity, downTime, MotionEvent.ACTION_CANCEL, 160, 233);
            SystemClock.sleep(400L);
            Bitmap cancelled = getBitmap(registry, texture);
            try { assertTrue("round back cancellation changed page", bitmapsEqual(profile, cancelled)); }
            finally { cancelled.recycle(); }
        } finally {
            if (home != null) home.recycle(); if (profile != null) profile.recycle(); if (held != null) held.recycle();
            registry.runOnMainSync(activity::finish);
        }
    }

    @Test public void migratedRoutesReturnToHomeRoot() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        Activity activity = registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            TextureView texture = awaitTextureView(activity);
            awaitBitmap(registry, texture);
            SystemClock.sleep(500L);
            Bitmap home = getBitmap(registry, texture);
            assertNotNull("home bitmap missing before migrated-route checks", home);
            try {
                // Home uses 2x density: the memo card center is about 130dp = 260px.
                tap(registry, activity, 233, 259);
                SystemClock.sleep(900L);
                Bitmap notes = getBitmap(registry, texture);
                assertNotNull("memo page bitmap missing", notes);
                try {
                    saveBitmap(notes, new File(target.getFilesDir(), "watchrss-navigation-notes.png"));
                    assertFalse("memo navigation did not change the home surface", bitmapsEqual(home, notes));
                } finally { notes.recycle(); }
                registry.runOnMainSync(activity::onBackPressed);
                SystemClock.sleep(600L);
                assertRootBitmap(registry, texture, home, "memo page back");

                tap(registry, activity, 233, 88);
                SystemClock.sleep(600L);
                scrollProfileForSettings(registry, activity);
                // From the bottom, a 120px downward drag exposes 设置 at 122px and 关于 at 242px.
                tap(registry, activity, 233, 122); // 设置
                SystemClock.sleep(900L);
                Bitmap settings = getBitmap(registry, texture);
                assertNotNull("settings page bitmap missing", settings);
                try {
                    saveBitmap(settings, new File(target.getFilesDir(), "watchrss-navigation-settings.png"));
                    assertTrue("settings route did not expose an internal back target", canNavigateBack(texture));
                    assertFalse("settings navigation did not change the home surface", bitmapsEqual(home, settings));
                    tap(registry, activity, 233, 384); // 朗读语速, second settings row
                    SystemClock.sleep(700L);
                    Bitmap speech = getBitmap(registry, texture);
                    assertNotNull("speech settings bitmap missing", speech);
                    try {
                        assertFalse("speech settings did not open", bitmapsEqual(settings, speech));
                        saveBitmap(speech, new File(target.getFilesDir(), "watchrss-navigation-speech.png"));
                    } finally { speech.recycle(); }
                    registry.runOnMainSync(activity::onBackPressed);
                    SystemClock.sleep(600L);
                    assertRootBitmap(registry, texture, settings, "speech settings back");
                    swipe(registry,activity,233,400,233,230,false);SystemClock.sleep(500);
                    Bitmap scrolledSettings=getBitmap(registry,texture);
                    try {
                        tap(registry,activity,233,342);SystemClock.sleep(700);
                        saveRssStage(registry,texture,target,"auto-settings");
                        registry.runOnMainSync(activity::onBackPressed);SystemClock.sleep(600);
                        assertRootBitmap(registry,texture,scrolledSettings,"automatic scroll settings back");
                    } finally {scrolledSettings.recycle();}
                } finally { settings.recycle(); }
                registry.runOnMainSync(activity::onBackPressed);
                SystemClock.sleep(500L);
                registry.runOnMainSync(activity::onBackPressed);
                SystemClock.sleep(600L);
                assertRootBitmap(registry, texture, home, "settings page back");

                tap(registry, activity, 233, 88);
                SystemClock.sleep(600L);
                scrollProfileForSettings(registry, activity);
                tap(registry, activity, 233, 242); // 关于
                SystemClock.sleep(900L);
                Bitmap about = getBitmap(registry, texture);
                assertNotNull("about page bitmap missing", about);
                try {
                    saveBitmap(about, new File(target.getFilesDir(), "watchrss-navigation-about.png"));
                    assertTrue("about route did not expose an internal back target", canNavigateBack(texture));
                    assertFalse("about navigation did not change the home surface", bitmapsEqual(home, about));
                } finally { about.recycle(); }
                registry.runOnMainSync(activity::onBackPressed);
                SystemClock.sleep(500L);
                registry.runOnMainSync(activity::onBackPressed);
                SystemClock.sleep(600L);
                assertRootBitmap(registry, texture, home, "about page back");
            } finally { home.recycle(); }
        } finally { registry.runOnMainSync(activity::finish); }
    }

    private static void assertRootBitmap(Instrumentation registry, TextureView texture,
                                         Bitmap expected, String route) {
        Bitmap actual = getBitmap(registry, texture);
        assertNotNull(route + " did not render a root bitmap", actual);
        try { assertTrue(route + " did not restore the home root", bitmapsEqual(expected, actual)); }
        finally { actual.recycle(); }
    }

    private static void scrollProfileForSettings(Instrumentation registry, Activity activity) {
        // A drag moves only 185dp, less than the profile content overflow.
        // Repeat to clamp at the bottom before using bottom-relative row coordinates.
        for (int i = 0; i < 3; i++) {
            swipe(registry, activity, 233, 420, 233, 50, false);
            SystemClock.sleep(500L);
        }
        // At the exact bottom, 设置 is above the visible circle and 关于 occupies 122px.
        swipe(registry, activity, 233, 150, 233, 270, false);
        SystemClock.sleep(500L);
    }

    private static boolean canNavigateBack(TextureView texture) {
        final boolean[] result = new boolean[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            result[0] = texture instanceof PodRuntimeView && ((PodRuntimeView) texture).canNavigateBack();
        });
        return result[0];
    }

    private static void dispatchRotary(Instrumentation registry, Activity activity, float scroll) {
        dispatchRawScroll(registry,activity,scroll,android.view.InputDevice.SOURCE_ROTARY_ENCODER,MotionEvent.AXIS_SCROLL);
    }
    private static void dispatchRawScroll(Instrumentation registry, Activity activity, float scroll,int source,int axis) {
        registry.runOnMainSync(() -> {
            long now = SystemClock.uptimeMillis();
            MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
            properties.id = 0;
            properties.toolType = MotionEvent.TOOL_TYPE_FINGER;
            MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
            coords.x = 233;
            coords.y = 233;
            coords.setAxisValue(axis, scroll);
            MotionEvent event = MotionEvent.obtain(now, now, MotionEvent.ACTION_SCROLL, 1,
                    new MotionEvent.PointerProperties[] { properties },
                    new MotionEvent.PointerCoords[] { coords }, 0, 0, 1f, 1f, 0, 0,
                    source, 0);
            activity.dispatchGenericMotionEvent(event);
            event.recycle();
        });
        SystemClock.sleep(60L);
    }

    private static void saveBitmap(Bitmap bitmap, File output) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(output)) {
            assertTrue("bitmap could not be encoded", bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream));
        }
        assertTrue("bitmap capture missing", output.isFile() && output.length() > 0);
    }

    private static boolean bitmapsEqual(Bitmap left, Bitmap right) {
        if (left.getWidth() != right.getWidth() || left.getHeight() != right.getHeight()) return false;
        for (int y = 0; y < left.getHeight(); y++)
            for (int x = 0; x < left.getWidth(); x++)
                if (left.getPixel(x, y) != right.getPixel(x, y)) return false;
        return true;
    }

    private static boolean containsColor(Bitmap bitmap, int color) {
        for (int y = 0; y < bitmap.getHeight(); y += 2)
            for (int x = 0; x < bitmap.getWidth(); x += 2)
                if ((bitmap.getPixel(x, y) & 0xffffff) == color) return true;
        return false;
    }

    private static int lastCapturedAvatarTop;
    private static String avatarBorderMask(Bitmap bitmap) {
        assertNotNull("missing avatar frame", bitmap);
        try {
            int left = 466, top = 466, right = 0, bottom = 0;
            for (int y = 0; y < 170; y++) for (int x = 150; x < 320; x++) {
                if (isAvatarBorder(bitmap.getPixel(x, y))) {
                    left = Math.min(left, x); top = Math.min(top, y);
                    right = Math.max(right, x); bottom = Math.max(bottom, y);
                }
            }
            assertTrue("orange avatar border missing", right > left && bottom > top);
            lastCapturedAvatarTop = top;
            StringBuilder mask = new StringBuilder().append(right-left+1).append('x').append(bottom-top+1).append(':');
            for (int y = top; y <= bottom; y++) for (int x = left; x <= right; x++)
                mask.append(isAvatarBorder(bitmap.getPixel(x,y)) ? '1' : '0');
            return mask.toString();
        } finally { bitmap.recycle(); }
    }

    private static void awaitHomeBitmap(Instrumentation registry,TextureView texture) {
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;
        while(SystemClock.uptimeMillis()<deadline){
            Bitmap bitmap=getBitmap(registry,texture);
            if(bitmap!=null){
                boolean ready=false;
                for(int y=40;y<Math.min(150,bitmap.getHeight());y+=2)
                    for(int x=160;x<Math.min(310,bitmap.getWidth());x+=2)
                        if(isAvatarBorder(bitmap.getPixel(x,y)))ready=true;
                bitmap.recycle();if(ready)return;
            }
            SystemClock.sleep(100);
        }
        throw new AssertionError("home avatar not ready");
    }
    private static void awaitRssPixel(Instrumentation registry,TextureView texture,Context target,int x,int y,int expected) throws Exception {
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;
        while(SystemClock.uptimeMillis()<deadline){
            Bitmap bitmap=getBitmap(registry,texture);
            if(bitmap!=null){boolean ready=(bitmap.getPixel(x,y)&0xffffff)==expected;bitmap.recycle();if(ready)return;}
            SystemClock.sleep(100);
        }
        saveRssStage(registry,texture,target,"timeout");
        throw new AssertionError("RSS navigation did not render expected control");
    }
    private static void saveRssStage(Instrumentation registry,TextureView texture,Context target,String stage) throws Exception {
        Bitmap bitmap=getBitmap(registry,texture);
        try{assertNotNull(bitmap);saveBitmap(bitmap,new File(target.getFilesDir(),"watchrss-rss-"+stage+".png"));}
        finally{if(bitmap!=null)bitmap.recycle();}
    }

    @Test public void rssWatchLaterAndFavoriteStayIndependent() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();
        Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject originalKv=readerKv(target);Object hiddenBackup=originalKv.opt("media.hidden-channels"),settingsBackup=originalKv.opt("watchrss.settings");
        originalKv.put("media.hidden-channels",new org.json.JSONArray().put("bili").put("douyin"));originalKv.remove("watchrss.settings");writeReaderKv(target,originalKv);
        Activity activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        String marker="codex-rss-"+SystemClock.uptimeMillis();
        long channelId=0, articleId=0;
        try {
            TextureView texture=awaitTextureView(activity); awaitChannelsTable(target); awaitHomeBitmap(registry,texture);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try {
                database.execSQL("INSERT INTO channels(url,title,created_at,sort_order) VALUES(?,?,?,-9000000000000000)",new Object[]{"https://example.test/"+marker,"迁移验证订阅",System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://example.test/"+marker})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,1)",new Object[]{channelId,"迁移验证文章","摘要与中文显示","正文内容与阅读状态","https://example.test/"+marker,marker,System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{marker})){assertTrue(c.moveToFirst());articleId=c.getLong(0);}
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000000)",new Object[]{articleId,System.currentTimeMillis()});
            } finally {database.close();}
            registry.runOnMainSync(activity::finish);SystemClock.sleep(700);
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));texture=awaitTextureView(activity);awaitHomeBitmap(registry,texture);
            tap(registry,activity,233,400);SystemClock.sleep(700);
            long down=SystemClock.uptimeMillis();dispatch(registry,activity,down,MotionEvent.ACTION_DOWN,233,210);SystemClock.sleep(900);dispatch(registry,activity,down,MotionEvent.ACTION_UP,233,210);SystemClock.sleep(600);
            saveRssStage(registry,texture,target,"actions");
            tap(registry,activity,233,204);SystemClock.sleep(700);
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
            try(Cursor c=database.rawQuery("SELECT saved FROM article_saved_states WHERE article_id=? AND save_type='watchLater'",new String[]{Long.toString(articleId)})){
                assertTrue("watch later action did not persist",c.moveToFirst());assertEquals(1,c.getInt(0));
            } finally {database.close();}
            tap(registry,activity,233,210);awaitReaderTop(registry,texture,target);SystemClock.sleep(600);
            saveRssStage(registry,texture,target,"reader-footer-favorite");
            tap(registry,activity,145,302);SystemClock.sleep(700);awaitReaderTop(registry,texture,target);
            saveRssStage(registry,texture,target,"reader-footer-unfavorite");
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
            try(Cursor c=database.rawQuery("SELECT a.is_saved,a.is_read,s.saved FROM articles a JOIN article_saved_states s ON s.article_id=a.id AND s.save_type='watchLater' WHERE a.id=?",new String[]{Long.toString(articleId)})){
                assertTrue(c.moveToFirst());assertEquals(0,c.getInt(0));assertEquals(1,c.getInt(1));assertEquals(1,c.getInt(2));
            } finally {database.close();}
            tap(registry,activity,233,302);awaitRssPixel(registry,texture,target,110,168,0xffffff);
            saveRssStage(registry,texture,target,"reader-footer-share");
            tap(registry,activity,233,290);awaitReaderTop(registry,texture,target);
        } finally {
            registry.runOnMainSync(activity::finish);SystemClock.sleep(700);
            org.json.JSONObject latest=readerKv(target);latest.remove("watchrss.reader.progress."+articleId);
            if(hiddenBackup==null)latest.remove("media.hidden-channels");else latest.put("media.hidden-channels",hiddenBackup);
            if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);writeReaderKv(target,latest);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try {
                database.delete("article_saved_states","article_id=?",new String[]{Long.toString(articleId)});
                database.delete("articles","id=? AND dedup_key=?",new String[]{Long.toString(articleId),marker});
                database.delete("channels","id=? AND url=?",new String[]{Long.toString(channelId),"https://example.test/"+marker});
            } finally {database.close();}
        }
    }

    private static org.json.JSONObject readerKv(Context target) throws Exception {
        File file=new File(target.getFilesDir(),"podjs/podjs-kv.json");
        return file.exists()?new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)):new org.json.JSONObject();
    }
    private static void writeReaderKv(Context target,org.json.JSONObject value) throws Exception {
        File file=new File(target.getFilesDir(),"podjs/podjs-kv.json");file.getParentFile().mkdirs();
        java.nio.file.Files.write(file.toPath(),value.toString().getBytes(StandardCharsets.UTF_8));
    }
    private static double readerOffset(Context target,long articleId) throws Exception {
        String value=readerKv(target).optString("watchrss.reader.progress."+articleId,"");
        return value.isEmpty()?0:new org.json.JSONObject(value).getDouble("offset");
    }
    private static void awaitReaderTop(Instrumentation registry,TextureView texture,Context target) throws Exception {
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;
        while(SystemClock.uptimeMillis()<deadline){
            Bitmap bitmap=getBitmap(registry,texture);int titleInk=0,pill=0;
            if(bitmap!=null){try{
                for(int y=35;y<110;y++)for(int x=100;x<366;x++){int c=bitmap.getPixel(x,y);if(android.graphics.Color.red(c)>180&&android.graphics.Color.green(c)>180)titleInk++;}
                for(int y=125;y<265;y++)if((bitmap.getPixel(40,y)&0xffffff)==0x23272a)pill++;
                if(titleInk>150&&pill>20)return;
            }finally{bitmap.recycle();}}
            SystemClock.sleep(100);
        }
        saveRssStage(registry,texture,target,"reader-top-timeout");
        throw new AssertionError("scrolling article title and original-content action did not render");
    }
    private static void openFirstSavedReader(Instrumentation registry,Activity activity,TextureView texture,Context target) throws Exception {
        openFirstSavedReader(registry,activity,texture,target,true);
    }
    private static void openFirstSavedReader(Instrumentation registry,Activity activity,TextureView texture,Context target,boolean atTop) throws Exception {
        awaitHomeBitmap(registry,texture);
        tap(registry,activity,233,90);SystemClock.sleep(600);
        tap(registry,activity,233,276);SystemClock.sleep(700);
        tap(registry,activity,233,180);if(atTop)awaitReaderTop(registry,texture,target);
        SystemClock.sleep(600);
    }
    private static void pinchReaderImage(Instrumentation registry,Activity activity) {
        final long began=SystemClock.uptimeMillis();
        for(int step=0;step<15;step++) {
            final int count=step==0||step==14?1:2;
            final int action=step==0?MotionEvent.ACTION_DOWN:step==1?MotionEvent.ACTION_POINTER_DOWN|(1<<MotionEvent.ACTION_POINTER_INDEX_SHIFT):step==13?MotionEvent.ACTION_POINTER_UP|(1<<MotionEvent.ACTION_POINTER_INDEX_SHIFT):step==14?MotionEvent.ACTION_UP:MotionEvent.ACTION_MOVE;
            float span=100+100*Math.min(1,Math.max(0,(step-1)/11f));
            MotionEvent.PointerProperties[] properties=new MotionEvent.PointerProperties[count];MotionEvent.PointerCoords[] coords=new MotionEvent.PointerCoords[count];
            for(int i=0;i<count;i++){properties[i]=new MotionEvent.PointerProperties();properties[i].id=i;properties[i].toolType=MotionEvent.TOOL_TYPE_FINGER;coords[i]=new MotionEvent.PointerCoords();coords[i].x=233+(i==0?-span/2:span/2);coords[i].y=233;coords[i].pressure=1;coords[i].size=1;}
            MotionEvent event=MotionEvent.obtain(began,SystemClock.uptimeMillis(),action,count,properties,coords,0,0,1,1,0,0,android.view.InputDevice.SOURCE_TOUCHSCREEN,0);
            registry.runOnMainSync(()->activity.dispatchTouchEvent(event));event.recycle();SystemClock.sleep(20);
        }
    }
    private static final class ReaderImageServer implements AutoCloseable {
        final java.net.ServerSocket server=new java.net.ServerSocket(0);
        volatile int requests=0;
        volatile byte[] videoBytes=new byte[0];volatile int videoRequests=0;volatile long videoDelayMillis=0;
        volatile String feedXml="<rss><channel><title>频道验证</title><description>简介</description></channel></rss>";volatile int feedRequests=0;volatile long feedDelayMillis=0;
        volatile int originalRequests=0;volatile boolean emptyOriginal=false;volatile long originalDelayMillis=0;volatile String originalSuffix="";
        ReaderImageServer() throws Exception {this(false);}
        ReaderImageServer(boolean detailed) throws Exception {
            Bitmap bitmap=Bitmap.createBitmap(120,60,Bitmap.Config.ARGB_8888);bitmap.eraseColor(0xff28a75b);android.graphics.Paint stripe=new android.graphics.Paint();stripe.setColor(0xffd83c3c);new android.graphics.Canvas(bitmap).drawRect(0,0,12,60,stripe);
            if(detailed){bitmap.recycle();bitmap=Bitmap.createBitmap(1024,512,Bitmap.Config.ARGB_8888);for(int y=0;y<512;y++)for(int x=0;x<1024;x++)bitmap.setPixel(x,y,(x&1)==0?0xff000000:0xffffffff);}
            java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();bitmap.compress(Bitmap.CompressFormat.PNG,100,bytes);bitmap.recycle();
            final byte[] png=bytes.toByteArray();
            Thread worker=new Thread(()->{while(!server.isClosed())try(java.net.Socket socket=server.accept()){
                socket.setSoTimeout(5000);java.io.BufferedReader input=new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream(),StandardCharsets.US_ASCII));
                String requestLine=input.readLine();String line;while((line=input.readLine())!=null&&!line.isEmpty()){}
                boolean media=requestLine!=null&&requestLine.contains(" /video.mp4 ");if(media){videoRequests++;if(videoDelayMillis>0)SystemClock.sleep(videoDelayMillis);}
                boolean feed=requestLine!=null&&requestLine.contains(" /feed ");if(feed){feedRequests++;if(feedDelayMillis>0)SystemClock.sleep(feedDelayMillis);}
                boolean original=requestLine!=null&&(requestLine.contains(" /article ")||requestLine.contains(" /article?"));if(original){originalRequests++;if(originalDelayMillis>0)SystemClock.sleep(originalDelayMillis);}
                requests++;java.io.OutputStream output=socket.getOutputStream();
                byte[] response=media?videoBytes:feed?feedXml.getBytes(StandardCharsets.UTF_8):original?(emptyOriginal?"<article><script>hidden</script></article>":"<article><nav>隐藏导航</nav><p>网页原文</p><img src=\"/image.png\">"+originalSuffix+"</article>").getBytes(StandardCharsets.UTF_8):png;
                output.write(("HTTP/1.1 200 OK\r\nContent-Type: "+(media?"video/mp4":feed?"application/rss+xml; charset=UTF-8":original?"text/html; charset=UTF-8":"image/png")+"\r\nContent-Length: "+response.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));output.write(response);output.flush();
            }catch(Exception ignored){if(server.isClosed())return;}});worker.setDaemon(true);worker.start();
        }
        String url(){return "http://127.0.0.1:"+server.getLocalPort()+"/image.png";}
        public void close() throws Exception {server.close();}
    }
    @Test public void readerImageLoadsOpensAndReturnsToStructuredBody() throws Exception {exerciseReaderImage(false);}
    @Test public void readerImageZoomResolvesOriginalPixelDetail() throws Exception {exerciseReaderImage(true);}
    private void exerciseReaderImage(boolean detailed) throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject originalKv=readerKv(target);Object settingsBackup=originalKv.opt("watchrss.settings");originalKv.remove("watchrss.settings");writeReaderKv(target,originalKv);
        Activity activity=null;long articleId=0,channelId=0;String marker="codex-reader-image-"+SystemClock.uptimeMillis();
        try(ReaderImageServer server=new ReaderImageServer(detailed)) {
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try {
                database.execSQL("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)",new Object[]{"https://example.test/"+marker,"图文验证",System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://example.test/"+marker})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                String body="<img src='"+server.url()+"'><h1>正文标题</h1><h3>副标题</h3><blockquote>引用内容</blockquote><pre>代码\n  缩进</pre><p>正文内容，图片与文字分段显示。</p>";
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,1)",new Object[]{channelId,"图文验证文章","正文",body,"https://example.test/"+marker,marker,System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{marker})){assertTrue(c.moveToFirst());articleId=c.getLong(0);}
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000001)",new Object[]{articleId,System.currentTimeMillis()});
            } finally {database.close();}
            openFirstSavedReader(registry,activity,texture,target);
            if(detailed)SystemClock.sleep(1800);else awaitRssPixel(registry,texture,target,233,280,0x28a75b);assertTrue("image server was never requested",server.requests>0);
            SystemClock.sleep(1000);
            Bitmap stableImage=getBitmap(registry,texture);int headerInk=0;
            for(int y=25;y<85;y++)for(int x=140;x<325;x++){int color=stableImage.getPixel(x,y);if(android.graphics.Color.red(color)>180&&android.graphics.Color.green(color)>180&&android.graphics.Color.blue(color)>180)headerInk++;}
            saveBitmap(stableImage,new File(target.getFilesDir(),"watchrss-rss-structured-image.png"));stableImage.recycle();
            assertTrue("image upload erased the reader header",headerInk>100);
            tap(registry,activity,233,280);SystemClock.sleep(800);
            if(detailed){
                saveRssStage(registry,texture,target,"detail-preview-opened");
                SystemClock.sleep(1800);
                tap(registry,activity,233,233);tap(registry,activity,233,233);SystemClock.sleep(1000);saveRssStage(registry,texture,target,"detail-preview-2x");
                tap(registry,activity,233,233);tap(registry,activity,233,233);SystemClock.sleep(2500);saveRssStage(registry,texture,target,"detail-preview-4x");
                long detailDeadline=SystemClock.uptimeMillis()+TIMEOUT_MS;Bitmap detail=null;boolean resolved=false;String detailReport="";
                while(SystemClock.uptimeMillis()<detailDeadline){
                    if(detail!=null)detail.recycle();detail=getBitmap(registry,texture);resolved=true;detailReport="";
                    for(int startX:new int[]{30,140,250,360}){int darkest=255,lightest=0,transitions=0,previous=-1;
                        for(int x=startX;x<startX+75;x++){int shade=android.graphics.Color.red(detail.getPixel(x,233));darkest=Math.min(darkest,shade);lightest=Math.max(lightest,shade);if(previous>=0&&Math.abs(shade-previous)>70)transitions++;previous=shade;}
                        resolved&=lightest-darkest>160&&transitions>20;detailReport+=startX+":"+darkest+".."+lightest+"/"+transitions+" ";
                    }
                    if(resolved)break;SystemClock.sleep(100);
                }
                saveBitmap(detail,new File(target.getFilesDir(),"watchrss-original-image-detail.png"));detail.recycle();
                assertTrue("visible image bands lack original detail: "+detailReport,resolved);
                tap(registry,activity,233,233);SystemClock.sleep(1500);
                awaitReaderTop(registry,texture,target);
                File imageDirectory=new File(target.getFilesDir(),"podjs/files/images");
                File[] leftovers=imageDirectory.listFiles((parent,name)->name.startsWith("preview-")||name.endsWith(".rgba"));
                assertTrue("preview left temporary images: "+java.util.Arrays.toString(leftovers),leftovers==null||leftovers.length==0);
                assertTrue("tile zoom downloaded original repeatedly",server.requests<=3);
                return;
            }
            awaitRssPixel(registry,texture,target,450,233,0x28a75b);
            saveRssStage(registry,texture,target,"image-expanded");
            tap(registry,activity,233,233);tap(registry,activity,233,233);SystemClock.sleep(1000);
            awaitRssPixel(registry,texture,target,233,90,0x28a75b); // 2x now fills the height
            saveRssStage(registry,texture,target,"image-zoomed");
            tap(registry,activity,233,233);tap(registry,activity,233,233);SystemClock.sleep(1000); // 4x
            tap(registry,activity,233,233);tap(registry,activity,233,233);SystemClock.sleep(1000); // 1x
            awaitRssPixel(registry,texture,target,233,90,0x000000);
            pinchReaderImage(registry,activity);SystemClock.sleep(1000); // two contacts zoom back to 2x
            awaitRssPixel(registry,texture,target,233,90,0x28a75b);
            saveRssStage(registry,texture,target,"image-pinched");
            swipe(registry,activity,100,233,430,233,false);SystemClock.sleep(1000);
            awaitRssPixel(registry,texture,target,30,233,0xd83c3c); // left stripe after panning to the right edge
            saveRssStage(registry,texture,target,"image-panned");
            swipe(registry,activity,30,233,420,233,false);SystemClock.sleep(800); // edge gives back gesture to parent

            awaitReaderTop(registry,texture,target);
            tap(registry,activity,233,280);SystemClock.sleep(800);
            awaitRssPixel(registry,texture,target,450,233,0x28a75b);
            tap(registry,activity,233,233);SystemClock.sleep(600); // native single tap exits
            awaitReaderTop(registry,texture,target);
            swipe(registry,activity,233,360,233,170,false);SystemClock.sleep(800);
            saveRssStage(registry,texture,target,"structured-text");
            assertTrue("image layout caused repeated image requests",server.requests<=6);
        } finally {
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(700);}
            org.json.JSONObject latest=readerKv(target);latest.remove("watchrss.reader.progress."+articleId);if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);writeReaderKv(target,latest);
            if(channelId!=0){SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);try{database.delete("article_saved_states","article_id=?",new String[]{Long.toString(articleId)});database.delete("articles","id=? AND dedup_key=?",new String[]{Long.toString(articleId),marker});database.delete("channels","id=? AND url=?",new String[]{Long.toString(channelId),"https://example.test/"+marker});}finally{database.close();}}
        }
    }

    private static dev.podjs.runtime.PodVideoServices nativeVideo(TextureView texture) throws Exception {
        Field servicesField=PodRuntimeView.class.getDeclaredField("services");servicesField.setAccessible(true);Object services=servicesField.get(texture);
        Field videoField=services.getClass().getDeclaredField("video");videoField.setAccessible(true);return (dev.podjs.runtime.PodVideoServices)videoField.get(services);
    }
    private static org.json.JSONObject videoSnapshot(TextureView texture) throws Exception {
        final org.json.JSONObject[] result={null};final String[] error={null};java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1);
        nativeVideo(texture).dispatch("video.state",new org.json.JSONObject(),new dev.podjs.runtime.PodVideoServices.Callback(){public void complete(org.json.JSONObject value){result[0]=value;done.countDown();}public void fail(String code,String message){error[0]=code+":"+message;done.countDown();}});
        assertTrue("video state timed out",done.await(3,java.util.concurrent.TimeUnit.SECONDS));assertEquals(null,error[0]);return result[0];
    }
    private static org.json.JSONObject awaitVideoState(TextureView texture,String expected) throws Exception {
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;org.json.JSONObject value=null;
        while(SystemClock.uptimeMillis()<deadline){value=videoSnapshot(texture);if(expected.equals(value.optString("state")))return value;SystemClock.sleep(100);}
        throw new AssertionError("expected video state "+expected+" got "+value);
    }
    private static void verifyReaderWindow(Instrumentation registry,Activity activity,TextureView texture,Context target,String stage) throws Exception {
        Bitmap bitmap=Bitmap.createBitmap(466,466,Bitmap.Config.ARGB_8888);
        java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1);int[] code={-1};
        registry.runOnMainSync(()->android.view.PixelCopy.request(activity.getWindow(),bitmap,result->{code[0]=result;done.countDown();},new android.os.Handler(android.os.Looper.getMainLooper())));
        try{
            assertTrue(done.await(5,java.util.concurrent.TimeUnit.SECONDS));assertEquals(0,code[0]);
            saveBitmap(bitmap,new File(target.getFilesDir(),"watchrss-rss-"+stage+"-window.png"));
            int titleInk=0,buttonInk=0;
            for(int y=35;y<110;y++)for(int x=120;x<346;x++)if(android.graphics.Color.red(bitmap.getPixel(x,y))>180)titleInk++;
            for(int y=135;y<175;y++)for(int x=50;x<170;x++)if(android.graphics.Color.red(bitmap.getPixel(x,y))>180)buttonInk++;
            try(FileOutputStream out=new FileOutputStream(new File(target.getFilesDir(),"watchrss-rss-"+stage+"-reference.json"))){out.write(("{\"titleInk\":"+titleInk+",\"originalButtonInk\":"+buttonInk+"}").getBytes(StandardCharsets.UTF_8));}
            assertTrue("reader title is missing: "+titleInk,titleInk>200);
            assertTrue("reader original button is missing: "+buttonInk,buttonInk>150);
        }finally{bitmap.recycle();}
    }
    private static Object playerField(Instrumentation registry,TextureView texture,String name) throws Exception {
        Field field=dev.podjs.runtime.PodVideoServices.class.getDeclaredField(name);field.setAccessible(true);Object player=nativeVideo(texture);Object[] result={null};
        registry.runOnMainSync(()->{try{result[0]=field.get(player);}catch(IllegalAccessException e){throw new RuntimeException(e);}});return result[0];
    }
    private static void verifyRssPlayerPan(Instrumentation registry,Activity activity,TextureView texture) throws Exception {
        tap(registry,activity,183,56);SystemClock.sleep(500);
        assertEquals("expanded",playerField(registry,texture,"scaleMode"));
        swipe(registry,activity,233,233,330,233,false);SystemClock.sleep(400);
        float x=((Number)playerField(registry,texture,"panX")).floatValue();
        assertTrue("RSS expanded video did not consume horizontal pan: "+x,x>20&&x<=208);
        assertEquals("playing",videoSnapshot(texture).getString("state"));
        tap(registry,activity,283,56);SystemClock.sleep(600);
        assertEquals(90f,((Number)playerField(registry,texture,"rotationDeg")).floatValue(),.1f);
        swipe(registry,activity,233,233,233,325,false);SystemClock.sleep(400);
        float y=((Number)playerField(registry,texture,"panY")).floatValue();
        assertTrue("RSS rotated video did not consume vertical pan: "+y,y>20&&y<=208);
        assertEquals("playing",videoSnapshot(texture).getString("state"));
    }
    private static void awaitPlayerReadyHud(Instrumentation registry,TextureView texture) throws Exception {
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;
        while(SystemClock.uptimeMillis()<deadline){
            Bitmap bitmap=getBitmap(registry,texture);boolean loading=false;
            try{for(int y=205;y<261;y++)for(int x=205;x<261;x++)if((bitmap.getPixel(x,y)&0xffffff)!=0)loading=true;}finally{bitmap.recycle();}
            if(!loading)return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("player loading indicator never cleared");
    }
    private static void captureVideoWindow(Instrumentation registry,Activity activity,TextureView texture,Context target) throws Exception {
        Bitmap bitmap=Bitmap.createBitmap(texture.getWidth(),texture.getHeight(),Bitmap.Config.ARGB_8888);java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1);int[] result={-1};
        registry.runOnMainSync(()->android.view.PixelCopy.request(activity.getWindow(),bitmap,code->{result[0]=code;done.countDown();},new android.os.Handler(android.os.Looper.getMainLooper())));
        try{assertTrue(done.await(5,java.util.concurrent.TimeUnit.SECONDS));assertEquals(android.view.PixelCopy.SUCCESS,result[0]);int pixel=bitmap.getPixel(bitmap.getWidth()/2,bitmap.getHeight()/2);assertTrue("window did not include decoded green video",android.graphics.Color.green(pixel)>android.graphics.Color.red(pixel)+60&&android.graphics.Color.green(pixel)>android.graphics.Color.blue(pixel)+30);saveBitmap(bitmap,new File(target.getFilesDir(),"watchrss-rss-media-window.png"));}finally{bitmap.recycle();}
    }
    @Test public void rssVideoEnclosureAndChannelBackgroundPlaybackFollowLifecycle() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject originalKv=readerKv(target);Object hiddenBackup=originalKv.opt("media.hidden-channels"),settingsBackup=originalKv.opt("watchrss.settings");
        originalKv.put("media.hidden-channels",new org.json.JSONArray().put("bili").put("douyin"));originalKv.remove("watchrss.settings");writeReaderKv(target,originalKv);
        Activity activity=null;long channelId=0,articleId=0;String sourceUrl="";String marker="codex-rss-media-"+SystemClock.uptimeMillis();org.json.JSONArray receipt=new org.json.JSONArray();
        try(ReaderImageServer server=new ReaderImageServer()){
            try(java.io.InputStream input=registry.getContext().getAssets().open("rss-video.mp4");java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream()){byte[] bytes=new byte[8192];for(int n;(n=input.read(bytes))!=-1;)output.write(bytes,0,n);server.videoBytes=output.toByteArray();}
            byte[] validVideo=server.videoBytes;server.videoBytes="invalid media for retry test".getBytes(StandardCharsets.US_ASCII);
            sourceUrl=server.url().replace("image.png","feed");
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try{
                database.execSQL("INSERT INTO channels(url,title,description,created_at,sort_order) VALUES(?,?,?,?, -9000000000000000)",new Object[]{sourceUrl,"媒体验证","简介",System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{sourceUrl})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,video_url,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?,?)",new Object[]{channelId,"附件视频","","",server.url().replace("image.png","post"),server.url().replace("image.png","video.mp4"),marker,System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{marker})){assertTrue(c.moveToFirst());articleId=c.getLong(0);}
            }finally{database.close();}
            Activity first=activity;registry.runOnMainSync(first::finish);SystemClock.sleep(700);
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));texture=awaitTextureView(activity);awaitHomeBitmap(registry,texture);
            tap(registry,activity,233,400);SystemClock.sleep(700);
            for(int mediaPass=0;mediaPass<6;mediaPass++){
                boolean background=mediaPass%2==1;
                tap(registry,activity,233,75);SystemClock.sleep(600);tapFirstChannelPill(registry,activity,texture);SystemClock.sleep(600);
                if(mediaPass>0)tap(registry,activity,374,336);
                awaitRssPixel(registry,texture,target,344,336,background?0xff6026:0x23272a);saveRssStage(registry,texture,target,background?"media-background-on":"media-background-off");
                Activity current=activity;registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(500);registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(500);
                tap(registry,activity,233,210);awaitReaderTop(registry,texture,target);awaitRssPixel(registry,texture,target,216,317,0xf5f5f5);SystemClock.sleep(700);saveRssStage(registry,texture,target,"media-enclosure");if(mediaPass>0)verifyReaderWindow(registry,activity,texture,target,"media-reader-pass-"+mediaPass);
                tap(registry,activity,233,220);
                if(mediaPass==0){
                    awaitVideoState(texture,"error");SystemClock.sleep(500);saveRssStage(registry,texture,target,"media-retry");
                    server.videoBytes=validVideo;server.videoDelayMillis=1000;tap(registry,activity,142,260);
                    PodRuntimeView loadingRuntime=(PodRuntimeView)texture;registry.runOnMainSync(()->loadingRuntime.setLifecycle(1));
                    long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;org.json.JSONObject loaded=null;
                    while(SystemClock.uptimeMillis()<deadline){loaded=videoSnapshot(texture);if(loaded.optLong("durationMs")>=29000)break;SystemClock.sleep(100);}
                    assertNotNull(loaded);assertTrue("deferred video never prepared",loaded.optLong("durationMs")>=29000);assertEquals("paused",loaded.getString("state"));
                    registry.runOnMainSync(()->loadingRuntime.setLifecycle(0));SystemClock.sleep(500);assertEquals("paused",videoSnapshot(texture).getString("state"));
                    awaitPlayerReadyHud(registry,texture);saveRssStage(registry,texture,target,"media-ready-paused");tap(registry,activity,233,416);SystemClock.sleep(600);saveRssStage(registry,texture,target,"media-after-play");server.videoDelayMillis=0;
                }
                org.json.JSONObject playing=awaitVideoState(texture,"playing");assertTrue("test media duration missing",playing.getLong("durationMs")>=29000);
                SystemClock.sleep(350);captureVideoWindow(registry,activity,texture,target);
                if(background)verifyRssPlayerPan(registry,activity,texture);
                PodRuntimeView runtime=(PodRuntimeView)texture;registry.runOnMainSync(()->runtime.setLifecycle(1));
                org.json.JSONObject paused=background?videoSnapshot(texture):awaitVideoState(texture,"paused");long p1=paused.getLong("positionMs");SystemClock.sleep(350);org.json.JSONObject after=videoSnapshot(texture);long p2=after.getLong("positionMs");
                if(background){assertEquals("playing",after.getString("state"));assertTrue("background-enabled playback stopped",p2>p1+150);}else{assertEquals("paused",after.getString("state"));assertTrue("background-disabled playback continued",Math.abs(p2-p1)<80);}
                receipt.put(new org.json.JSONObject().put("background",background).put("beforeMs",p1).put("afterMs",p2).put("state",after.getString("state")));
                registry.runOnMainSync(()->runtime.setLifecycle(0));registry.runOnMainSync(current::onBackPressed);awaitVideoState(texture,"stopped");awaitReaderTop(registry,texture,target);
                registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(600);
            }
            assertTrue(server.videoRequests>=2);
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
            try(Cursor c=database.rawQuery("SELECT continue_in_background FROM source_media_preferences WHERE channel_id=?",new String[]{Long.toString(channelId)})){assertTrue(c.moveToFirst());assertEquals(1,c.getInt(0));}finally{database.close();}
            try(FileOutputStream output=new FileOutputStream(new File(target.getFilesDir(),"watchrss-rss-media-lifecycle.json"))){output.write(receipt.toString(2).getBytes(StandardCharsets.UTF_8));}
        }finally{
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(700);}
            org.json.JSONObject latest=readerKv(target);latest.remove("watchrss.reader.progress."+articleId);if(hiddenBackup==null)latest.remove("media.hidden-channels");else latest.put("media.hidden-channels",hiddenBackup);if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);writeReaderKv(target,latest);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try{database.setForeignKeyConstraintsEnabled(true);database.execSQL("DELETE FROM channels WHERE id=? AND url=?",new Object[]{channelId,sourceUrl});}finally{database.close();}
        }
    }

    private static void tapFirstChannelPill(Instrumentation registry,Activity activity,TextureView texture) {
        Bitmap bitmap=getBitmap(registry,texture);assertNotNull(bitmap);int first=-1;
        try {for(int y=90;y<400;y++){boolean pill=true;for(int d=0;d<20;d++)if((bitmap.getPixel(100,y+d)&0xffffff)!=0x2a2a2a||(bitmap.getPixel(105,y+d)&0xffffff)!=0x2a2a2a){pill=false;break;}if(pill){first=y;break;}}}finally{bitmap.recycle();}
        assertTrue("channel detail settings pill missing",first>=0);tap(registry,activity,233,first+35);
    }

    @Test public void localImportClearRequiresConfirmationAndPreservesChannel() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject originalKv=readerKv(target);Object hiddenBackup=originalKv.opt("media.hidden-channels");
        originalKv.put("media.hidden-channels",new org.json.JSONArray().put("bili").put("douyin"));writeReaderKv(target,originalKv);
        Activity activity=null;long channelId=0;String marker="codex-channel-"+SystemClock.uptimeMillis();
        try(ReaderImageServer server=new ReaderImageServer()) {
            String sourceUrl="https://watchrss.local/import-epub/"+marker;
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            android.util.Log.i("WatchRssPixelMetrics","density="+activity.getResources().getDisplayMetrics().density+", scaled="+activity.getResources().getDisplayMetrics().scaledDensity+", width="+texture.getWidth());
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try {
                database.execSQL("INSERT INTO channels(url,title,description,created_at,sort_order) VALUES(?,?,?,?, -9000000000000000)",new Object[]{sourceUrl,"频道验证","简介",System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{sourceUrl})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
            database.execSQL("INSERT INTO articles(channel_id,title,content,dedup_key,fetched_at,is_saved) VALUES(?,'本地文章','正文','local-clear',?,1)",new Object[]{channelId,System.currentTimeMillis()});
                database.execSQL("INSERT INTO source_preferences VALUES(?,1,'custom')",new Object[]{channelId});
                database.execSQL("INSERT INTO article_original_chunks SELECT id,0,'原文缓存' FROM articles WHERE channel_id=?",new Object[]{channelId});
            }finally{database.close();}
            Activity closing=activity;registry.runOnMainSync(closing::finish);SystemClock.sleep(700);
            for(int iteration=0;iteration<1;iteration++) {
                activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                texture=awaitTextureView(activity);awaitHomeBitmap(registry,texture);
                tap(registry,activity,233,400);SystemClock.sleep(700); // first RSS channel below memo
                tap(registry,activity,233,75);SystemClock.sleep(700); // feed title -> channel details
                saveRssStage(registry,texture,target,"channel-detail");
                tapFirstChannelPill(registry,activity,texture);SystemClock.sleep(700); // settings below metadata
                saveRssStage(registry,texture,target,"local-channel-settings");
                
                SystemClock.sleep(700);awaitRssPixel(registry,texture,target,344,170,0xff6026);
                Bitmap switchBitmap=getBitmap(registry,texture);
                try {
                    int orangeMin=999,orangeMax=-1,thumbMin=999,thumbMax=-1;
                    for(int y=148;y<195;y++)for(int x=334;x<408;x++){
                        int color=switchBitmap.getPixel(x,y)&0xffffff;
                        if(color==0xff6026){orangeMin=Math.min(orangeMin,x);orangeMax=Math.max(orangeMax,x);}
                        if(color==0){thumbMin=Math.min(thumbMin,x);thumbMax=Math.max(thumbMax,x);}
                    }
                    assertEquals("switch track expanded beyond its 60px layout",60,orangeMax-orangeMin+1);
                    assertTrue("switch thumb overflowed rounded 13dp layout",thumbMax-thumbMin+1<=26);
                }finally{switchBitmap.recycle();}
                database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
                try(Cursor c=database.rawQuery("SELECT use_original_content FROM source_preferences WHERE channel_id=?",new String[]{Long.toString(channelId)})){assertTrue("original mode not persisted",c.moveToFirst());assertEquals(1,c.getInt(0));}finally{database.close();}
                
            }
            for(int confirm=0;confirm<2;confirm++) {
                tap(registry,activity,233,320);SystemClock.sleep(600);
                awaitRssPixel(registry,texture,target,300,350,0xe54d4d);saveRssStage(registry,texture,target,"local-clear-confirm");
                Bitmap dialog=getBitmap(registry,texture);
                try {
                    int firstLine=0,secondLine=0,edgeInk=0;
                    for(int y=185;y<225;y++)for(int x=40;x<426;x++)if(android.graphics.Color.red(dialog.getPixel(x,y))>120)firstLine++;
                    for(int y=231;y<271;y++)for(int x=40;x<426;x++)if(android.graphics.Color.red(dialog.getPixel(x,y))>120)secondLine++;
                    for(int y=175;y<275;y++)for(int x=0;x<30;x++)if(android.graphics.Color.red(dialog.getPixel(x,y))>120||android.graphics.Color.red(dialog.getPixel(465-x,y))>120)edgeInk++;
                    assertTrue("confirmation first line missing",firstLine>200);assertTrue("confirmation second line missing",secondLine>200);assertEquals("confirmation text clipped at screen edge",0,edgeInk);
                }finally{dialog.recycle();}
                database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
                try(Cursor c=database.rawQuery("SELECT count(*) FROM articles WHERE channel_id=?",new String[]{Long.toString(channelId)})){assertTrue(c.moveToFirst());assertEquals(1,c.getInt(0));}finally{database.close();}
                tap(registry,activity,confirm==0?165:301,384);SystemClock.sleep(800);
                awaitRssPixel(registry,texture,target,344,170,0xff6026);
            }
            saveRssStage(registry,texture,target,"local-clear-complete");
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
            try {
                try(Cursor c=database.rawQuery("SELECT count(*) FROM articles WHERE channel_id=?",new String[]{Long.toString(channelId)})){assertTrue(c.moveToFirst());assertEquals(0,c.getInt(0));}
                try(Cursor c=database.rawQuery("SELECT use_original_content,read_preset FROM source_preferences WHERE channel_id=?",new String[]{Long.toString(channelId)})){assertTrue(c.moveToFirst());assertEquals(1,c.getInt(0));assertEquals("custom",c.getString(1));}
                try(Cursor c=database.rawQuery("SELECT was_favorite FROM local_article_deletions WHERE channel_url=?",new String[]{sourceUrl})){assertTrue(c.moveToFirst());assertEquals(1,c.getInt(0));assertFalse(c.moveToNext());}
            }finally{database.close();}
        } finally {
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(700);}
            org.json.JSONObject latest=readerKv(target);if(hiddenBackup==null)latest.remove("media.hidden-channels");else latest.put("media.hidden-channels",hiddenBackup);writeReaderKv(target,latest);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try{database.setForeignKeyConstraintsEnabled(true);database.execSQL("DELETE FROM local_article_deletions WHERE channel_url=(SELECT url FROM channels WHERE id=?)",new Object[]{channelId});database.execSQL("DELETE FROM channels WHERE id=?",new Object[]{channelId});}finally{database.close();}
        }
    }

    @Test public void channelSettingsPersistsAndDeleteRequiresConfirmation() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject originalKv=readerKv(target);Object hiddenBackup=originalKv.opt("media.hidden-channels");
        originalKv.put("media.hidden-channels",new org.json.JSONArray().put("bili").put("douyin"));writeReaderKv(target,originalKv);
        Activity activity=null;long channelId=0;String marker="codex-channel-"+SystemClock.uptimeMillis();
        try(ReaderImageServer server=new ReaderImageServer()) {
            String sourceUrl=server.url().replace("image.png","feed");
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try {
                database.execSQL("INSERT INTO channels(url,title,description,created_at,sort_order) VALUES(?,?,?,?, -9000000000000000)",new Object[]{sourceUrl,"频道验证","简介",System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{sourceUrl})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
            }finally{database.close();}
            Activity closing=activity;registry.runOnMainSync(closing::finish);SystemClock.sleep(700);
            for(int iteration=0;iteration<2;iteration++) {
                activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                texture=awaitTextureView(activity);awaitHomeBitmap(registry,texture);
                tap(registry,activity,233,400);SystemClock.sleep(700); // first RSS channel below memo
                tap(registry,activity,233,75);SystemClock.sleep(700); // feed title -> channel details
                saveRssStage(registry,texture,target,"channel-detail");
                tapFirstChannelPill(registry,activity,texture);SystemClock.sleep(700); // settings below metadata
                saveRssStage(registry,texture,target,"channel-settings");
                if(iteration==0)tap(registry,activity,374,170);
                SystemClock.sleep(700);awaitRssPixel(registry,texture,target,344,170,0xff6026);
                database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
                try(Cursor c=database.rawQuery("SELECT use_original_content FROM source_preferences WHERE channel_id=?",new String[]{Long.toString(channelId)})){assertTrue("original mode not persisted",c.moveToFirst());assertEquals(1,c.getInt(0));}finally{database.close();}
                if(iteration==0){Activity previous=activity;registry.runOnMainSync(previous::finish);SystemClock.sleep(700);}
            }
            tap(registry,activity,233,320);SystemClock.sleep(600);saveRssStage(registry,texture,target,"channel-confirm");
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
            try(Cursor c=database.rawQuery("SELECT count(*) FROM channels WHERE id=?",new String[]{Long.toString(channelId)})){assertTrue(c.moveToFirst());assertEquals(1,c.getInt(0));}finally{database.close();}
            tap(registry,activity,165,384);SystemClock.sleep(600); // cancel preserves channel and returns to settings
            awaitRssPixel(registry,texture,target,344,170,0xff6026);
            tap(registry,activity,233,320);SystemClock.sleep(600);
            tap(registry,activity,301,384);SystemClock.sleep(800);awaitHomeBitmap(registry,texture);
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
            try(Cursor c=database.rawQuery("SELECT count(*) FROM channels WHERE id=?",new String[]{Long.toString(channelId)})){assertTrue(c.moveToFirst());assertEquals(0,c.getInt(0));}finally{database.close();}
        } finally {
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(700);}
            org.json.JSONObject latest=readerKv(target);if(hiddenBackup==null)latest.remove("media.hidden-channels");else latest.put("media.hidden-channels",hiddenBackup);writeReaderKv(target,latest);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try{database.setForeignKeyConstraintsEnabled(true);database.execSQL("DELETE FROM channels WHERE id=?",new Object[]{channelId});}finally{database.close();}
        }
    }

    @Test public void feedOriginalPrefetchWaitsForSettledVisibilityAndUsesBackgroundRefresh() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject originalKv=readerKv(target);Object hiddenBackup=originalKv.opt("media.hidden-channels");
        originalKv.put("media.hidden-channels",new org.json.JSONArray().put("bili").put("douyin"));writeReaderKv(target,originalKv);
        Activity activity=null;long channelId=0;String marker="codex-prefetch-"+SystemClock.uptimeMillis();String sourceUrl="";
        try(ReaderImageServer server=new ReaderImageServer()) {
            sourceUrl=server.url().replace("image.png","feed");
            StringBuilder xml=new StringBuilder("<rss><channel><title>预取验证</title><description>简介</description>");
            for(int i=1;i<=8;i++)xml.append("<item><guid>").append(marker).append("-").append(i).append("</guid><title>预取文章").append(i).append("</title><link>").append(server.url().replace("image.png","article?i="+i)).append("</link><description>RSS保留摘要</description></item>");
            server.feedXml=xml.append("</channel></rss>").toString();server.feedDelayMillis=1200;
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try {
                database.execSQL("INSERT INTO channels(url,title,description,created_at,sort_order) VALUES(?,?,?,?, -9000000000000000)",new Object[]{sourceUrl,"预取验证","简介",System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{sourceUrl})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                for(int i=1;i<=8;i++)database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?)",new Object[]{channelId,"预取文章"+i,"RSS保留摘要","<p>RSS保留摘要</p>",server.url().replace("image.png","article?i="+i),marker+"-"+i,i});
            }finally{database.close();}
            Activity closing=activity;registry.runOnMainSync(closing::finish);SystemClock.sleep(700);
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));texture=awaitTextureView(activity);awaitHomeBitmap(registry,texture);
            tap(registry,activity,233,400);SystemClock.sleep(900);assertEquals("disabled source prefetched",0,server.originalRequests);
            tap(registry,activity,233,75);SystemClock.sleep(600);tapFirstChannelPill(registry,activity,texture);SystemClock.sleep(600);
            tap(registry,activity,374,170);awaitRssPixel(registry,texture,target,344,170,0xff6026);
            SystemClock.sleep(1800);assertEquals(1,server.feedRequests);assertEquals("hidden feed prefetched while settings is active",0,server.originalRequests);
            Activity current=activity;registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(600);registry.runOnMainSync(current::onBackPressed);
            long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;int cached=0;
            while(SystemClock.uptimeMillis()<deadline){
                database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
                try(Cursor c=database.rawQuery("SELECT count(*) FROM article_original_meta m JOIN articles a ON a.id=m.article_id WHERE a.channel_id=?",new String[]{Long.toString(channelId)})){assertTrue(c.moveToFirst());cached=c.getInt(0);}finally{database.close();}
                if(cached>=3)break;SystemClock.sleep(100);
            }
            assertEquals("only the first three viewport articles should prefetch",3,cached);SystemClock.sleep(800);assertEquals(3,server.originalRequests);saveRssStage(registry,texture,target,"prefetch-settled");
            // A refresh without an RSS image must retain the separately cached original preview.
            swipe(registry,activity,233,140,233,350,false);
            deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;while(SystemClock.uptimeMillis()<deadline&&server.feedRequests<2)SystemClock.sleep(100);
            assertEquals(2,server.feedRequests);SystemClock.sleep(2300);assertEquals("refresh re-downloaded cached originals",3,server.originalRequests);
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
            try(Cursor c=database.rawQuery("SELECT count(*) FROM article_previews p JOIN article_original_previews o ON o.article_id=p.article_id JOIN articles a ON a.id=p.article_id WHERE a.channel_id=? AND p.image_url=o.image_url AND p.image_url<>''",new String[]{Long.toString(channelId)})){assertTrue(c.moveToFirst());assertEquals("refresh lost original preview images",3,c.getInt(0));}finally{database.close();}
            saveRssStage(registry,texture,target,"prefetch-refreshed");
            int before=server.originalRequests;long downTime=SystemClock.uptimeMillis();dispatch(registry,activity,downTime,MotionEvent.ACTION_DOWN,233,430);
            for(int step=1;step<=8;step++)dispatch(registry,activity,downTime,MotionEvent.ACTION_MOVE,233,430-step*50);
            SystemClock.sleep(700);assertEquals("prefetch ran during drag",before,server.originalRequests);
            dispatch(registry,activity,downTime,MotionEvent.ACTION_UP,233,30);
            deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;while(SystemClock.uptimeMillis()<deadline&&server.originalRequests==before)SystemClock.sleep(100);
            assertTrue("newly visible settled rows were not prefetched",server.originalRequests>before);assertTrue("entire source was prefetched",server.originalRequests<8);
            SystemClock.sleep(1000);saveRssStage(registry,texture,target,"prefetch-scrolled");
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);
            try(Cursor c=database.rawQuery("SELECT count(*) FROM articles WHERE channel_id=? AND is_read=0",new String[]{Long.toString(channelId)})){assertTrue(c.moveToFirst());assertEquals("prefetch marked articles read",8,c.getInt(0));}finally{database.close();}
        }finally{
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(700);}
            org.json.JSONObject latest=readerKv(target);if(hiddenBackup==null)latest.remove("media.hidden-channels");else latest.put("media.hidden-channels",hiddenBackup);writeReaderKv(target,latest);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try{database.setForeignKeyConstraintsEnabled(true);database.execSQL("DELETE FROM channels WHERE id=? AND url=?",new Object[]{channelId,sourceUrl});}finally{database.close();}
        }
    }

    private static final class SummaryServer implements AutoCloseable {
        final java.net.ServerSocket server=new java.net.ServerSocket(0);
        final java.util.concurrent.ExecutorService workers=java.util.concurrent.Executors.newCachedThreadPool();
        volatile int summaries=0,refreshes=0,status=402;volatile long delay=0;
        volatile org.json.JSONObject body=new org.json.JSONObject();volatile String authorization="";volatile Throwable failure;volatile boolean cancellationExpected=false;
        SummaryServer() throws Exception {
            Thread accept=new Thread(()->{while(!server.isClosed())try{java.net.Socket socket=server.accept();workers.submit(()->serve(socket));}catch(Exception ignored){}});accept.setDaemon(true);accept.start();
        }
        String base(){return "http://127.0.0.1:"+server.getLocalPort();}
        void serve(java.net.Socket socket){try(java.net.Socket client=socket){
            client.setSoTimeout(5000);java.io.InputStream input=client.getInputStream();java.io.ByteArrayOutputStream header=new java.io.ByteArrayOutputStream();int state=0,b;
            while((b=input.read())!=-1){header.write(b);state=(state==0&&b=='\r')?1:(state==1&&b=='\n')?2:(state==2&&b=='\r')?3:(state==3&&b=='\n')?4:0;if(state==4)break;if(header.size()>16384)throw new java.io.IOException("header overflow");}
            String headers=header.toString("US-ASCII");int length=0;String auth="";
            for(String line:headers.split("\r\n")){String lower=line.toLowerCase(java.util.Locale.ROOT);if(lower.startsWith("content-length:"))length=Integer.parseInt(line.substring(line.indexOf(':')+1).trim());if(lower.startsWith("authorization:"))auth=line.substring(line.indexOf(':')+1).trim();}
            byte[] bytes=new byte[length];int read=0;while(read<length){int n=input.read(bytes,read,length-read);if(n<0)throw new java.io.IOException("truncated body");read+=n;}
            org.json.JSONObject request=new org.json.JSONObject(new String(bytes,StandardCharsets.UTF_8));int code;String response;
            if(headers.startsWith("POST /functions/v1/account/watch-token/refresh ")){refreshes++;assertEquals("fixture-refresh",request.getString("refreshToken"));code=200;response=new org.json.JSONObject().put("watchAccessToken","fixture-renewed").put("watchRefreshToken","fixture-refresh").put("accessTokenExpiresAt",System.currentTimeMillis()+3600000).put("refreshTokenExpiresAt",System.currentTimeMillis()+7200000).toString();}
            else if(headers.startsWith("POST /api/v1/llm/default-model/article-summary ")){body=request;authorization=auth;summaries++;code=auth.equals("Bearer fixture-initial")?401:status;response=code==200?"{\"text\":\"AI验证总结：已读取缓存原文。\",\"model\":\"fixture-summary-model\",\"usage\":{\"inputTokens\":12,\"outputTokens\":4,\"totalTokens\":16}}":"{\"detail\":\"fixture error\"}";if(delay>0)SystemClock.sleep(delay);}
            else throw new java.io.IOException("unexpected path");
            byte[] payload=response.getBytes(StandardCharsets.UTF_8);java.io.OutputStream output=client.getOutputStream();output.write(("HTTP/1.1 "+code+" Response\r\nContent-Type: application/json\r\nContent-Length: "+payload.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));output.write(payload);output.flush();
        }catch(Throwable error){if(!(cancellationExpected&&error instanceof java.io.IOException))failure=error;}}
        public void close() throws Exception {server.close();workers.shutdownNow();workers.awaitTermination(2,java.util.concurrent.TimeUnit.SECONDS);}
    }
    private static int summaryUsageCount(Context target) {
        try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);Cursor c=database.rawQuery("SELECT count(*) FROM llm_token_usage WHERE model='fixture-summary-model'",null)){assertTrue(c.moveToFirst());return c.getInt(0);}
    }
    private static void awaitSummary(java.util.function.BooleanSupplier condition) {
        long deadline=SystemClock.uptimeMillis()+TIMEOUT_MS;while(!condition.getAsBoolean()&&SystemClock.uptimeMillis()<deadline)SystemClock.sleep(100);assertTrue("summary condition timed out",condition.getAsBoolean());
    }
    private static org.json.JSONArray semanticNodes(Instrumentation registry, TextureView texture) throws Exception {
        long runtime=host((PodRuntimeView)texture);final byte[][] bytes=new byte[1][];
        registry.runOnMainSync(()->{try {
            java.lang.reflect.Method enable=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilityEnabled",long.class,boolean.class),frame=PodRuntimeView.class.getDeclaredMethod("nativeFrame",long.class),snapshot=PodRuntimeView.class.getDeclaredMethod("nativeAccessibilitySnapshot",long.class,long[].class);
            enable.setAccessible(true);frame.setAccessible(true);snapshot.setAccessible(true);
            Field enabled=PodRuntimeView.class.getDeclaredField("accessibilityEnabled");enabled.setAccessible(true);boolean original=enabled.getBoolean(texture);
            try {enable.invoke(null,runtime,false);enable.invoke(null,runtime,true);frame.invoke(null,runtime);bytes[0]=(byte[])snapshot.invoke(null,runtime,new long[3]);}
            finally {enable.invoke(null,runtime,original);}
        }catch(Exception e){throw new AssertionError(e);}});
        assertNotNull("semantic snapshot missing",bytes[0]);return new org.json.JSONObject(new String(bytes[0],java.nio.charset.StandardCharsets.UTF_8)).getJSONArray("nodes");
    }
    private static org.json.JSONObject visibleLabel(Instrumentation registry,TextureView texture,String label) throws Exception {
        org.json.JSONArray nodes=semanticNodes(registry,texture);
        for(int i=nodes.length()-1;i>=0;i--){org.json.JSONObject node=nodes.getJSONObject(i),bounds=node.optJSONObject("bounds");if(bounds!=null&&node.optString("label").replaceAll("\\s+","").startsWith(label.replaceAll("\\s+",""))&&bounds.optInt("top")>=24&&bounds.optInt("bottom")<=216&&bounds.optInt("bottom")>bounds.optInt("top"))return bounds;}
        return null;
    }
    private static org.json.JSONObject findSettingsLabel(Instrumentation registry,Activity activity,TextureView texture,String label) throws Exception {
        for(int i=0;i<22;i++){org.json.JSONObject bounds=visibleLabel(registry,texture,label);if(bounds!=null){SystemClock.sleep(800);bounds=visibleLabel(registry,texture,label);if(bounds!=null)return bounds;}swipe(registry,activity,233,380,233,150,false);SystemClock.sleep(800);}
        throw new AssertionError("visible label missing: "+label+" nodes="+semanticNodes(registry,texture));
    }
    private static void tapSettingsLabel(Instrumentation registry,Activity activity,TextureView texture,String label,boolean toggle) throws Exception {
        org.json.JSONObject bounds=findSettingsLabel(registry,activity,texture,label);
        tap(registry,activity,toggle?390:(bounds.getInt("left")+bounds.getInt("right")),(bounds.getInt("top")+bounds.getInt("bottom")));SystemClock.sleep(400);
    }
    private static int allUsageCount(Context target) {
        try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);Cursor c=database.rawQuery("SELECT COUNT(*) FROM llm_token_usage",null)){assertTrue(c.moveToFirst());return c.getInt(0);}
    }
    private static void tapExactPresetLabel(Instrumentation registry,Activity activity,TextureView texture,String label) throws Exception {
        for(int attempt=0;attempt<16;attempt++) {
            org.json.JSONArray nodes=semanticNodes(registry,texture);
            for(int i=nodes.length()-1;i>=0;i--) {
                org.json.JSONObject node=nodes.getJSONObject(i),bounds=node.optJSONObject("bounds");
                if(bounds!=null && node.optString("label").replaceAll("\\s+","").equals(label.replaceAll("\\s+","")) && bounds.getInt("top")>=24 && bounds.getInt("bottom")<=216) {
                    tap(registry,activity,bounds.getInt("left")+bounds.getInt("right"),bounds.getInt("top")+bounds.getInt("bottom"));SystemClock.sleep(500);return;
                }
            }
            swipe(registry,activity,233,350,233,220,false);SystemClock.sleep(700);
        }
        throw new AssertionError("preset label missing: "+label+" "+semanticNodes(registry,texture));
    }
    private static void scrollPresetTop(Instrumentation registry,Activity activity) throws Exception {
        for(int i=0;i<5;i++){swipe(registry,activity,233,120,233,380,false);SystemClock.sleep(100);}SystemClock.sleep(800);
    }
    private static android.app.TimePickerDialog activeTimeDialog(Instrumentation registry,TextureView texture) throws Exception {
        android.app.TimePickerDialog[] result=new android.app.TimePickerDialog[1];
        long deadline=SystemClock.uptimeMillis()+5000;
        while(result[0]==null && SystemClock.uptimeMillis()<deadline) {
            registry.runOnMainSync(()->{try {
                Field servicesField=PodRuntimeView.class.getDeclaredField("services");servicesField.setAccessible(true);Object services=servicesField.get(texture);
                Field requests=services.getClass().getDeclaredField("requests");requests.setAccessible(true);
                for(Object request:((java.util.Map<?,?>)requests.get(services)).values()) {Field field=request.getClass().getDeclaredField("dialog");field.setAccessible(true);Object dialog=field.get(request);if(dialog instanceof android.app.TimePickerDialog && ((android.app.TimePickerDialog)dialog).isShowing())result[0]=(android.app.TimePickerDialog)dialog;}
            }catch(Exception error){throw new AssertionError(error);}});SystemClock.sleep(50);
        }
        assertNotNull("time picker did not open",result[0]);return result[0];
    }
    @Test public void readerPresetsSelectPersistScheduleAndRenderLightTheme() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject old=readerKv(target);Object presetBackup=old.opt("watchrss.reader-presets"),settingsBackup=old.opt("watchrss.settings");old.remove("watchrss.reader-presets");old.remove("watchrss.settings");writeReaderKv(target,old);
        Activity activity=null;long articleId=0,channelId=0;String marker="reader-presets-"+SystemClock.uptimeMillis();
        try {
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            org.json.JSONObject initial=readerKv(target).getJSONObject("watchrss.reader-presets");String records=initial.getJSONArray("records").toString();assertEquals(2,initial.getJSONArray("records").length());
            tap(registry,activity,233,90);SystemClock.sleep(600);tapSettingsLabel(registry,activity,texture,"设置",false);tapSettingsLabel(registry,activity,texture,"阅读器与预设",false);SystemClock.sleep(600);saveRssStage(registry,texture,target,"reader-presets-dark");
            tapSettingsLabel(registry,activity,texture,"迁移设置",false);saveRssStage(registry,texture,target,"reader-presets-menu");Activity menuActivity=activity;registry.runOnMainSync(menuActivity::onBackPressed);SystemClock.sleep(400);assertFalse(readerKv(target).getJSONObject("watchrss.reader-presets").getJSONObject("selection").getBoolean("darkFollowsLight"));
            tapSettingsLabel(registry,activity,texture,"迁移设置",false);tapExactPresetLabel(registry,activity,texture,"跟随浅色");assertTrue(readerKv(target).getJSONObject("watchrss.reader-presets").getJSONObject("selection").getBoolean("darkFollowsLight"));
            tapSettingsLabel(registry,activity,texture,"跟随浅色",false);tapExactPresetLabel(registry,activity,texture,"迁移设置 · 正文预览");assertFalse(readerKv(target).getJSONObject("watchrss.reader-presets").getJSONObject("selection").getBoolean("darkFollowsLight"));scrollPresetTop(registry,activity);
            tapExactPresetLabel(registry,activity,texture,"浅色");assertEquals("LIGHT",readerKv(target).getJSONObject("watchrss.reader-presets").getJSONObject("selection").getString("mode"));scrollPresetTop(registry,activity);saveRssStage(registry,texture,target,"reader-presets-light");
            tapExactPresetLabel(registry,activity,texture,"自动");assertEquals("SYSTEM",readerKv(target).getJSONObject("watchrss.reader-presets").getJSONObject("selection").getString("mode"));scrollPresetTop(registry,activity);saveRssStage(registry,texture,target,"reader-presets-system");
            tapSettingsLabel(registry,activity,texture,"浅色开始",false);android.app.TimePickerDialog cancelled=activeTimeDialog(registry,texture);registry.runOnMainSync(cancelled::cancel);SystemClock.sleep(500);assertEquals(420,readerKv(target).getJSONObject("watchrss.reader-presets").getJSONObject("schedule").getInt("lightStartMinutes"));
            tapSettingsLabel(registry,activity,texture,"浅色开始",false);android.app.TimePickerDialog accepted=activeTimeDialog(registry,texture);registry.runOnMainSync(()->{accepted.updateTime(8,15);accepted.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick();});SystemClock.sleep(500);assertEquals(495,readerKv(target).getJSONObject("watchrss.reader-presets").getJSONObject("schedule").getInt("lightStartMinutes"));saveRssStage(registry,texture,target,"reader-presets-schedule");
            scrollPresetTop(registry,activity);tapSettingsLabel(registry,activity,texture,"下载手机端App",false);saveRssStage(registry,texture,target,"reader-presets-download");Activity current=activity;registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(500);
            tapExactPresetLabel(registry,activity,texture,"浅色");assertEquals(records,readerKv(target).getJSONObject("watchrss.reader-presets").getJSONArray("records").toString());
            registry.runOnMainSync(current::finish);SystemClock.sleep(600);
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)) {
                database.execSQL("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)",new Object[]{"https://example.test/"+marker,"预设验证",System.currentTimeMillis()});try(Cursor cursor=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://example.test/"+marker})){assertTrue(cursor.moveToFirst());channelId=cursor.getLong(0);}
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,1)",new Object[]{channelId,"预设验证文章","正文","<p>阅读器浅色背景验证。保留阅读位置。</p>","https://example.test/preset-article",marker,System.currentTimeMillis()});try(Cursor cursor=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{marker})){assertTrue(cursor.moveToFirst());articleId=cursor.getLong(0);}
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000004)",new Object[]{articleId,System.currentTimeMillis()});
            }
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));texture=awaitTextureView(activity);openFirstSavedReader(registry,activity,texture,target,false);SystemClock.sleep(1000);saveRssStage(registry,texture,target,"reader-presets-light-article");
            Bitmap bitmap=getBitmap(registry,texture);int background=0;try{for(int y=100;y<366;y++)for(int x=100;x<366;x++)if((bitmap.getPixel(x,y)&0xffffff)==0xf8f3ec)background++;assertTrue("light preset did not reach article renderer",background>20000);int action=bitmap.getPixel(40,150);assertTrue("light original-content action kept a dark surface",android.graphics.Color.red(action)>=250 && android.graphics.Color.green(action)>=250 && android.graphics.Color.blue(action)>=250);}finally{bitmap.recycle();}
            assertEquals("LIGHT",readerKv(target).getJSONObject("watchrss.reader-presets").getJSONObject("selection").getString("mode"));
            Activity lightActivity=activity;registry.runOnMainSync(lightActivity::finish);SystemClock.sleep(600);
            java.util.Calendar calendar=java.util.Calendar.getInstance();int localMinutes=calendar.get(java.util.Calendar.HOUR_OF_DAY)*60+calendar.get(java.util.Calendar.MINUTE);
            org.json.JSONObject automatic=readerKv(target),automaticState=automatic.getJSONObject("watchrss.reader-presets");automaticState.getJSONObject("selection").put("mode","SYSTEM");automaticState.getJSONObject("schedule").put("lightStartMinutes",(localMinutes+1438)%1440).put("darkStartMinutes",(localMinutes+8)%1440);writeReaderKv(target,automatic);
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));texture=awaitTextureView(activity);openFirstSavedReader(registry,activity,texture,target,false);SystemClock.sleep(1000);saveRssStage(registry,texture,target,"reader-presets-auto-article");
            bitmap=getBitmap(registry,texture);background=0;try{for(int y=100;y<366;y++)for(int x=100;x<366;x++)if((bitmap.getPixel(x,y)&0xffffff)==0xf8f3ec)background++;assertTrue("automatic preset does not agree with the watch's local clock",background>20000);}finally{bitmap.recycle();}
        } finally {
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(700);}
            org.json.JSONObject latest=readerKv(target);if(presetBackup==null)latest.remove("watchrss.reader-presets");else latest.put("watchrss.reader-presets",presetBackup);if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);if(articleId>0)latest.remove("watchrss.reader.progress."+articleId);writeReaderKv(target,latest);
            if(channelId>0)try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){database.execSQL("DELETE FROM article_saved_states WHERE article_id=?",new Object[]{articleId});database.execSQL("DELETE FROM articles WHERE channel_id=?",new Object[]{channelId});database.execSQL("DELETE FROM channels WHERE id=?",new Object[]{channelId});}
        }
    }
    @Test public void aiSettingsPersistPresetAndUsageClearRequiresConfirmation() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject kv=readerKv(target);Object settingsBackup=kv.opt("watchrss.settings");kv.remove("watchrss.settings");writeReaderKv(target,kv);
        dev.podjs.runtime.PodDeviceServices secure=new dev.podjs.runtime.PodDeviceServices(target);org.json.JSONObject key=new org.json.JSONObject().put("key","state_json"),accountBackup=secure.execute("secure.get",key);
        secure.execute("secure.set",new org.json.JSONObject().put("key","state_json").put("value",new org.json.JSONObject().put("userId","settings-fixture").put("watchDeviceToken","settings-fixture-token").toString()));
        Activity activity=null;String marker="ai-settings-"+SystemClock.uptimeMillis();int initial=-1;
        try {
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            initial=allUsageCount(target);long day=System.currentTimeMillis()/86400000L*86400000L;
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){for(int i=0;i<3;i++)database.execSQL("INSERT INTO llm_token_usage(provider,model,request_id,usage_json,created_at) VALUES(?,?,?,?,?)",new Object[]{"WatchRSS",i==0?"fixture-a":"fixture-b",marker+i,new org.json.JSONObject().put("prompt_tokens",(i+1)*12).put("completion_tokens",(i+1)*4).put("total_tokens",(i+1)*16).toString(),day-i*86400000L});}
            tap(registry,activity,233,88);SystemClock.sleep(500);scrollProfileForSettings(registry,activity);tap(registry,activity,233,122);SystemClock.sleep(600);
            tapSettingsLabel(registry,activity,texture,"AI 总结功能",true);assertFalse(readerKv(target).getJSONObject("watchrss.settings").getBoolean("llmEnabled"));saveRssStage(registry,texture,target,"ai-settings-disabled");
            tapSettingsLabel(registry,activity,texture,"AI 总结功能",true);assertTrue(readerKv(target).getJSONObject("watchrss.settings").getBoolean("llmEnabled"));
            tapSettingsLabel(registry,activity,texture,"进入详情自动开始总结",true);assertTrue(readerKv(target).getJSONObject("watchrss.settings").getBoolean("llmAutoSummarize"));saveRssStage(registry,texture,target,"ai-settings-enabled");
            tapSettingsLabel(registry,activity,texture,"提示词预设",false);saveRssStage(registry,texture,target,"ai-preset");tapSettingsLabel(registry,activity,texture,"关键要点",false);assertEquals(2,readerKv(target).getJSONObject("watchrss.settings").getInt("llmPromptPreset"));saveRssStage(registry,texture,target,"ai-preset-selected");
            Activity current=activity;registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(500);
            tapSettingsLabel(registry,activity,texture,"显示 Token 用量",true);assertTrue(readerKv(target).getJSONObject("watchrss.settings").getBoolean("llmShowTokenUsage"));
            tapSettingsLabel(registry,activity,texture,"Token 消耗统计",false);SystemClock.sleep(600);saveRssStage(registry,texture,target,"ai-usage");
            swipe(registry,activity,233,380,233,150,false);SystemClock.sleep(800);saveRssStage(registry,texture,target,"ai-usage-bars");swipe(registry,activity,233,380,233,150,false);SystemClock.sleep(800);saveRssStage(registry,texture,target,"ai-usage-providers");
            tapSettingsLabel(registry,activity,texture,"清空记录",false);saveRssStage(registry,texture,target,"ai-usage-confirm-populated");assertEquals(initial+3,allUsageCount(target));
            tapSettingsLabel(registry,activity,texture,"取消",false);assertEquals(initial+3,allUsageCount(target));
            tapSettingsLabel(registry,activity,texture,"清空记录",false);registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(400);assertEquals(initial+3,allUsageCount(target));
            if(initial==0){tapSettingsLabel(registry,activity,texture,"清空记录",false);tapSettingsLabel(registry,activity,texture,"清空",false);assertEquals(0,allUsageCount(target));for(int i=0;i<4;i++){swipe(registry,activity,233,120,233,380,false);SystemClock.sleep(200);}SystemClock.sleep(800);saveRssStage(registry,texture,target,"ai-usage-empty");tapSettingsLabel(registry,activity,texture,"清空记录",false);saveRssStage(registry,texture,target,"ai-usage-confirm");registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(300);}
            else android.util.Log.i("WatchRssAiSettings","existing user usage preserved; destructive confirmation skipped");
            tapSettingsLabel(registry,activity,texture,"返回",false);SystemClock.sleep(300);
            assertEquals(2,readerKv(target).getJSONObject("watchrss.settings").getInt("llmPromptPreset"));
        } finally {
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(700);}
            if(accountBackup.optBoolean("exists"))secure.execute("secure.set",new org.json.JSONObject().put("key","state_json").put("value",accountBackup.getString("value")));else secure.execute("secure.delete",key);secure.close();
            org.json.JSONObject latest=readerKv(target);
            if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);writeReaderKv(target,latest);
            if(initial>=0)try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){database.execSQL("DELETE FROM llm_token_usage WHERE request_id LIKE ?",new Object[]{marker+"%"});}
        }
    }

    @Test public void readerSummaryRefreshesRetriesFoldsAndPreservesData() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject oldKv=readerKv(target);Object settingsBackup=oldKv.opt("watchrss.settings");oldKv.remove("watchrss.settings");writeReaderKv(target,oldKv);
        dev.podjs.runtime.PodDeviceServices secure=new dev.podjs.runtime.PodDeviceServices(target);org.json.JSONObject key=new org.json.JSONObject().put("key","state_json"),accountBackup=secure.execute("secure.get",key);secure.execute("secure.delete",key);
        Activity activity=null;long articleId=0,channelId=0;String marker="codex-summary-"+SystemClock.uptimeMillis();
        try(SummaryServer server=new SummaryServer()){
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){
                database.execSQL("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)",new Object[]{"https://example.test/"+marker,"总结验证",System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://example.test/"+marker})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,1)",new Object[]{channelId,"原文验证文章","RSS保留摘要","<p>RSS保留摘要</p>","https://example.test/article",marker,System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{marker})){assertTrue(c.moveToFirst());articleId=c.getLong(0);}
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000003)",new Object[]{articleId,System.currentTimeMillis()});
            }
            int usageBefore=summaryUsageCount(target);openFirstSavedReader(registry,activity,texture,target);SystemClock.sleep(500);saveRssStage(registry,texture,target,"summary-idle");
            tap(registry,activity,233,150);SystemClock.sleep(1000);assertEquals(0,server.summaries);awaitRssPixel(registry,texture,target,60,100,0x000000);saveRssStage(registry,texture,target,"summary-no-account");
            Bitmap errorBitmap=getBitmap(registry,texture);try{assertNotNull(errorBitmap);int pink=0;for(int y=235;y<290;y++)for(int x=30;x<435;x++){int color=errorBitmap.getPixel(x,y);if(android.graphics.Color.red(color)>210&&android.graphics.Color.green(color)>80&&android.graphics.Color.green(color)<175)pink++;}assertTrue("summary error paragraph missing",pink>50);}finally{if(errorBitmap!=null)errorBitmap.recycle();}
            tap(registry,activity,233,150);SystemClock.sleep(300);
            org.json.JSONObject account=new org.json.JSONObject().put("userId",marker).put("watchDeviceToken","fixture-initial").put("tokenExpiresAtMillis",System.currentTimeMillis()+3600000).put("watchRefreshToken","fixture-refresh").put("refreshTokenExpiresAtMillis",System.currentTimeMillis()+7200000).put("backendBaseUrl",server.base());
            secure.execute("secure.set",new org.json.JSONObject().put("key","state_json").put("value",account.toString()));
            tap(registry,activity,233,150);awaitSummary(()->server.summaries==2);SystemClock.sleep(500);assertEquals(1,server.refreshes);assertEquals("Bearer fixture-renewed",server.authorization);saveRssStage(registry,texture,target,"summary-paid-error");assertEquals(usageBefore,summaryUsageCount(target));
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){database.execSQL("INSERT INTO article_original_meta VALUES(?,?,?)",new Object[]{articleId,"https://example.test/article",System.currentTimeMillis()});database.execSQL("INSERT INTO article_original_chunks VALUES(?,0,'<p>缓存原文 &amp; 内容</p>')",new Object[]{articleId});}
            server.status=200;server.delay=1000;tap(registry,activity,233,260);awaitSummary(()->server.summaries==3);saveRssStage(registry,texture,target,"summary-generating");tap(registry,activity,233,150);awaitSummary(()->summaryUsageCount(target)==usageBefore+1);SystemClock.sleep(250);saveRssStage(registry,texture,target,"summary-folded");
            assertEquals("缓存原文 & 内容",server.body.getString("content"));assertEquals("原文验证文章",server.body.getString("title"));assertEquals(1,server.body.getInt("promptPreset"));assertFalse(server.body.getBoolean("stream"));
            tap(registry,activity,233,150);SystemClock.sleep(400);saveRssStage(registry,texture,target,"summary-done");tap(registry,activity,233,150);SystemClock.sleep(150);tap(registry,activity,233,150);SystemClock.sleep(300);assertEquals("fold/unfold regenerated summary",3,server.summaries);
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READONLY);Cursor c=database.rawQuery("SELECT content,is_saved,(SELECT saved FROM article_saved_states WHERE article_id=articles.id AND save_type='favorite') FROM articles WHERE id=?",new String[]{Long.toString(articleId)})){assertTrue(c.moveToFirst());assertEquals("<p>RSS保留摘要</p>",c.getString(0));assertEquals(1,c.getInt(1));assertEquals(1,c.getInt(2));}
            if(server.failure!=null)throw new AssertionError("summary fixture server failed",server.failure);
            Activity current=activity;registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(500);tap(registry,activity,233,180);awaitReaderTop(registry,texture,target);SystemClock.sleep(300);
            server.delay=3000;server.cancellationExpected=true;tap(registry,activity,233,150);awaitSummary(()->server.summaries==4);registry.runOnMainSync(current::onBackPressed);SystemClock.sleep(3500);
            assertEquals("late summary persisted after reader was closed",usageBefore+1,summaryUsageCount(target));saveRssStage(registry,texture,target,"summary-after-cancel");
        }finally{
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(700);}
            if(accountBackup.optBoolean("exists"))secure.execute("secure.set",new org.json.JSONObject().put("key","state_json").put("value",accountBackup.getString("value")));else secure.execute("secure.delete",key);secure.close();
            org.json.JSONObject latest=readerKv(target);latest.remove("watchrss.reader.progress."+articleId);if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);writeReaderKv(target,latest);
            try(SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE)){database.setForeignKeyConstraintsEnabled(true);database.execSQL("DELETE FROM channels WHERE id=? AND url=?",new Object[]{channelId,"https://example.test/"+marker});database.execSQL("DELETE FROM llm_token_usage WHERE model='fixture-summary-model'");}
        }
    }

    @Test public void readerOriginalRetriesCachesAndHonorsChannelDefault() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject originalKv=readerKv(target);Object settingsBackup=originalKv.opt("watchrss.settings");originalKv.remove("watchrss.settings");writeReaderKv(target,originalKv);
        Activity activity=null;long articleId=0,channelId=0;String marker="codex-original-"+SystemClock.uptimeMillis();
        try(ReaderImageServer server=new ReaderImageServer()){
            server.emptyOriginal=true;
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try{
                database.execSQL("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)",new Object[]{"https://example.test/"+marker,"原文验证",System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://example.test/"+marker})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,1)",new Object[]{channelId,"原文验证文章","RSS保留摘要","<p>RSS保留摘要</p>",server.url().replace("image.png","article"),marker,System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{marker})){assertTrue(c.moveToFirst());articleId=c.getLong(0);}
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000002)",new Object[]{articleId,System.currentTimeMillis()});
            }finally{database.close();}
            openFirstSavedReader(registry,activity,texture,target);awaitRssPixel(registry,texture,target,277,320,0x000000);saveRssStage(registry,texture,target,"reader-short");
            tap(registry,activity,110,174);SystemClock.sleep(1800);assertEquals(1,server.originalRequests);saveRssStage(registry,texture,target,"original-failed");
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try(Cursor c=database.rawQuery("SELECT count(*) FROM article_original_meta WHERE article_id=?",new String[]{Long.toString(articleId)})){assertTrue(c.moveToFirst());assertEquals(0,c.getInt(0));}finally{database.close();}
            tap(registry,activity,110,174);SystemClock.sleep(400);server.emptyOriginal=false;char[] large=new char[540000];java.util.Arrays.fill(large,'文');server.originalSuffix="<p>"+new String(large)+"</p>";server.originalDelayMillis=800;tap(registry,activity,110,174);
            SystemClock.sleep(200);tap(registry,activity,110,174);SystemClock.sleep(1500);awaitRssPixel(registry,texture,target,277,320,0x000000); // late completion must not switch back to original
            tap(registry,activity,110,174);
            awaitRssPixel(registry,texture,target,277,320,0x28a75b);assertEquals(2,server.originalRequests);saveRssStage(registry,texture,target,"original-loaded");
            tap(registry,activity,110,174);awaitRssPixel(registry,texture,target,277,320,0x000000);
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try(Cursor c=database.rawQuery("SELECT content,is_saved,(SELECT count(*) FROM source_preferences WHERE channel_id=articles.channel_id) FROM articles WHERE id=?",new String[]{Long.toString(articleId)})){assertTrue(c.moveToFirst());assertEquals("<p>RSS保留摘要</p>",c.getString(0));assertEquals(1,c.getInt(1));assertEquals(0,c.getInt(2));}finally{database.close();}
            Activity previous=activity;registry.runOnMainSync(previous::finish);SystemClock.sleep(700);
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));texture=awaitTextureView(activity);awaitHomeBitmap(registry,texture);openFirstSavedReader(registry,activity,texture,target);awaitRssPixel(registry,texture,target,277,320,0x000000);
            tap(registry,activity,110,174);awaitRssPixel(registry,texture,target,277,320,0x28a75b);assertEquals("cache not reused",2,server.originalRequests);
            database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);try{database.execSQL("INSERT INTO source_preferences(channel_id,use_original_content) VALUES(?,1)",new Object[]{channelId});}finally{database.close();}
            previous=activity;Activity closing=previous;registry.runOnMainSync(closing::finish);SystemClock.sleep(700);
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));texture=awaitTextureView(activity);awaitHomeBitmap(registry,texture);openFirstSavedReader(registry,activity,texture,target);awaitRssPixel(registry,texture,target,277,320,0x28a75b);assertEquals(2,server.originalRequests);
            saveRssStage(registry,texture,target,"original-default");
        }finally{
            if(activity!=null){Activity last=activity;registry.runOnMainSync(last::finish);SystemClock.sleep(700);}
            org.json.JSONObject latest=readerKv(target);latest.remove("watchrss.reader.progress."+articleId);if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);writeReaderKv(target,latest);
            if(channelId!=0){SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);try{database.setForeignKeyConstraintsEnabled(true);database.delete("article_original_chunks","article_id=?",new String[]{Long.toString(articleId)});database.delete("article_original_meta","article_id=?",new String[]{Long.toString(articleId)});database.delete("article_saved_states","article_id=?",new String[]{Long.toString(articleId)});database.delete("source_preferences","channel_id=?",new String[]{Long.toString(channelId)});database.delete("articles","id=? AND dedup_key=?",new String[]{Long.toString(articleId),marker});database.delete("channels","id=? AND url=?",new String[]{Long.toString(channelId),"https://example.test/"+marker});}finally{database.close();}}
        }
    }

    @Test public void readerAutoScrollPausesAndRestoresPersistentTextPosition() throws Exception {
        Instrumentation registry=InstrumentationRegistry.getInstrumentation();Context target=registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        org.json.JSONObject originalKv=readerKv(target);Object settingsBackup=originalKv.opt("watchrss.settings");
        originalKv.remove("watchrss.settings");writeReaderKv(target,originalKv);
        Activity activity=null;long articleId=0,channelId=0;String marker="codex-reader-"+SystemClock.uptimeMillis();
        try {
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            TextureView texture=awaitTextureView(activity);awaitChannelsTable(target);awaitHomeBitmap(registry,texture);
            SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
            try {
                database.execSQL("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)",new Object[]{"https://example.test/"+marker,"阅读位置验证",System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM channels WHERE url=?",new String[]{"https://example.test/"+marker})){assertTrue(c.moveToFirst());channelId=c.getLong(0);}
                StringBuilder body=new StringBuilder("<article><header>不应进入正文</header>");for(int i=0;i<120;i++)body.append("<p>第").append(i).append("段，<strong>自动滚动</strong>与阅读位置测试。</p>");body.append("</article>");
                database.execSQL("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,?,1)",new Object[]{channelId,"自动滚动验证文章","正文",body.toString(),"https://example.test/"+marker,marker,System.currentTimeMillis()});
                try(Cursor c=database.rawQuery("SELECT id FROM articles WHERE dedup_key=?",new String[]{marker})){assertTrue(c.moveToFirst());articleId=c.getLong(0);}
                database.execSQL("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,?,-9000000000000000)",new Object[]{articleId,System.currentTimeMillis()});
            } finally {database.close();}
            openFirstSavedReader(registry,activity,texture,target);saveRssStage(registry,texture,target,"reader-long");
            tap(registry,activity,233,300);SystemClock.sleep(2100);
            saveRssStage(registry,texture,target,"auto-after-tap");
            double automatic=readerOffset(target,articleId);assertTrue("single tap did not start automatic scrolling",automatic>20);
            dispatchRotary(registry,activity,1);SystemClock.sleep(1300);
            double paused=readerOffset(target,articleId);SystemClock.sleep(1400);
            assertEquals("crown did not pause automatic scrolling",paused,readerOffset(target,articleId),.1);
            tap(registry,activity,233,300);SystemClock.sleep(1600);
            assertTrue("single tap did not resume",readerOffset(target,articleId)>paused+10);
            tap(registry,activity,233,300);tap(registry,activity,233,300);
            awaitRssPixel(registry,texture,target,350,122,0xff6026);
            SystemClock.sleep(600);
            saveRssStage(registry,texture,target,"auto-controls");
            tap(registry,activity,380,122); // pause this article
            tap(registry,activity,400,234); // automatically start on the next open
            tap(registry,activity,233,394);SystemClock.sleep(900); // return to article
            dispatchRotary(registry,activity,1);SystemClock.sleep(1300);
            double saved=readerOffset(target,articleId);assertTrue(saved>0);
            Activity first=activity;registry.runOnMainSync(first::finish);SystemClock.sleep(700);
            activity=registry.startActivitySync(new Intent().setClassName(target.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            texture=awaitTextureView(activity);openFirstSavedReader(registry,activity,texture,target,false);SystemClock.sleep(1600);
            assertTrue("reopened reader did not restore and auto-start",readerOffset(target,articleId)>saved+10);
            saveRssStage(registry,texture,target,"auto-restored");
        } finally {
            if(activity!=null){Activity finalActivity=activity;registry.runOnMainSync(finalActivity::finish);SystemClock.sleep(700);}
            org.json.JSONObject latest=readerKv(target);latest.remove("watchrss.reader.progress."+articleId);latest.remove("watchrss.debug.reader");
            if(settingsBackup==null)latest.remove("watchrss.settings");else latest.put("watchrss.settings",settingsBackup);writeReaderKv(target,latest);
            if(channelId!=0){SQLiteDatabase database=SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),null,SQLiteDatabase.OPEN_READWRITE);
                try{database.delete("article_saved_states","article_id=?",new String[]{Long.toString(articleId)});database.delete("articles","id=? AND dedup_key=?",new String[]{Long.toString(articleId),marker});database.delete("channels","id=? AND url=?",new String[]{Long.toString(channelId),"https://example.test/"+marker});}finally{database.close();}}
        }
    }

    @Test public void memoCrudPersistsAcrossRestartAndCleansOnlyTestRow() throws Exception {
        final Instrumentation registry = InstrumentationRegistry.getInstrumentation();
        final Context target = registry.getTargetContext();
        assertIsolatedAcceptancePackage(target);
        Activity activity = registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        final String marker = "codex-memo-" + SystemClock.uptimeMillis();
        final String title = marker + " 标题";
        final String markdown = marker + " 正文\n第二行中文内容";
        Activity restarted = null;
        String noteId = null;
        try {
            TextureView texture = awaitTextureView(activity);
            awaitHomeBitmap(registry, texture);
            tap(registry, activity, 233, 259); // Home -> 备忘录, physical coordinates.
            SystemClock.sleep(900L);
            saveRssStage(registry,texture,target,"memo-before-add");
            tap(registry, activity, 233, 406); // Empty/list memo page -> +.
            completeNativePrompt(registry, activity, title);
            completeNativePrompt(registry, activity, markdown);
            SystemClock.sleep(900L);

            noteId = queryMemoNoteId(target, marker);
            assertNotNull("created memo row missing", noteId);
            assertMemoContent(target, noteId, title, markdown);
            Bitmap created = getBitmap(registry, texture);
            assertNotNull("created memo page bitmap missing", created);
            try { saveBitmap(created, new File(target.getFilesDir(), "watchrss-memo-created.png")); }
            finally { created.recycle(); }

            registry.runOnMainSync(activity::finish);
            restarted = registry.startActivitySync(new Intent().setClassName(target.getPackageName(),
                    "dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            TextureView restartedTexture = awaitTextureView(restarted);
            awaitHomeBitmap(registry, restartedTexture);
            tap(registry, restarted, 233, 259);
            SystemClock.sleep(900L);
            assertMemoContent(target, noteId, title, markdown);
            Bitmap reopened = getBitmap(registry, restartedTexture);
            assertNotNull("memo list bitmap missing after restart", reopened);
            try { saveBitmap(reopened, new File(target.getFilesDir(), "watchrss-memo-reopened.png")); }
            finally { reopened.recycle(); }

            // Scoped cleanup: remove only this UUID-marked row after persistence verification.
            SQLiteDatabase database = SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),
                    null, SQLiteDatabase.OPEN_READWRITE);
            try { assertEquals("test memo cleanup removed an unexpected row", 1,
                    database.delete("memo_notes", "note_id=? AND title=?", new String[] { noteId, title })); }
            finally { database.close(); }
            assertEquals("test memo row remained after cleanup", 0, countMemoNote(target, noteId));
        } finally {
            if (!activity.isDestroyed()) registry.runOnMainSync(activity::finish);
            if (restarted != null && !restarted.isDestroyed()) registry.runOnMainSync(restarted::finish);
            if (noteId != null) deleteMemoNote(target, noteId, title);
            else deleteMemoByTitle(target, title);
        }
    }

    private static void completeNativePrompt(Instrumentation registry, Activity activity, String value) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        EditText input = null;
        while (input == null && SystemClock.uptimeMillis() < deadline) {
            final EditText[] found = new EditText[1];
            registry.runOnMainSync(() -> found[0] = findWindowView(EditText.class));
            input = found[0];
            if (input == null) SystemClock.sleep(100L);
        }
        assertNotNull("native memo input dialog did not appear", input);
        final EditText dialogInput = input;
        registry.runOnMainSync(() -> {
            dialogInput.setText(value);
            Button positive = findWindowButton(android.R.string.ok);
            assertNotNull("native memo input positive button missing", positive);
            assertTrue("native memo input positive button did not accept click", positive.performClick());
        });
        SystemClock.sleep(500L);
    }

    private static <T extends View> T findWindowView(Class<T> type) {
        try {
            Class<?> global = Class.forName("android.view.WindowManagerGlobal");
            Object manager = global.getMethod("getInstance").invoke(null);
            Field viewsField = global.getDeclaredField("mViews");
            viewsField.setAccessible(true);
            Object views = viewsField.get(manager);
            if (views instanceof ArrayList) for (Object root : (ArrayList<?>) views)
                if (root instanceof View) { T found = findView((View) root, type); if (found != null) return found; }
        } catch (Exception error) { throw new AssertionError("could not inspect dialog windows", error); }
        return null;
    }

    private static <T extends View> T findView(View view, Class<T> type) {
        if (type.isInstance(view)) return type.cast(view);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                T found = findView(group.getChildAt(i), type);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static Button findWindowButton(int textId) {
        final String expected = InstrumentationRegistry.getInstrumentation().getTargetContext().getString(textId);
        try {
            Class<?> global = Class.forName("android.view.WindowManagerGlobal");
            Object manager = global.getMethod("getInstance").invoke(null);
            Field viewsField = global.getDeclaredField("mViews");
            viewsField.setAccessible(true);
            Object views = viewsField.get(manager);
            if (views instanceof ArrayList) for (Object root : (ArrayList<?>) views)
                if (root instanceof View) { Button found = findButton((View) root, expected); if (found != null) return found; }
        } catch (Exception error) { throw new AssertionError("could not inspect dialog buttons", error); }
        return null;
    }

    private static Button findButton(View view, String expected) {
        if (view instanceof Button && expected.contentEquals(((Button) view).getText())) return (Button) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                Button found = findButton(group.getChildAt(i), expected);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static String queryMemoNoteId(Context target, String marker) {
        SQLiteDatabase database = SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),
                null, SQLiteDatabase.OPEN_READONLY);
        try (Cursor cursor = database.rawQuery("SELECT note_id FROM memo_notes WHERE title LIKE ? AND deleted=0",
                new String[] { marker + "%" })) {
            assertTrue("created memo was not visible as an active row", cursor.moveToFirst());
            return cursor.getString(0);
        } finally { database.close(); }
    }

    private static void assertMemoContent(Context target, String noteId, String title, String markdown) throws Exception {
        SQLiteDatabase database = SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),
                null, SQLiteDatabase.OPEN_READONLY);
        try (Cursor cursor = database.rawQuery("SELECT title,markdown,plain_text,content_hash,deleted FROM memo_notes WHERE note_id=?",
                new String[] { noteId })) {
            assertTrue("memo row missing during content verification", cursor.moveToFirst());
            assertEquals(title, cursor.getString(0));
            assertEquals(markdown, cursor.getString(1));
            assertEquals(markdown, cursor.getString(2));
            assertEquals(sha256(markdown), cursor.getString(3));
            assertEquals(0, cursor.getInt(4));
        } finally { database.close(); }
    }

    private static int countMemoNote(Context target, String noteId) {
        SQLiteDatabase database = SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(),
                null, SQLiteDatabase.OPEN_READONLY);
        try (Cursor cursor = database.rawQuery("SELECT COUNT(*) FROM memo_notes WHERE note_id=?", new String[] { noteId })) {
            assertTrue(cursor.moveToFirst()); return cursor.getInt(0);
        } finally { database.close(); }
    }

    private static void deleteMemoNote(Context target, String noteId, String title) {
        SQLiteDatabase database = null;
        try {
            database = SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(), null,
                    SQLiteDatabase.OPEN_READWRITE);
            database.delete("memo_notes", "note_id=? AND title=?", new String[] { noteId, title });
        } finally { if (database != null) database.close(); }
    }

    private static void deleteMemoByTitle(Context target, String title) {
        SQLiteDatabase database = null;
        try {
            database = SQLiteDatabase.openDatabase(target.getDatabasePath("podjs.sqlite").getPath(), null,
                    SQLiteDatabase.OPEN_READWRITE);
            database.delete("memo_notes", "title=? AND note_id LIKE 'codex-memo-%'", new String[] { title });
        } finally { if (database != null) database.close(); }
    }

    private static String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte valueByte : digest) result.append(String.format("%02x", valueByte & 0xff));
        return result.toString();
    }
    private static boolean isAvatarBorder(int color) {
        int r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
        return r > 50 && r > 2*g && r > 2*b;
    }

    private static void awaitBitmap(Instrumentation instrumentation, TextureView texture) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            Bitmap bitmap = getBitmap(instrumentation, texture);
            if (bitmap != null) { boolean rendered = hasNonBlackPixel(bitmap); bitmap.recycle(); if (rendered) return; }
            SystemClock.sleep(100L);
        }
        throw new AssertionError("renderer did not produce a non-black bitmap");
    }

    private static Bitmap getBitmap(Instrumentation instrumentation, TextureView texture) {
        final Bitmap[] result = new Bitmap[1];
        instrumentation.runOnMainSync(() -> result[0] = texture.getBitmap());
        return result[0];
    }

    private static boolean hasNonBlackPixel(Bitmap bitmap) {
        for (int y = 0; y < bitmap.getHeight(); y += 4)
            for (int x = 0; x < bitmap.getWidth(); x += 4)
                if ((bitmap.getPixel(x, y) & 0x00ffffff) != 0) return true;
        return false;
    }

    private static long host(PodRuntimeView view) throws Exception {
        Field field = PodRuntimeView.class.getDeclaredField("host"); field.setAccessible(true);
        final long[] result = new long[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try { result[0] = field.getLong(view); }
            catch (IllegalAccessException error) { throw new AssertionError(error); }
        });
        return result[0];
    }

    private static PodRuntimeView findPodView(View view) {
        if (view instanceof PodRuntimeView) return (PodRuntimeView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                PodRuntimeView found = findPodView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    private static TextureView awaitTextureView(Activity activity) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        TextureView found;
        while (((found = findTextureView(activity.getWindow().getDecorView())) == null || !found.isAvailable())
                && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100L);
        return found;
    }

    private static TextureView findTextureView(View view) {
        if (view instanceof PodRuntimeView) return (PodRuntimeView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                TextureView found = findTextureView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    private static void awaitChannelsTable(Context target) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            File databaseFile = target.getDatabasePath("podjs.sqlite");
            if (databaseFile.isFile()) {
                SQLiteDatabase database = null;
                try {
                    database = SQLiteDatabase.openDatabase(databaseFile.getPath(), null, SQLiteDatabase.OPEN_READONLY);
                    try (Cursor cursor = database.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", new String[] { "article_body_chunks" })) {
                        if (cursor.moveToFirst()) return;
                    }
                } catch (RuntimeException ignored) {
                    // The host may still be creating or committing the database.
                } finally {
                    if (database != null) database.close();
                }
            }
            SystemClock.sleep(100L);
        }
        throw new AssertionError("podjs.sqlite channels table was not initialized");
    }
}
