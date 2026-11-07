package dev.podjs.runtime;

import androidx.test.platform.app.InstrumentationRegistry;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.spec.SecretKeySpec;
import static org.junit.Assert.*;

/** Explicit synthetic QuickJS + Android host acceptance. No external network. */
public class P3BSpaceGuestTest {
 @Test public void spaceGuest()throws Exception{
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();File root=Files.createTempDirectory(context.getCacheDir().toPath(),"wrss-p3b-guest-").toFile();
  String source=new String(Files.readAllBytes(new File(context.getFilesDir(),"wrss-p3b-guest.js").toPath()),StandardCharsets.UTF_8);File data=new File(root,"host/files");data.mkdirs();
  SQLiteDatabase db=SQLiteDatabase.openOrCreateDatabase(new File(root,"projection.sqlite"),null);PodDeviceServices device=new PodDeviceServices(data,()->new SecretKeySpec(new byte[32],"AES")),contentDevice=new PodDeviceServices(data,()->new SecretKeySpec(new byte[32],"AES"));PodContentFiles files=new PodContentFiles(data);
  String alias="podjs.signing.v2."+String.join("",Collections.nCopies(64,"8"));KeyStore keyStore=KeyStore.getInstance("AndroidKeyStore");keyStore.load(null);boolean existing=keyStore.containsAlias(alias);
  ExecutorService executor=Executors.newSingleThreadExecutor();
  try(PodBackgroundRun run=new PodBackgroundRun("watch-p3b-synthetic","p3b",source,300000,32*1024*1024,JSONObject.NULL,new String[]{"cloud.host"})){
   JSONObject counts=new JSONObject();int maxRequestBytes=0;long peakRssKiB=0;Future<JSONObject> outcome=executor.submit(run::run);while(!outcome.isDone()){
    try{for(String line:Files.readAllLines(Paths.get("/proc/self/status"))){if(line.startsWith("VmHWM:"))peakRssKiB=Math.max(peakRssKiB,Long.parseLong(line.replaceAll("[^0-9]","")));}}catch(Exception ignored){}
    JSONObject request=run.waitRequest(50);if(request==null)continue;JSONObject wire=request.getJSONObject("args"),args=wire.getJSONObject("args"),reply=new JSONObject().put("id",request.getLong("id"));String method=wire.getString("method");counts.put(method,counts.optInt(method)+1);maxRequestBytes=Math.max(maxRequestBytes,args.toString().getBytes(StandardCharsets.UTF_8).length);
    try{Object value;
     if(method.equals("result")){args.put("peakProcessRssKiB",peakRssKiB).put("guestMemoryLimitBytes",32*1024*1024).put("hostCallsByMethod",counts).put("maxHostRequestBytes",maxRequestBytes);Files.write(new File(context.getFilesDir(),"wrss-p3b-result.json").toPath(),args.toString(2).getBytes(StandardCharsets.UTF_8));value=JSONObject.NULL;}
     else if(method.equals("runtime.delay")){Thread.sleep(Math.min(5,args.optInt("milliseconds",1)));value=JSONObject.NULL;}
     else if(method.equals("sql.query")){JSONArray rows=new JSONArray(),p=args.optJSONArray("params");try(Cursor c=db.rawQueryWithFactory((database,driver,editTable,query)->{if(p!=null)for(int i=0;i<p.length();i++){Object bind=p.opt(i);if(bind==null||bind==JSONObject.NULL)query.bindNull(i+1);else if(bind instanceof Double||bind instanceof Float)query.bindDouble(i+1,((Number)bind).doubleValue());else if(bind instanceof Number)query.bindLong(i+1,((Number)bind).longValue());else query.bindString(i+1,String.valueOf(bind));}return new android.database.sqlite.SQLiteCursor(driver,editTable,query);},args.getString("sql"),null,null)){while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.isNull(i)?JSONObject.NULL:c.getType(i)==Cursor.FIELD_TYPE_INTEGER?c.getLong(i):c.getString(i));rows.put(row);}}value=rows;}
     else if(method.equals("sql.transaction")){db.beginTransaction();try{JSONArray statements=args.getJSONArray("statements");for(int i=0;i<statements.length();i++){JSONObject s=statements.getJSONObject(i);JSONArray p=s.optJSONArray("params");Object[] binds=new Object[p==null?0:p.length()];for(int j=0;j<binds.length;j++)binds[j]=p.isNull(j)?null:p.get(j);db.execSQL(s.getString("sql"),binds);}db.setTransactionSuccessful();}finally{db.endTransaction();}value=JSONObject.NULL;}
     else if(method.startsWith("content.files."))value=files.execute(method,args);
     else if(method.startsWith("content.crypto."))value=contentDevice.execute(method.substring("content.".length()),args);
     else if(method.equals("secure.get"))value=device.execute(method,args).opt("value");
     else if(method.startsWith("crypto.")||method.startsWith("file.")||method.equals("secure.compareAndSet"))value=device.execute(method,args);
     else throw new SecurityException("unexpected method");
     reply.put("ok",true).put("value",value==null?JSONObject.NULL:value);
    }catch(Exception error){reply.put("ok",false).put("code","p3_"+error.getClass().getSimpleName());}
    run.reply(reply);
   }
   JSONObject result=outcome.get(10,TimeUnit.SECONDS);Files.write(new File(context.getFilesDir(),"wrss-p3b-outcome.json").toPath(),result.toString(2).getBytes(StandardCharsets.UTF_8));assertEquals("Guest outcome: "+result,"success",result.optString("status"));
  }finally{executor.shutdownNow();device.close();contentDevice.close();db.close();if(!existing){keyStore.deleteEntry(alias);keyStore.deleteEntry(alias+".created");}try(java.util.stream.Stream<Path> paths=Files.walk(root.toPath())){for(Path p:paths.sorted(Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList()))Files.deleteIfExists(p);}}
 }
}
