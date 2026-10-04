package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.bluetooth.*;
import android.content.Context;
import android.graphics.*;
import android.os.*;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
/** Paired physical-phone protocol client. Writes only after checking the owned watch identity. */
public final class ReaderTransferPhoneTest {
 static final int CHUNK=1048576;BluetoothSocket socket;DataInputStream input;DataOutputStream output;BluetoothDevice device;String expected;int sequence,connections;volatile boolean timedOut;final String session="reader-transfer-phone";
 @Test public void sendRenderableAssetsOverBondedBluetooth()throws Exception{
  Context ctx=InstrumentationRegistry.getInstrumentation().getTargetContext();assertEquals("dev.podjs.runtime.test",ctx.getPackageName());Bundle args=InstrumentationRegistry.getArguments();expected=args.getString("expectedWatchId");assertNotNull(expected);
  BluetoothAdapter adapter=ctx.getSystemService(BluetoothManager.class).getAdapter();assertNotNull(adapter);assertTrue(adapter.isEnabled());device=adapter.getRemoteDevice(args.getString("watchAddress"));assertEquals(BluetoothDevice.BOND_BONDED,device.getBondState());
  ScheduledExecutorService guard=Executors.newSingleThreadScheduledExecutor();guard.schedule(()->{timedOut=true;try{if(socket!=null)socket.close();}catch(Exception ignored){}},8,TimeUnit.MINUTES);
  try{Map<String,byte[]> data=new LinkedHashMap<>();data.put("font/reader-serif.otf",asset("reader-serif.otf"));data.put("background/image.png",image(720,640,true));data.put("background/clip.mp4",asset("clip.mp4"));data.put("variant/clip.mp4",asset("clip.mp4"));data.put("variant/poster.png",image(200,120,false));assertTrue("image must exercise multiple native chunks",data.get("background/image.png").length>CHUNK);
   connect();JSONObject manifest=new JSONObject().put("action","syncReader").put("phase","manifest");
   byte[] font=data.get("font/reader-serif.otf");JSONObject fontRow=common("phone-font",font).put("familyName","Transferred serif").put("fileName","reader-serif.otf").put("mimeType","font/otf").put("faceCount",1).put("metadataJson","{}");
   JSONObject imageRow=background("phone-image","IMAGE","image.png",data.get("background/image.png"),720,640,new JSONObject());
   JSONObject videoRow=background("phone-video","VIDEO","clip.mp4",data.get("background/clip.mp4"),200,120,new JSONObject().put("watch",variant("clip.mp4",data.get("variant/clip.mp4"))).put("watchPoster",variant("poster.png",data.get("variant/poster.png"))));
   JSONObject received=call(manifest.put("fonts",new JSONArray().put(fontRow)).put("backgrounds",new JSONArray().put(imageRow).put(videoRow)));assertEquals(5,received.getJSONArray("missingResources").length());
   JSONObject base=new JSONObject(new String(asset("preset.json"),StandardCharsets.UTF_8));preview("update","baseline",base);barrier("baseline");
   upload("font","reader-serif.otf",font);JSONObject custom=new JSONObject(base.toString());custom.getJSONObject("body").put("fontAssetId","phone-font");preview("update","font",custom);barrier("font");
   JSONObject imagePreset=new JSONObject(custom.toString());imagePreset.getJSONObject("background").put("type","IMAGE").put("assetId","phone-image").put("overlayOpacity",.65);
   preview("resourceHandoff","handoff",imagePreset);barrier("handoff");byte[] photo=data.get("background/image.png");assertFalse(push("background","image.png",photo,0).getBoolean("applied"));assertFalse(push("background","image.png",photo,0).getBoolean("applied"));
   preview("resourceHandoff","partial",imagePreset);barrier("partial");socket.close();SystemClock.sleep(1200);connect();
   JSONObject missing=call(new JSONObject().put("action","syncReader").put("phase","manifest"));assertEquals(4,missing.getJSONArray("missingResources").length());
   for(int index=1;index<(photo.length+CHUNK-1)/CHUNK;index++)assertEquals(index==(photo.length-1)/CHUNK,push("background","image.png",photo,index).getBoolean("applied"));
   preview("update","image",imagePreset);barrier("image");
   // Large pulls and the remaining transfers should not expire the visible preview.
   for(String path:new String[]{"background/clip.mp4","variant/clip.mp4","variant/poster.png"}){String[] parts=path.split("/",2);upload(parts[0],parts[1],data.get(path));}
   JSONObject videoPreset=new JSONObject(custom.toString());videoPreset.getJSONObject("background").put("type","VIDEO").put("assetId","phone-video").put("overlayOpacity",.6);preview("update","video",videoPreset);barrier("video");
   call(new JSONObject().put("action","previewReader").put("version",2).put("sessionId",session).put("phase","stop"));
   JSONObject finalManifest=call(new JSONObject().put("action","syncReader").put("phase","manifest"));assertEquals(0,finalManifest.getJSONArray("missingResources").length());
   JSONObject sourceHashes=new JSONObject();for(Map.Entry<String,byte[]> e:data.entrySet()){String[] p=e.getKey().split("/",2);ByteArrayOutputStream pulled=new ByteArrayOutputStream();for(int index=0;index<(e.getValue().length+CHUNK-1)/CHUNK;index++){JSONObject part=call(new JSONObject().put("action","syncReader").put("phase","pullResource").put("kind",p[0]).put("fileName",p[1]).put("chunkIndex",index));byte[] bytes=Base64.getDecoder().decode(part.getString("data"));assertEquals(hash(bytes),part.getString("chunkSha256"));pulled.write(bytes);}assertArrayEquals(e.getKey(),e.getValue(),pulled.toByteArray());sourceHashes.put(e.getKey(),new JSONObject().put("sha256",hash(e.getValue())).put("bytes",e.getValue().length));}
   barrier("stopped");upload("variant","phone-finished.json","done".getBytes(StandardCharsets.UTF_8));call(new JSONObject().put("action","syncSession").put("phase","complete"));try{assertEquals(-1,input.read());}catch(IOException closed){assertFalse("Socket watchdog expired",timedOut);assertTrue(closed.toString(),closed.getMessage()!=null&&closed.getMessage().contains("bt socket closed"));}
   JSONObject proof=new JSONObject().put("passed",true).put("watchId",expected).put("bondedRfcomm",true).put("adbRelay",false).put("peerClosedAfterCompletion",true).put("connections",connections).put("duplicateFirstChunk",true).put("resumedAfterDisconnect",true).put("exactPull",true).put("missingResources",0).put("sourceFiles",sourceHashes);
   try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"transfer-phone-proof.json"))){out.write(proof.toString().getBytes(StandardCharsets.UTF_8));}Bundle status=new Bundle();status.putString("readerTransferProof",proof.toString());InstrumentationRegistry.getInstrumentation().sendStatus(0,status);
  }finally{if(socket!=null)socket.close();guard.shutdownNow();}
 }
 void connect()throws Exception{socket=device.createRfcommSocketToServiceRecord(UUID.fromString("bb2f0b7d-8f2f-4a96-95b2-d2c91d58a861"));socket.connect();input=new DataInputStream(socket.getInputStream());output=new DataOutputStream(socket.getOutputStream());JSONObject p=call(new JSONObject().put("action","syncLibrary").put("phase","probe").put("version",14).put("requestPersistentSession",true).put("supportsPersistentSession",true));assertEquals("Refuse resource writes to any other watch database",expected,p.getString("deviceId"));assertTrue(p.getBoolean("persistentSessionAccepted"));connections++;}
 JSONObject call(JSONObject request)throws Exception{if(request.optString("action").equals("syncReader")){request.put("version",11);if(request.optString("phase").equals("manifest"))request.put("deviceId","physical-phone-fixture");}byte[] bytes=request.toString().getBytes(StandardCharsets.UTF_8);output.writeInt(bytes.length);output.write(bytes);output.flush();int n=input.readInt();assertTrue(n>0&&n<=2*1024*1024);byte[] payload=new byte[n];input.readFully(payload);JSONObject result=new JSONObject(new String(payload,StandardCharsets.UTF_8));assertTrue(result.toString(),result.getBoolean("success"));byte[] ack="{\"action\":\"ack\",\"success\":true,\"applied\":true}".getBytes(StandardCharsets.UTF_8);output.writeInt(ack.length);output.write(ack);output.flush();return result;}
 void preview(String phase,String name,JSONObject preset)throws Exception{JSONObject p=new JSONObject(preset.toString()).put("name",name);assertTrue(call(new JSONObject().put("action","previewReader").put("version",2).put("sessionId",session).put("sequence",sequence++).put("phase",phase).put("preset",p)).getBoolean("applied"));}
 void barrier(String stage)throws Exception{long until=SystemClock.uptimeMillis()+45000;while(SystemClock.uptimeMillis()<until){JSONObject part=call(new JSONObject().put("action","syncReader").put("phase","pullResource").put("kind","variant").put("fileName","receipt-"+stage+".json").put("chunkIndex",0));if(new String(Base64.getDecoder().decode(part.getString("data")),StandardCharsets.UTF_8).equals("done"))return;SystemClock.sleep(250);}throw new AssertionError("Watch UI did not accept "+stage);}
 void upload(String kind,String name,byte[] data)throws Exception{for(int i=0;i<(data.length+CHUNK-1)/CHUNK;i++)assertEquals(i==(data.length-1)/CHUNK,push(kind,name,data,i).getBoolean("applied"));}
 JSONObject push(String kind,String name,byte[] data,int index)throws Exception{byte[] chunk=Arrays.copyOfRange(data,index*CHUNK,Math.min(data.length,(index+1)*CHUNK));return call(new JSONObject().put("action","syncReader").put("phase","pushResource").put("kind",kind).put("fileName",name).put("sha256",hash(data)).put("totalBytes",data.length).put("chunkIndex",index).put("chunkCount",(data.length+CHUNK-1)/CHUNK).put("chunkSha256",hash(chunk)).put("data",Base64.getEncoder().encodeToString(chunk)));}
 static JSONObject common(String id,byte[] data)throws Exception{return new JSONObject().put("id",id).put("sha256",hash(data)).put("byteCount",data.length).put("displayName",id).put("updatedAt",10).put("modifiedBy","physical-phone-fixture").put("deleted",false);}
 static JSONObject background(String id,String kind,String name,byte[] bytes,int w,int h,JSONObject variants)throws Exception{return common(id,bytes).put("kind",kind).put("mimeType",kind.equals("IMAGE")?"image/png":"video/mp4").put("masterFileName",name).put("width",w).put("height",h).put("durationMs",kind.equals("IMAGE")?0:4020).put("variantsJson",variants.toString()).put("posterAssetId","");}
 static JSONObject variant(String name,byte[] data)throws Exception{return new JSONObject().put("fileName",name).put("sha256",hash(data)).put("byteCount",data.length);}
 static byte[] asset(String name)throws Exception{try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name)){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] bytes=new byte[65536];int count;while((count=in.read(bytes))!=-1)out.write(bytes,0,count);return out.toByteArray();}}
 static byte[] image(int w,int h,boolean noise)throws Exception{Bitmap b=Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888);int[] pixels=new int[w*h];Random rng=new Random(8819);for(int y=0;y<h;y++)for(int x=0;x<w;x++)pixels[y*w+x]=noise?0xff000000|rng.nextInt(0x1000000):Color.rgb(x*255/(w-1),y*255/(h-1),((x/20+y/15)%2)*180+30);b.setPixels(pixels,0,w,0,0,w,h);ByteArrayOutputStream out=new ByteArrayOutputStream();assertTrue(b.compress(Bitmap.CompressFormat.PNG,100,out));b.recycle();return out.toByteArray();}
 static String hash(byte[] bytes)throws Exception{StringBuilder text=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))text.append(String.format(Locale.ROOT,"%02x",b&255));return text.toString();}
}
