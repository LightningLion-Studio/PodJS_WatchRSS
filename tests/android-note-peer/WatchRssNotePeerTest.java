package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.bluetooth.*;
import android.graphics.Bitmap;
import android.os.Bundle;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
/** Paired physical-device fixture; its UUID cannot address the public main-app listener. */
public final class WatchRssNotePeerTest {
 private static final String UUID_VALUE="ae7f76b9-9129-4ccb-b213-7695194d81f9";
 private DataInputStream input;private DataOutputStream output;private int actions;
 @Test public void notesAndPngCompleteInOnePersistentSession()throws Exception{
  String address=InstrumentationRegistry.getArguments().getString("watchAddress");assertNotNull(address);
  BluetoothAdapter adapter=InstrumentationRegistry.getInstrumentation().getTargetContext().getSystemService(BluetoothManager.class).getAdapter();assertNotNull(adapter);assertTrue(adapter.isEnabled());BluetoothDevice device=adapter.getRemoteDevice(address);assertEquals(BluetoothDevice.BOND_BONDED,device.getBondState());
  Bitmap bitmap=Bitmap.createBitmap(512,512,Bitmap.Config.ARGB_8888);int[] pixels=new int[512*512];Random random=new Random(7193);for(int i=0;i<pixels.length;i++)pixels[i]=0xff000000|random.nextInt(0x1000000);bitmap.setPixels(pixels,0,512,0,0,512,512);ByteArrayOutputStream encoded=new ByteArrayOutputStream();assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,encoded));bitmap.recycle();byte[] png=encoded.toByteArray();assertTrue(png.length>512*1024);assertTrue(png.length<2*1024*1024);String imageHash=hash(png);
  AtomicBoolean timedOut=new AtomicBoolean();ScheduledExecutorService watchdog=Executors.newSingleThreadScheduledExecutor();
  try(BluetoothSocket socket=device.createRfcommSocketToServiceRecord(UUID.fromString(UUID_VALUE))){
   watchdog.schedule(()->{timedOut.set(true);try{socket.close();}catch(Exception ignored){}},150,TimeUnit.SECONDS);socket.connect();input=new DataInputStream(socket.getInputStream());output=new DataOutputStream(socket.getOutputStream());
   JSONObject first=exchange(notes(note("同步前",1,false)).put("requestPersistentSession",true).put("supportsPersistentSession",true));assertTrue(first.getBoolean("success"));assertTrue(first.getBoolean("persistentSessionAccepted"));assertEquals(1,first.getInt("applied"));String watchId=first.getString("deviceId");assertFalse(watchId.isEmpty());
   int count=(png.length+512*1024-1)/(512*1024);
   for(int i=0;i<count;i++){byte[] chunk=Arrays.copyOfRange(png,i*512*1024,Math.min(png.length,(i+1)*512*1024));JSONObject r=exchange(asset(imageHash,i,count,Base64.getEncoder().encodeToString(chunk)));assertTrue(r.getBoolean("success"));assertEquals(i==count-1,r.getBoolean("complete"));assertFalse(r.getBoolean("alreadyPresent"));}
   JSONObject reused=exchange(asset(imageHash,0,count,"not base64"));assertTrue(reused.getBoolean("alreadyPresent"));assertTrue(reused.getBoolean("complete"));
   JSONObject updated=exchange(notes(note("同步后",2,false)));assertEquals(1,updated.getInt("applied"));assertEquals("同步后",updated.getJSONArray("notes").getJSONObject(0).getString("title"));
   JSONObject stale=exchange(notes(note("过期标题",1,false)));assertEquals(0,stale.getInt("applied"));assertEquals("同步后",stale.getJSONArray("notes").getJSONObject(0).getString("title"));
   JSONObject rejected=exchange(new JSONObject().put("action","syncNotes").put("notes",new JSONArray().put(JSONObject.NULL)));assertFalse(rejected.getBoolean("success"));
   JSONObject tombstone=exchange(notes(note("同步后",3,true)));assertEquals(1,tombstone.getInt("applied"));assertTrue(tombstone.getJSONArray("notes").getJSONObject(0).getBoolean("deleted"));
   JSONObject exported=exchange(new JSONObject().put("action","syncNotes"));assertEquals(0,exported.getInt("applied"));assertEquals(watchId,exported.getString("deviceId"));assertTrue(exported.getJSONArray("notes").getJSONObject(0).getBoolean("deleted"));
   JSONObject complete=exchange(new JSONObject().put("action","syncSession").put("phase","complete"));assertTrue(complete.getBoolean("success"));
   boolean closed;try{closed=input.read()==-1;}catch(IOException e){if(!timedOut.get()&&String.valueOf(e.getMessage()).contains("read return: -1"))closed=true;else throw e;}assertTrue(closed);assertFalse(timedOut.get());
   Bundle proof=new Bundle();proof.putString("notePeerProof",new JSONObject().put("watchId",watchId).put("pngSha256",imageHash).put("pngBytes",png.length).put("pngChunks",count).put("actions",actions).put("persistentSession",true).toString());InstrumentationRegistry.getInstrumentation().sendStatus(0,proof);
  }finally{watchdog.shutdownNow();}
 }
 private JSONObject note(String title,int time,boolean deleted)throws Exception{String markdown="# 手机备忘录\n正文😀\n![图片](assets/note-peer-owned.png)\n版本"+time;return new JSONObject().put("noteId","note-peer-owned").put("title",title).put("markdown",markdown).put("contentHash",hash(markdown.getBytes(StandardCharsets.UTF_8))).put("baseContentHash","base").put("updatedAt",time).put("deleted",deleted).put("deletedAt",deleted?time:0).put("modifiedBy","note-peer-phone");}
 private JSONObject notes(JSONObject note)throws Exception{return new JSONObject().put("action","syncNotes").put("version",1).put("notes",new JSONArray().put(note));}
 private JSONObject asset(String hash,int index,int count,String data)throws Exception{return new JSONObject().put("action","syncNoteAsset").put("version",1).put("storageKey","note-peer-owned.png").put("sha256",hash).put("chunkIndex",index).put("chunkCount",count).put("data",data);}
 private JSONObject exchange(JSONObject request)throws Exception{write(request);int n=input.readInt();assertTrue(n>0&&n<=2*1024*1024);byte[] b=new byte[n];input.readFully(b);JSONObject response=new JSONObject(new String(b,StandardCharsets.UTF_8));write(new JSONObject().put("action","ack").put("success",true).put("applied",true).put("phase","applied"));actions++;return response;}
 private void write(JSONObject value)throws Exception{byte[] b=value.toString().getBytes(StandardCharsets.UTF_8);output.writeInt(b.length);output.write(b);output.flush();}
 private static String hash(byte[] b)throws Exception{StringBuilder s=new StringBuilder();for(byte v:MessageDigest.getInstance("SHA-256").digest(b))s.append(String.format(Locale.ROOT,"%02x",v&255));return s.toString();}
}
