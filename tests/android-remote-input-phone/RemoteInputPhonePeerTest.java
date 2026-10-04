package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.bluetooth.*;
import android.content.Context;
import android.os.*;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
/** Physical paired-phone protocol client, restricted to a unique isolated watch service and identity. */
public final class RemoteInputPhonePeerTest {
 BluetoothSocket socket;DataInputStream input;DataOutputStream output;
 @Test public void remoteInputOverBondedBluetooth()throws Exception{
  Context ctx=InstrumentationRegistry.getInstrumentation().getTargetContext();assertEquals("dev.podjs.runtime.test",ctx.getPackageName());Bundle args=InstrumentationRegistry.getArguments();String expected=args.getString("expectedWatchId");assertNotNull(expected);
  BluetoothAdapter adapter=ctx.getSystemService(BluetoothManager.class).getAdapter();BluetoothDevice device=adapter.getRemoteDevice(args.getString("watchAddress"));assertEquals(BluetoothDevice.BOND_BONDED,device.getBondState());
  ScheduledExecutorService deadline=Executors.newSingleThreadScheduledExecutor();try{socket=device.createRfcommSocketToServiceRecord(UUID.fromString("912fb445-c99f-4b81-938a-ecfd527bc6a4"));deadline.schedule(()->{try{socket.close();}catch(Exception ignored){}},60,TimeUnit.SECONDS);socket.connect();input=new DataInputStream(socket.getInputStream());output=new DataOutputStream(socket.getOutputStream());
   JSONObject probe=call(new JSONObject().put("action","syncLibrary").put("phase","probe").put("version",14).put("requestPersistentSession",true).put("supportsPersistentSession",true));assertEquals(expected,probe.getString("deviceId"));assertTrue(probe.getBoolean("persistentSessionAccepted"));
   JSONObject empty=call(new JSONObject().put("version",1).put("action","remoteInput").put("nonce","empty").put("url","  "));assertFalse(empty.getBoolean("success"));assertEquals("缺少 RSS URL",empty.getString("message"));
   for(String url:new String[]{"  https://example.invalid/中文.xml?one=1&two=2  "}){JSONObject response=call(new JSONObject().put("version",1).put("action","remoteInput").put("nonce",System.currentTimeMillis()+"").put("url",url));assertTrue(response.getBoolean("success"));assertEquals("remoteInput",response.getString("action"));}
   assertTrue(call(new JSONObject().put("action","syncSession").put("phase","complete")).getBoolean("success"));
   socket.close();SystemClock.sleep(1000);socket=device.createRfcommSocketToServiceRecord(UUID.fromString("912fb445-c99f-4b81-938a-ecfd527bc6a4"));socket.connect();input=new DataInputStream(socket.getInputStream());output=new DataOutputStream(socket.getOutputStream());JSONObject legacy=call(new JSONObject().put("version",1).put("action","remoteInput").put("nonce","legacy").put("url","https://example.invalid/cancel.xml"));assertTrue(legacy.getBoolean("success"));assertEquals("remoteInput",legacy.getString("action"));
   Bundle proof=new Bundle();proof.putString("remoteInputBluetoothProof",new JSONObject().put("watchId",expected).put("bonded",true).put("acceptedUrls",2).put("connections",2).put("legacyRemoteInputVerified",true).put("rejectedEmptyUrl",true).toString());InstrumentationRegistry.getInstrumentation().sendStatus(0,proof);
  }finally{if(socket!=null)socket.close();deadline.shutdownNow();}
 }
 JSONObject call(JSONObject request)throws Exception{byte[] bytes=request.toString().getBytes(StandardCharsets.UTF_8);output.writeInt(bytes.length);output.write(bytes);output.flush();int count=input.readInt();assertTrue(count>0&&count<=2097152);byte[] response=new byte[count];input.readFully(response);byte[] ack="{\"action\":\"ack\",\"success\":true,\"applied\":true}".getBytes(StandardCharsets.UTF_8);output.writeInt(ack.length);output.write(ack);output.flush();return new JSONObject(new String(response,StandardCharsets.UTF_8));}
}
