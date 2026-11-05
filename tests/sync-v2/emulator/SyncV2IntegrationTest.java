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
public final class SyncV2IntegrationTest {
 private File root;
 private JSONObject fixture;
 private PrivateKey signer;
 private SQLiteDatabase sql;
 private final Map<String,SQLiteDatabase> databases=new HashMap<>();
 private SQLiteDatabase database(JSONObject args){String name=args.optString("database","main");if(!name.equals("main")&&!name.matches("audit-[a-f0-9]{32}"))throw new SecurityException();return databases.computeIfAbsent(name,n->SQLiteDatabase.openOrCreateDatabase(new File(root,n.equals("main")?"projection.sqlite":n+".sqlite"),null));}
 private PodDeviceServices device;
 private final List<JSONObject> events=new ArrayList<>();
 private static byte[] decode(String s){return Base64.decode(s,s.indexOf('-')>=0||s.indexOf('_')>=0?Base64.URL_SAFE:Base64.DEFAULT);}
 private static String encode(byte[] b){return Base64.encodeToString(b,Base64.NO_WRAP);}
 private JSONArray query(JSONObject args)throws Exception {
  JSONArray p=args.optJSONArray("params");String[] binds=new String[p==null?0:p.length()];for(int i=0;i<binds.length;i++)binds[i]=p.isNull(i)?null:String.valueOf(p.get(i));
  SQLiteDatabase db=database(args);JSONArray rows=new JSONArray();try(Cursor c=db.rawQuery(args.getString("sql"),binds)){while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++){Object v=JSONObject.NULL;switch(c.getType(i)){case Cursor.FIELD_TYPE_INTEGER:v=c.getLong(i);break;case Cursor.FIELD_TYPE_FLOAT:v=c.getDouble(i);break;case Cursor.FIELD_TYPE_STRING:v=c.getString(i);break;}row.put(c.getColumnName(i),v);}rows.put(row);}}return rows;
 }
 private Object http(JSONObject args)throws Exception {
  URL url=new URL(args.getString("url"));if(!url.getHost().equals("127.0.0.1")||url.getPort()!=18942)throw new SecurityException();
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
   case "result":events.add(new JSONObject(args.toString()));Files.write(new File(root,"result.json").toPath(),new JSONArray(events).toString(2).getBytes(StandardCharsets.UTF_8));android.util.Log.i("WrssP2Integration",args.toString());return JSONObject.NULL;
   case "sql.query":return query(args);
   case "sql.transaction":SQLiteDatabase db=database(args);db.beginTransaction();try{JSONArray statements=args.getJSONArray("statements");for(int i=0;i<statements.length();i++){JSONObject s=statements.getJSONObject(i);JSONArray p=s.optJSONArray("params");Object[] values=new Object[p==null?0:p.length()];for(int j=0;j<values.length;j++)values[j]=p.isNull(j)?null:p.get(j);db.execSQL(s.getString("sql"),values);}db.setTransactionSuccessful();}finally{db.endTransaction();}return JSONObject.NULL;
   case "crypto.v2.sign":return new JSONObject().put("signatureBase64",encode(PodSyncV2Crypto.sign(signer,decode(args.getString("dataBase64")))));
   case "crypto.v2.signingKey":return new JSONObject().put("publicKeySec1",encode(decode(fixture.getJSONObject("signingKey").getString("publicKeyBase64Url"))));
   case "secure.get":return device.execute(method,args).opt("value");
   default:if(!method.startsWith("crypto.")&&!method.equals("secure.compareAndSet"))throw new SecurityException();return device.execute(method,args);
  }
 }
 @Test public void isolatedBackend()throws Exception {
  root=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir(),"syncv2-integration");
  fixture=new JSONObject(new String(Files.readAllBytes(new File(root,"watch.json").toPath()),StandardCharsets.UTF_8));assertTrue(fixture.getBoolean("syntheticOnly"));assertEquals("watch",fixture.getString("platform"));
  String pem=fixture.getJSONObject("signingKey").getString("privateKeyPkcs8Pem").replaceAll("-----[^-]+-----","").replaceAll("\\s","");signer=KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(decode(pem)));
  fixture.put("integrationMode",InstrumentationRegistry.getArguments().getString("mode","full"));
  String source=new String(Files.readAllBytes(new File(root,"guest.js").toPath()),StandardCharsets.UTF_8);
  sql=database(new JSONObject());device=new PodDeviceServices(new File(root,"host/files"),()->new SecretKeySpec(new byte[32],"AES"));
  ExecutorService executor=Executors.newSingleThreadExecutor(),network=Executors.newFixedThreadPool(4);try(PodBackgroundRun run=new PodBackgroundRun("watch-p2-integration","integration",source,300000,256*1024*1024,fixture,new String[]{"cloud.host"})){
   Future<JSONObject> outcome=executor.submit(run::run);
   while(!outcome.isDone()){JSONObject r=run.waitRequest(50);if(r==null)continue;JSONObject a=r.getJSONObject("args");if(a.getString("method").equals("http")){network.submit(()->{try{JSONObject reply=new JSONObject().put("id",r.getLong("id"));try{reply.put("ok",true).put("value",http(a.getJSONObject("args")));}catch(Exception error){reply.put("ok",false).put("code","integration_http_"+error.getClass().getSimpleName());}run.reply(reply);}catch(Exception ignored){run.cancel();}});continue;}JSONObject reply=new JSONObject().put("id",r.getLong("id"));try{reply.put("ok",true).put("value",dispatch(a.getString("method"),a.getJSONObject("args")));}catch(Exception error){reply.put("ok",false).put("code","integration_host_"+error.getClass().getSimpleName());}run.reply(reply);}
   JSONObject result=outcome.get(10,TimeUnit.SECONDS);assertEquals("Guest outcome: "+result.optString("code"),"success",result.optString("status"));
  }finally{executor.shutdownNow();network.shutdownNow();device.close();for(SQLiteDatabase db:databases.values())db.close();}
 }
}
