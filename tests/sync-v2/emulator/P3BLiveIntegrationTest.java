package dev.podjs.runtime;

import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.json.*;
import android.util.Base64;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.*;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.spec.SecretKeySpec;
import static org.junit.Assert.*;

/** Test-only fixture loader. No account materials are compiled into the APK. */
public final class P3BLiveIntegrationTest {
 private File root;
 private JSONObject fixture;
 private PrivateKey signer;
 private SQLiteDatabase sql;
 private final Map<String,SQLiteDatabase> databases=new HashMap<>();
 private SQLiteDatabase database(JSONObject args){String name=args.optString("database","main");if(!name.equals("main")&&!name.matches("audit-[a-f0-9]{32}"))throw new SecurityException();return databases.computeIfAbsent(name,n->SQLiteDatabase.openOrCreateDatabase(new File(root,n.equals("main")?"projection.sqlite":n+".sqlite"),null));}
 private PodDeviceServices device;
 private PodContentFiles contentFiles;
 private PodHttpServices contentHttp;
 private final List<JSONObject> events=new ArrayList<>();
 private static byte[] decode(String s){return Base64.decode(s,s.indexOf('-')>=0||s.indexOf('_')>=0?Base64.URL_SAFE:Base64.DEFAULT);}
 private static String encode(byte[] b){return Base64.encodeToString(b,Base64.NO_WRAP);}
 private JSONArray query(JSONObject args)throws Exception {
  JSONArray p=args.optJSONArray("params");SQLiteDatabase db=database(args);JSONArray rows=new JSONArray();try(Cursor c=db.rawQueryWithFactory((database,driver,editTable,query)->{if(p!=null)for(int i=0;i<p.length();i++){Object value=p.opt(i);if(value==null||value==JSONObject.NULL)query.bindNull(i+1);else if(value instanceof Double||value instanceof Float)query.bindDouble(i+1,((Number)value).doubleValue());else if(value instanceof Number)query.bindLong(i+1,((Number)value).longValue());else query.bindString(i+1,String.valueOf(value));}return new android.database.sqlite.SQLiteCursor(driver,editTable,query);},args.getString("sql"),null,null)){while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++){Object v=JSONObject.NULL;switch(c.getType(i)){case Cursor.FIELD_TYPE_INTEGER:v=c.getLong(i);break;case Cursor.FIELD_TYPE_FLOAT:v=c.getDouble(i);break;case Cursor.FIELD_TYPE_STRING:v=c.getString(i);break;}row.put(c.getColumnName(i),v);}rows.put(row);}}return rows;
 }
 private Object http(JSONObject args)throws Exception {
  URL url=new URL(args.getString("url"));if(!url.getHost().equals("127.0.0.1")||url.getPort()!=18952)throw new SecurityException();
  HttpURLConnection c=(HttpURLConnection)url.openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(10000);c.setReadTimeout(30000);c.setRequestMethod(args.getString("method"));JSONObject h=args.getJSONObject("headers");Iterator<String> names=h.keys();while(names.hasNext()){String n=names.next();c.setRequestProperty(n,h.getString(n));}
  try{if(!args.isNull("body")){byte[] b=decode(args.getString("body"));c.setDoOutput(true);c.setFixedLengthStreamingMode(b.length);try(OutputStream out=c.getOutputStream()){out.write(b);}}
   int status=c.getResponseCode();ByteArrayOutputStream bytes=new ByteArrayOutputStream();InputStream stream=status>=400?c.getErrorStream():c.getInputStream();if(stream!=null)try(InputStream in=stream){byte[] b=new byte[8192];for(int n;(n=in.read(b))!=-1;){if(bytes.size()+n>1048576)throw new IOException();bytes.write(b,0,n);}}
   JSONObject headers=new JSONObject();for(Map.Entry<String,List<String>> entry:c.getHeaderFields().entrySet())if(entry.getKey()!=null)headers.put(entry.getKey().toLowerCase(Locale.ROOT),entry.getValue().get(0));
   return new JSONObject().put("status",status).put("headers",headers).put("body",encode(bytes.toByteArray()));
  }finally{c.disconnect();}
 }
 private Object dispatch(String method,JSONObject args)throws Exception {
  switch(method){
   case "http":return http(args);
   case "runtime.delay":Thread.sleep(Math.min(5,args.optInt("milliseconds",1)));return JSONObject.NULL;
   case "result":events.add(new JSONObject(args.toString()));Files.write(new File(root.getParentFile(),"result.json").toPath(),new JSONArray(events).toString(2).getBytes(StandardCharsets.UTF_8));android.util.Log.i("WrssP3BLive",args.toString());return JSONObject.NULL;
   case "sql.query":return query(args);
   case "sql.transaction":SQLiteDatabase db=database(args);db.beginTransaction();try{JSONArray statements=args.getJSONArray("statements");for(int i=0;i<statements.length();i++){JSONObject s=statements.getJSONObject(i);JSONArray p=s.optJSONArray("params");Object[] values=new Object[p==null?0:p.length()];for(int j=0;j<values.length;j++)values[j]=p.isNull(j)?null:p.get(j);db.execSQL(s.getString("sql"),values);}db.setTransactionSuccessful();}finally{db.endTransaction();}return JSONObject.NULL;
   case "crypto.v2.sign":return new JSONObject().put("signatureBase64",encode(PodSyncV2Crypto.sign(signer,decode(args.getString("dataBase64")))));
   case "crypto.v2.signingKey":return new JSONObject().put("publicKeySec1",encode(decode(fixture.getJSONObject("signingKey").getString("publicKeyBase64Url"))));
   case "secure.get":return device.execute(method,args).opt("value");
   default:if(method.startsWith("content.files."))return contentFiles.execute(method,args);if(!method.startsWith("crypto.")&&!method.startsWith("file.")&&!method.equals("secure.compareAndSet"))throw new SecurityException();return device.execute(method,args);
  }
 }
 @Test public void isolatedBackend()throws Exception {
  root=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir(),"syncv2-p3b-live");
  fixture=new JSONObject(new String(Files.readAllBytes(new File(root,"watch.json").toPath()),StandardCharsets.UTF_8));assertTrue(fixture.getBoolean("syntheticOnly"));assertEquals("watch",fixture.getString("platform"));
  String pem=fixture.getJSONObject("signingKey").getString("privateKeyPkcs8Pem").replaceAll("-----[^-]+-----","").replaceAll("\\s","");signer=KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(decode(pem)));
  fixture.put("runId",UUID.randomUUID().toString().replace("-",""));
  fixture.put("resumeWatermark",new JSONObject(new String(Files.readAllBytes(new File(root,"resume-watermark.json").toPath()),StandardCharsets.UTF_8)));
  String source=new String(Files.readAllBytes(new File(root,"guest.js").toPath()),StandardCharsets.UTF_8);
  root=new File(root,fixture.getString("runId"));assertTrue(root.mkdirs());sql=database(new JSONObject());
  File fileRoot=PodTakeover.filesRoot(InstrumentationRegistry.getInstrumentation().getTargetContext());device=new PodDeviceServices(fileRoot,()->new SecretKeySpec(new byte[32],"AES"));contentFiles=new PodContentFiles(fileRoot);contentHttp=new PodHttpServices(InstrumentationRegistry.getInstrumentation().getTargetContext());
  ExecutorService executor=Executors.newSingleThreadExecutor(),network=Executors.newFixedThreadPool(2),content=Executors.newSingleThreadExecutor();try(PodBackgroundRun run=new PodBackgroundRun("watch-p3b-live","integration",source,300000,256*1024*1024,fixture,new String[]{"cloud.host"})){
   Future<JSONObject> outcome=executor.submit(run::run);
   while(!outcome.isDone()){JSONObject r=run.waitRequest(50);if(r==null)continue;JSONObject a=r.getJSONObject("args");if(a.getString("method").equals("http")||a.getString("method").equals("content.http")){boolean body=a.getString("method").equals("content.http");if(body){URL target=new URL(a.getJSONObject("args").getString("url"));if(!target.getHost().equals("127.0.0.1")||target.getPort()!=18952)throw new SecurityException();}(body?content:network).submit(()->{try{JSONObject reply=new JSONObject().put("id",r.getLong("id"));try{reply.put("ok",true).put("value",body?contentHttp.execute("http.download",a.getJSONObject("args")):http(a.getJSONObject("args")));}catch(Exception error){reply.put("ok",false).put("code","integration_http_"+error.getClass().getSimpleName());}run.reply(reply);}catch(Exception ignored){run.cancel();}});continue;}JSONObject reply=new JSONObject().put("id",r.getLong("id"));try{reply.put("ok",true).put("value",dispatch(a.getString("method"),a.getJSONObject("args")));}catch(Exception error){reply.put("ok",false).put("code","integration_host_"+error.getClass().getSimpleName());}run.reply(reply);}
   JSONObject result=outcome.get(10,TimeUnit.SECONDS);assertEquals("Guest outcome: "+result.optString("code"),"success",result.optString("status"));
  }finally{executor.shutdownNow();network.shutdownNow();content.shutdownNow();contentHttp.close();device.close();for(SQLiteDatabase db:databases.values())db.close();}
 }
}
