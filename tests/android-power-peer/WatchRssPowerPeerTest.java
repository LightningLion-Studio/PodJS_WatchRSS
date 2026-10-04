package dev.podjs.runtime;

import static org.junit.Assert.*;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.os.Bundle;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Owned-device read-only native-protocol probe; address and UUID are explicit test arguments. */
public final class WatchRssPowerPeerTest {
 @Test public void pairedWatchProbeCompletes()throws Exception{
  Bundle args=InstrumentationRegistry.getArguments();String address=args.getString("watchAddress"),uuid=args.getString("serviceUuid");assertNotNull(address);assertNotNull(uuid);
  BluetoothAdapter adapter=InstrumentationRegistry.getInstrumentation().getTargetContext().getSystemService(BluetoothManager.class).getAdapter();assertNotNull(adapter);assertTrue(adapter.isEnabled());BluetoothDevice watch=adapter.getRemoteDevice(address);assertEquals("Watch must already be paired",BluetoothDevice.BOND_BONDED,watch.getBondState());
  ScheduledExecutorService deadline=Executors.newSingleThreadScheduledExecutor();AtomicBoolean watchdogClosed=new AtomicBoolean();
  try(BluetoothSocket socket=watch.createRfcommSocketToServiceRecord(UUID.fromString(uuid))){
   deadline.schedule(()->{watchdogClosed.set(true);try{socket.close();}catch(Exception ignored){}},40,TimeUnit.SECONDS);socket.connect();assertTrue(socket.isConnected());
   DataOutputStream output=new DataOutputStream(socket.getOutputStream());DataInputStream input=new DataInputStream(socket.getInputStream());
   write(output,new JSONObject().put("version",14).put("action","syncLibrary").put("phase","probe").put("deviceId","power-verification-phone"));
   int length=input.readInt();assertTrue(length>0&&length<=2*1024*1024);byte[] bytes=new byte[length];input.readFully(bytes);JSONObject response=new JSONObject(new String(bytes,StandardCharsets.UTF_8));
   assertTrue(response.getBoolean("success"));assertEquals(14,response.getInt("version"));assertEquals("syncLibrary",response.getString("action"));assertEquals("probe",response.getString("phase"));assertFalse(response.getString("deviceId").isEmpty());assertTrue(response.getBoolean("supportsManifestBatches"));assertFalse(response.getBoolean("ipUpgradeAccepted"));
   Bundle proof=new Bundle();proof.putString("probeResponse",response.toString());InstrumentationRegistry.getInstrumentation().sendStatus(0,proof);
   Thread.sleep(Long.parseLong(args.getString("ackHoldMs","5000")));write(output,new JSONObject().put("action","ack").put("success",true).put("phase","applied").put("applied",true));boolean remoteClosed;try{remoteClosed=input.read()==-1;}catch(IOException closed){if(!watchdogClosed.get()&&String.valueOf(closed.getMessage()).contains("read return: -1"))remoteClosed=true;else throw closed;}assertTrue("Watch closes the completed nonpersistent session",remoteClosed);assertFalse("Deadline did not close the socket",watchdogClosed.get());
  }finally{deadline.shutdownNow();}
 }
 private static void write(DataOutputStream out,JSONObject value)throws Exception{byte[] bytes=value.toString().getBytes(StandardCharsets.UTF_8);out.writeInt(bytes.length);out.write(bytes);out.flush();}
}
