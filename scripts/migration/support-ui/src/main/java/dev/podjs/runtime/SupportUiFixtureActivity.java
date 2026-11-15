package dev.podjs.runtime;

import android.app.Activity;
import android.os.*;
import android.view.View;
import java.io.File;
import java.util.Properties;
import org.json.*;

/** Emulator-only UI projection. Uses real production widgets and a local fake log receiver. */
public final class SupportUiFixtureActivity extends Activity {
    PodTakeover.RecoveryView recovery;
    final Handler main=new Handler(Looper.getMainLooper());
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if(!getPackageName().equals("com.lightningstudio.watchrss.podjs.supportrehearsal")||
           !(Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish")))throw new SecurityException("emulator_fixture_only");
        getWindow().setFlags(1024,1024);getWindow().getDecorView().setSystemUiVisibility(5894);
        try {
            File control=new File(PodTakeover.sandbox(this),"files/package-takeover");java.nio.file.Files.createDirectories(control.toPath());
            String generation="g-00000000-0000-0000-0000-000000000000";
            Properties journal=new Properties();journal.setProperty("generation",generation);journal.setProperty("phase","BLOCKED");journal.setProperty("reason","store_unsupported_or_failed");
            PodTakeoverCoordinator.atomic(new File(control,"journal"),journal);
            PodStoreConverter.json(new File(control,"generations/"+generation+"/files-report.json"),new JSONObject().put("version","watchrss-files-7").put("unknownFiles",24)
                .put("unknownPaths",new JSONArray().put("files/imports/123456789/book-title.txt").put("files/Firebase/deadbeef/session"))
                .put("classes",new JSONObject().put("unknown-user-content",24).put("asset",3)));
            recovery=new PodTakeover.RecoveryView(this);
            String screen=getIntent().getStringExtra("screen");
            recovery.render(new JSONObject().put("phase","paused".equals(screen)?"PAUSED":"BLOCKED").put("reason","paused".equals(screen)?"stage_failed":"unknown".equals(screen)?"unknown_user_files":"store_unsupported_or_failed").put("percent",86),false);
            recovery.support.setOnClickListener(v->openSupport(false));recovery.retry.setOnClickListener(v->{});
            setContentView(recovery);
            if("preview".equals(screen)||"success".equals(screen))openSupport("success".equals(screen));
            recovery.post(()->{
                if(!recovery.isAttachedToWindow())return;
                for(View button:new View[]{recovery.retry,recovery.support}) {
                    if(button.getVisibility()!=View.VISIBLE)continue;
                    boolean inside=PodRecoveryRoundLayout.rectInsideCircle(new PodRecoveryRoundLayout.Rect(button.getLeft(),button.getTop(),button.getWidth(),button.getHeight()),recovery.getWidth(),recovery.getHeight(),2);
                    android.util.Log.i("TakeoverSupportFixture","button="+((android.widget.TextView)button).getText()+" rect="+button.getLeft()+","+button.getTop()+","+button.getWidth()+","+button.getHeight()+" inside="+inside);
                    if(recovery.isAttachedToWindow()&&!inside)throw new AssertionError("button_outside_circle");
                }
            });
        }catch(Exception error){throw new IllegalStateException(error);}
    }
    void openSupport(boolean upload) {
        PodTakeoverSupportAndroid.Page page=new PodTakeoverSupportAndroid.Page(this,()->setContentView(recovery));setContentView(page);
        Runnable inject=new Runnable(){public void run(){
            if(page.service==null){main.postDelayed(this,50);return;}
            try {
                PodTakeoverSupport original=page.service;
                final JSONObject[] stored={null};
                page.service=new PodTakeoverSupport(original.endpoint,original.publicKey,(method,url,headers,body)->{
                    android.util.Log.i("TakeoverSupportFixture","fakeReceiver method="+method+" bytes="+body.length+" INTERNET_PERMISSION=false");
                    JSONObject receipt=new JSONObject().put("id","00000000-0000-0000-0000-000000000000").put("code","123456").put("deleteToken","b".repeat(64))
                        .put("createdAt","2026-11-15T00:00:00Z").put("expiresAt","2026-11-16T00:00:00Z").put("fileSize",body.length).put("charCount",1024);
                    return new PodTakeoverSupport.Response(method.equals("POST")?201:204,receipt.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                },new PodTakeoverSupport.Receipts(){public JSONObject read(){return stored[0];}public void save(JSONObject r){stored[0]=r;}public void remove(){stored[0]=null;}});
                page.service.redactor=original.redactor;page.refresh();
                if(upload){page.consent.setChecked(true);page.upload.performClick();
                    main.postDelayed(new Runnable(){public void run(){if(page.message.getText().toString().contains("日志编号"))page.fullScroll(View.FOCUS_DOWN);else main.postDelayed(this,100);}},100);
                }
            }catch(Exception error){throw new IllegalStateException(error);}
        }};main.post(inject);
    }
}
