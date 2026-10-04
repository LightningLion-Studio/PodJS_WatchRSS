package dev.podjs.runtime;

import static org.junit.Assert.*;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.os.Bundle;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Physical bonded-phone test for native watchToPhoneReplace article handling. */
public final class WatchSourcePhoneTest {
 @Test public void sourceModeCountsButDoesNotApplyPhoneArticle() throws Exception {
  String address=InstrumentationRegistry.getArguments().getString("watchAddress");assertNotNull(address);
  BluetoothAdapter adapter=InstrumentationRegistry.getInstrumentation().getTargetContext().getSystemService(BluetoothManager.class).getAdapter();
  assertNotNull(adapter);assertTrue(adapter.isEnabled());BluetoothDevice watch=adapter.getRemoteDevice(address);
  assertEquals(BluetoothDevice.BOND_BONDED,watch.getBondState());
  ScheduledExecutorService guard=Executors.newSingleThreadScheduledExecutor();
  try(BluetoothSocket socket=watch.createRfcommSocketToServiceRecord(UUID.fromString("a98a29ad-5cde-43f5-a049-e80b3e7bb801"))){
   guard.schedule(()->{try{socket.close();}catch(Exception ignored){}},60,TimeUnit.SECONDS);
   socket.connect();DataInputStream input=new DataInputStream(socket.getInputStream());DataOutputStream output=new DataOutputStream(socket.getOutputStream());
   JSONObject manifest=new JSONObject().put("version",14).put("action","syncLibrary").put("phase","manifest")
    .put("deviceId","watch-source-phone-fixture").put("libraryMode","watchToPhoneReplace")
    .put("supportsChunkedBodies",true).put("supportsArticleBatches",true).put("supportsManifestBatches",true)
    .put("supportsMetadataOnlyArticles",true).put("supportsChangeSequences",true).put("fullSnapshot",true)
    .put("changeSeqRange",new JSONObject().put("fromExclusive",0).put("toInclusive",71))
    .put("articleManifest",new JSONArray()).put("rssSources",new JSONArray());
   write(output,manifest);JSONObject selected=read(input);assertTrue(selected.toString(),selected.getBoolean("success"));
   assertEquals("manifest",selected.getString("phase"));assertEquals(0,selected.getJSONArray("bodyRequests").length());
   JSONObject article=new JSONObject().put("articleId","remote-only").put("url","https://phone.example/post")
    .put("title","Phone article").put("body",new JSONObject().put("bodyHash","hash").put("bodyByteCount",1)
      .put("chunkSize",1).put("chunkHashes",new JSONArray().put("chunk"))
      .put("chunks",new JSONArray().put(new JSONObject().put("index",0).put("hash","chunk").put("data","AA=="))));
   write(output,new JSONObject().put("version",14).put("action","syncLibrary").put("phase","articles")
    .put("articles",new JSONArray().put(article)).put("bodyRequests",new JSONArray()));
   JSONObject complete=read(input);assertTrue(complete.toString(),complete.getBoolean("success"));
   assertEquals("complete",complete.getString("phase"));assertEquals(0,complete.getJSONArray("articles").length());
   JSONObject stats=complete.getJSONObject("stats");assertEquals(0,stats.getInt("applied"));
   write(output,new JSONObject().put("action","ack").put("success",true).put("phase","applied").put("applied",true));
   Bundle proof=new Bundle();proof.putString("watchSourceProof",new JSONObject().put("bondedRfcomm",true)
    .put("incomingArticles",1).put("applied",0).put("outgoingArticles",0).put("ackApplied",true)
    .put("watchId",selected.getString("deviceId")).toString());
   InstrumentationRegistry.getInstrumentation().sendStatus(0,proof);
  }finally{guard.shutdownNow();}
 }
 private static void write(DataOutputStream output,JSONObject frame)throws Exception {byte[] bytes=frame.toString().getBytes(StandardCharsets.UTF_8);output.writeInt(bytes.length);output.write(bytes);output.flush();}
 private static JSONObject read(DataInputStream input)throws Exception {int size=input.readInt();assertTrue(size>0&&size<=2*1024*1024);byte[] bytes=new byte[size];input.readFully(bytes);return new JSONObject(new String(bytes,StandardCharsets.UTF_8));}
}
