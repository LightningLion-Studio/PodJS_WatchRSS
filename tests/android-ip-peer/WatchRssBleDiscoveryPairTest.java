package dev.podjs.runtime;

import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelUuid;
import android.util.Base64;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Private advertisement fixture; never advertises the production WatchRSS UUID/marker. */
public final class WatchRssBleDiscoveryPairTest {
    static final UUID ADVERTISED=UUID.fromString("d705cb11-328b-427c-9c35-3d3ba5f77c51");
    static final UUID SERVICE=UUID.fromString("d705cb12-328b-427c-9c35-3d3ba5f77c51");
    static final UUID CHARACTERISTIC=UUID.fromString("d705cb13-328b-427c-9c35-3d3ba5f77c51");
    static final byte[] MARKER="PODD".getBytes(StandardCharsets.US_ASCII);
    static final byte[] PAYLOAD=("{\"fixture\":\"配对手机 BLE 端点读取\",\"version\":2,\"padding\":\""+repeat("0123456789abcdef",16)+"\"}").getBytes(StandardCharsets.UTF_8);
    private static String repeat(String value,int count){StringBuilder s=new StringBuilder();for(int i=0;i<count;i++)s.append(value);return s.toString();}
    private static Context context(){return InstrumentationRegistry.getInstrumentation().getTargetContext();}
    private static void proof(String name,JSONObject value){Bundle status=new Bundle();status.putString(name,value.toString());InstrumentationRegistry.getInstrumentation().sendStatus(0,status);}
    static String hash(byte[] value)throws Exception{StringBuilder s=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(value))s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();}
    static JSONObject request()throws Exception{return new JSONObject().put("advertisedServiceUuid",ADVERTISED.toString()).put("manufacturerId",65535).put("manufacturerDataBase64",Base64.encodeToString(MARKER,Base64.NO_WRAP)).put("serviceUuid",SERVICE.toString()).put("characteristicUuid",CHARACTERISTIC.toString()).put("bondedOnly",true).put("scanTimeoutMs",8000).put("readTimeoutMs",12000);}

    @Test public void phoneAdvertisesForSelectedBondedWatch()throws Exception{
        String peer=InstrumentationRegistry.getArguments().getString("watchAddress");assertNotNull("Explicit watch address required",peer);
        BluetoothManager manager=context().getSystemService(BluetoothManager.class);BluetoothAdapter adapter=manager.getAdapter();assertTrue(adapter.isEnabled());assertEquals(BluetoothDevice.BOND_BONDED,adapter.getRemoteDevice(peer).getBondState());
        CompletableFuture<Boolean> added=new CompletableFuture<>(),advertised=new CompletableFuture<>(),finished=new CompletableFuture<>();AtomicInteger reads=new AtomicInteger();
        BluetoothGattServer[] server=new BluetoothGattServer[1];
        BluetoothGattServerCallback callback=new BluetoothGattServerCallback(){
            public void onServiceAdded(int status,BluetoothGattService service){if(status==BluetoothGatt.GATT_SUCCESS)added.complete(true);else added.completeExceptionally(new IllegalStateException("service add "+status));}
            public void onConnectionStateChange(BluetoothDevice device,int status,int state){if(device.getAddress().equalsIgnoreCase(peer)&&state==BluetoothProfile.STATE_DISCONNECTED&&reads.get()>0)finished.complete(true);}
            public void onCharacteristicReadRequest(BluetoothDevice device,int requestId,int offset,BluetoothGattCharacteristic characteristic){
                boolean selected=device.getAddress().equalsIgnoreCase(peer)&&device.getBondState()==BluetoothDevice.BOND_BONDED&&characteristic.getUuid().equals(CHARACTERISTIC);
                int status=!selected?BluetoothGatt.GATT_READ_NOT_PERMITTED:offset>PAYLOAD.length?BluetoothGatt.GATT_INVALID_OFFSET:BluetoothGatt.GATT_SUCCESS;
                byte[] value=status==BluetoothGatt.GATT_SUCCESS?Arrays.copyOfRange(PAYLOAD,offset,PAYLOAD.length):new byte[0];
                if(status==BluetoothGatt.GATT_SUCCESS)reads.incrementAndGet();
                server[0].sendResponse(device,requestId,status,offset,value);
            }
        };
        BluetoothLeAdvertiser advertiser=adapter.getBluetoothLeAdvertiser();assertNotNull(advertiser);
        AdvertiseCallback advertising=new AdvertiseCallback(){public void onStartSuccess(AdvertiseSettings settings){advertised.complete(true);}public void onStartFailure(int code){advertised.completeExceptionally(new IllegalStateException("advertising "+code));}};
        try{
            server[0]=manager.openGattServer(context(),callback);assertNotNull(server[0]);BluetoothGattService service=new BluetoothGattService(SERVICE,BluetoothGattService.SERVICE_TYPE_PRIMARY);service.addCharacteristic(new BluetoothGattCharacteristic(CHARACTERISTIC,BluetoothGattCharacteristic.PROPERTY_READ,BluetoothGattCharacteristic.PERMISSION_READ));assertTrue(server[0].addService(service));assertTrue(added.get(5,TimeUnit.SECONDS));
            advertiser.startAdvertising(new AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY).setConnectable(true).setTimeout(60000).build(),new AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(new ParcelUuid(ADVERTISED)).addManufacturerData(65535,MARKER).build(),advertising);assertTrue(advertised.get(5,TimeUnit.SECONDS));
            proof("bleDiscoveryReady",new JSONObject().put("bytes",PAYLOAD.length).put("sha256",hash(PAYLOAD)).put("privateAdvertisement",true));assertTrue(finished.get(50,TimeUnit.SECONDS));
            proof("bleDiscoveryPhoneProof",new JSONObject().put("reads",reads.get()).put("selectedBondedWatch",true).put("sha256",hash(PAYLOAD)).put("gattDisconnected",true));
        }finally{advertiser.stopAdvertising(advertising);if(server[0]!=null){server[0].clearServices();server[0].close();}}
    }
    @Test public void watchReadsBondedPhoneCharacteristic()throws Exception{
        android.app.Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        android.app.Activity foreground=instrumentation.startActivitySync(new android.content.Intent(context(),VideoTestActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        instrumentation.waitForIdleSync();
        try(PodBleDiscoveryServices discovery=new PodBleDiscoveryServices(context())){
            proof("bleDiscoveryWatchForegroundReady",new JSONObject().put("resumed",true));
            long until=android.os.SystemClock.elapsedRealtime()+10000;
            JSONObject status;
            do{status=discovery.execute("discovery.status",new JSONObject(),new CancellationSignal());if("granted".equals(status.getString("permission")))break;Thread.sleep(50);}while(android.os.SystemClock.elapsedRealtime()<until);
            assertTrue(status.toString(),status.getBoolean("enabled"));assertEquals("granted",status.getString("permission"));
            String phoneAddress=InstrumentationRegistry.getArguments().getString("phoneAddress");assertNotNull(phoneAddress);
            boolean refreshed=preparePrivateServiceCache(phoneAddress);
            JSONObject result=discovery.execute("discovery.bleReadCharacteristic",request(),new CancellationSignal());byte[] bytes=Base64.decode(result.getString("dataBase64"),Base64.DEFAULT);assertTrue(result.getBoolean("bonded"));assertEquals(phoneAddress.toUpperCase(java.util.Locale.ROOT),result.getString("address").toUpperCase(java.util.Locale.ROOT));assertArrayEquals(PAYLOAD,bytes);
            proof("bleDiscoveryWatchProof",new JSONObject().put("bytes",bytes.length).put("sha256",hash(bytes)).put("bonded",true).put("actualBleRadio",true).put("wirelessIpVerified",false).put("foregroundActivity",true).put("privateServiceCacheRefreshed",refreshed));
        }finally{instrumentation.runOnMainSync(foreground::finish);}
    }
    /** A temporary GATT provider can be absent from the bonded device cache.
     * This is fixture preparation, never a production SDK fallback or pairing change. */
    private boolean preparePrivateServiceCache(String address)throws Exception{
        BluetoothAdapter adapter=context().getSystemService(BluetoothManager.class).getAdapter();BluetoothDevice peer=adapter.getRemoteDevice(address);assertEquals(BluetoothDevice.BOND_BONDED,peer.getBondState());
        CompletableFuture<BluetoothGatt> services=new CompletableFuture<>();
        BluetoothGatt connection=peer.connectGatt(context(),false,new BluetoothGattCallback(){
            public void onConnectionStateChange(BluetoothGatt gatt,int status,int state){if(status==BluetoothGatt.GATT_SUCCESS&&state==BluetoothProfile.STATE_CONNECTED){if(!gatt.discoverServices())services.completeExceptionally(new IllegalStateException("Preflight discovery rejected"));}else if(status!=BluetoothGatt.GATT_SUCCESS)services.completeExceptionally(new IllegalStateException("Preflight connection "+status));}
            public void onServicesDiscovered(BluetoothGatt gatt,int status){if(status==BluetoothGatt.GATT_SUCCESS)services.complete(gatt);else services.completeExceptionally(new IllegalStateException("Preflight services "+status));}
        },BluetoothDevice.TRANSPORT_LE);
        assertNotNull(connection);
        try{
            BluetoothGatt discovered=services.get(8,TimeUnit.SECONDS);org.json.JSONArray uuids=new org.json.JSONArray();for(BluetoothGattService service:discovered.getServices())uuids.put(service.getUuid().toString());
            boolean missing=discovered.getService(SERVICE)==null;
            proof("bleDiscoveryCacheProbe",new JSONObject().put("services",uuids).put("privateServiceMissing",missing));
            if(missing){Object cleared=BluetoothGatt.class.getMethod("refresh").invoke(discovered);assertEquals(Boolean.TRUE,cleared);return true;}
            return false;
        }finally{connection.disconnect();connection.close();}
    }
}
