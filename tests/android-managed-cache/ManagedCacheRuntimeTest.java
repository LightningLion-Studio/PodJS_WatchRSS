package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.app.*;import android.content.*;import android.graphics.*;import android.os.*;import android.view.*;
import androidx.test.platform.app.InstrumentationRegistry;import org.json.*;import org.junit.Test;
import java.io.*;import java.net.*;import java.nio.charset.StandardCharsets;import java.nio.file.Files;import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;
public final class ManagedCacheRuntimeTest {
 @Test public void fileEnumerationIsBoundedAndConfined()throws Exception{
  Context ctx=InstrumentationRegistry.getInstrumentation().getTargetContext();assertEquals("dev.podjs.tests.managedcache",ctx.getPackageName());File root=new File(ctx.getFilesDir(),"podjs/files"),own=new File(root,"list-test");assertTrue(own.mkdirs());
  try(PodDeviceServices files=new PodDeviceServices(ctx)){
   assertEquals(0,files.execute("file.list",new JSONObject().put("path","missing")).getJSONArray("entries").length());File kept=new File(own,"kept");Files.write(kept.toPath(),new byte[]{1,2,3});assertTrue(kept.setLastModified(1));assertTrue(files.execute("file.touch",new JSONObject().put("path","list-test/kept")).getLong("modified")>1);
   JSONObject item=files.execute("file.list",new JSONObject().put("path","list-test")).getJSONArray("entries").getJSONObject(0);assertEquals("list-test/kept",item.getString("path"));assertEquals(3,item.getLong("size"));assertTrue(item.getBoolean("file"));
   for(String method:new String[]{"file.list","file.touch"})try{files.execute(method,new JSONObject().put("path","../outside"));fail("Traversal accepted");}catch(SecurityException expected){}
   File link=new File(own,"link");android.system.Os.symlink(kept.getAbsolutePath(),link.getAbsolutePath());try{files.execute("file.list",new JSONObject().put("path","list-test"));fail("Symlink accepted");}catch(SecurityException expected){}assertTrue(link.delete());assertTrue(kept.delete());
   for(int n=0;n<10001;n++)assertTrue(new File(own,"f"+n).createNewFile());try{files.execute("file.list",new JSONObject().put("path","list-test"));fail("Unbounded directory accepted");}catch(IOException expected){assertEquals("directory_too_large",expected.getMessage());}
  }finally{for(File f:own.listFiles())f.delete();own.delete();}
 }
 @Test public void cacheDownloadReaderImageSettingsAndActivityReopen()throws Exception{
  Instrumentation i=InstrumentationRegistry.getInstrumentation();Context ctx=i.getTargetContext();assertEquals("dev.podjs.tests.managedcache",ctx.getPackageName());File root=new File(ctx.getFilesDir(),"podjs/files");root.mkdirs();
  write(new File(root,"managed-cache/rss-offline/kept.bin"),"offline-kept");write(new File(root,"reader-assets/kept.bin"),"resource-kept");write(new File(root,"managed-cache/images/user.tmp"),"unknown-kept");
  try(ImageServer server=new ImageServer(root)){
   write(new File(root,"cache-server.json"),new JSONObject().put("baseUrl","http://127.0.0.1:"+server.port()).toString());
   Activity activity=start(i,ctx);JSONObject proof=new JSONObject();Bitmap cold=null;
   try{
    PodRuntimeView view=awaitView(activity);
    for(String stage:new String[]{"prefetch-off","prefetch-four","prefetch-all","cancelled","cold-image","tiled-image","cache-min","cache-max","media-off","media-four","media-all","keep-off","keep-on"}){
     awaitStage(ctx,stage,45000);
     if(stage.equals("prefetch-off")){assertEquals(1,server.count("/0.png"));assertEquals(1,server.total());JSONObject all=kv(ctx);File nativeRoot=new File(ctx.getCacheDir(),"native-cache-policy");nativeRoot.mkdirs();ManagedCacheNativePolicy.verify(InstrumentationRegistry.getArguments().getString("nativeReferenceApk"),nativeRoot,all.getJSONObject("managed-cache-native-policy"));proof.put("nativePolicy",all.getJSONObject("managed-cache-native-policy"));}
     if(stage.equals("prefetch-four")){assertEquals(2,server.count("/0.png"));for(int n=1;n<4;n++)assertEquals(1,server.count("/"+n+".png"));assertEquals(0,server.count("/4.png"));assertEquals(5,server.total());}
     if(stage.equals("prefetch-all")){for(int n=1;n<6;n++)assertEquals(1,server.count("/"+n+".png"));assertEquals(7,server.total());}
     if(stage.equals("cancelled")){assertTrue("Cancelled requests left sockets open",server.slowClosed.await(6,TimeUnit.SECONDS));for(File f:new File(root,"managed-cache/images").listFiles())assertFalse(f.getName(),f.getName().contains(".download-"));proof.put("pendingDownloadsCancelled",true);}
     if(stage.equals("cold-image")||stage.equals("tiled-image")||stage.startsWith("cache-")||stage.startsWith("media-")||stage.startsWith("keep-")){
      SystemClock.sleep(250);Bitmap frame=bitmap(i,view);assertNotNull(frame);save(ctx,stage,frame);if(stage.equals("tiled-image")){assertEquals(0xffe02040,frame.getPixel(232,232));assertEquals(3,server.count("/0.png"));}if(stage.equals("cold-image")){assertEquals(0xffe02040,frame.getPixel(232,232));cold=frame;}else frame.recycle();
     }
     proof.put(stage,result(ctx));new File(root,"cache-advance-"+stage).createNewFile();
    }
    awaitStage(ctx,"done",15000);JSONObject done=result(ctx);assertEquals("passed",done.getString("state"));assertEquals(0,done.getJSONObject("resources").getInt("active"));assertEquals(0,done.getJSONObject("resources").getInt("cached"));proof.put("firstRun",done);
    int requests=server.total();write(new File(root,"cache-warm"),"true");i.runOnMainSync(activity::finish);i.waitForIdleSync();SystemClock.sleep(500);activity=start(i,ctx);view=awaitView(activity);awaitStage(ctx,"warm-image",30000);SystemClock.sleep(250);Bitmap warm=bitmap(i,view);assertNotNull(warm);save(ctx,"warm-image",warm);assertEquals(0xffe02040,warm.getPixel(232,232));for(int y=132;y<332;y++)for(int x=132;x<332;x++)assertEquals(cold.getPixel(x,y),warm.getPixel(x,y));assertEquals("Warm activity downloaded again",requests,server.total());warm.recycle();cold.recycle();cold=null;new File(root,"cache-advance-warm-image").createNewFile();awaitStage(ctx,"warm-done",15000);assertEquals("passed",result(ctx).getString("state"));
    i.runOnMainSync(activity::finish);i.waitForIdleSync();SystemClock.sleep(300);
    File[] cached=new File(root,"managed-cache/images").listFiles(f->f.getName().matches("[a-f0-9]{64}\\.img"));assertEquals(1,cached.length);write(cached[0],"corrupted-owned-image");assertTrue(new File(root,"cache-advance-warm-image").delete());
    int beforeRepair=server.total();activity=start(i,ctx);view=awaitView(activity);awaitStage(ctx,"warm-image",30000);Bitmap repaired=bitmap(i,view);assertEquals(0xffe02040,repaired.getPixel(232,232));save(ctx,"repaired-image",repaired);repaired.recycle();assertEquals(beforeRepair+1,server.total());new File(root,"cache-advance-warm-image").createNewFile();awaitStage(ctx,"warm-done",15000);proof.put("corruptCacheRepaired",true);
    assertEquals("unknown-kept",new String(Files.readAllBytes(new File(root,"managed-cache/images/user.tmp").toPath()),StandardCharsets.UTF_8));
    assertEquals("offline-kept",new String(Files.readAllBytes(new File(root,"managed-cache/rss-offline/kept.bin").toPath()),StandardCharsets.UTF_8));assertEquals("resource-kept",new String(Files.readAllBytes(new File(root,"reader-assets/kept.bin").toPath()),StandardCharsets.UTF_8));
    proof.put("warmRun",result(ctx)).put("httpRequests",server.countsJson()).put("activityReopenReusedDisk",true).put("imageRegionEqual",true).put("noSyntheticInput",true).put("transport","device-loopback").put("passed",true);write(new File(ctx.getFilesDir(),"managed-cache-proof.json"),proof.toString());
   }finally{Activity finalActivity=activity;i.runOnMainSync(finalActivity::finish);if(cold!=null)cold.recycle();}
  }
 }
 static final class ImageServer implements AutoCloseable {
  final ServerSocket server;final ExecutorService workers=Executors.newFixedThreadPool(4);final ConcurrentHashMap<String,AtomicInteger> counts=new ConcurrentHashMap<>();final Set<Socket> sockets=ConcurrentHashMap.newKeySet();final CountDownLatch slowClosed=new CountDownLatch(2);final AtomicInteger slowReady=new AtomicInteger();final byte[] png;final File root;volatile boolean closed;
  ImageServer(File root)throws Exception{this.root=root;Bitmap image=Bitmap.createBitmap(1024,1024,Bitmap.Config.ARGB_8888);image.eraseColor(0xffe02040);ByteArrayOutputStream bytes=new ByteArrayOutputStream();image.compress(Bitmap.CompressFormat.PNG,100,bytes);png=bytes.toByteArray();image.recycle();server=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));Thread accept=new Thread(()->{while(!closed)try{Socket socket=server.accept();sockets.add(socket);workers.submit(()->serve(socket));}catch(Exception e){if(!closed)throw new RuntimeException(e);}});accept.setDaemon(true);accept.start();}
  int port(){return server.getLocalPort();}int count(String p){AtomicInteger n=counts.get(p);return n==null?0:n.get();}int total(){int n=0;for(AtomicInteger c:counts.values())n+=c.get();return n;}JSONObject countsJson()throws Exception{JSONObject value=new JSONObject();for(String key:counts.keySet())value.put(key,count(key));return value;}
  void serve(Socket socket){boolean slow=false;try{socket.setSoTimeout(25000);BufferedReader reader=new BufferedReader(new InputStreamReader(socket.getInputStream(),StandardCharsets.US_ASCII));String first=reader.readLine();String path=first.split(" ")[1];for(String line;(line=reader.readLine())!=null&&!line.isEmpty();){}counts.computeIfAbsent(path,k->new AtomicInteger()).incrementAndGet();slow=path.startsWith("/slow");OutputStream out=socket.getOutputStream();out.write(("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: "+(slow?10000000:png.length)+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.write(slow?new byte[]{1}:png);out.flush();if(slow){if(slowReady.incrementAndGet()==2)write(new File(root,"cache-slow-ready"),"true");if(reader.read()==-1)slowClosed.countDown();}}catch(Exception error){if(slow&&error instanceof SocketException)slowClosed.countDown();}finally{try{socket.close();}catch(Exception ignored){}sockets.remove(socket);}}
  public void close()throws Exception{closed=true;server.close();for(Socket socket:sockets)socket.close();workers.shutdownNow();}
 }
 static Activity start(Instrumentation i,Context ctx){return i.startActivitySync(new Intent().setClassName(ctx.getPackageName(),"dev.podjs.androidwatch.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));}
 static void write(File f,String text)throws Exception{f.getParentFile().mkdirs();Files.write(f.toPath(),text.getBytes(StandardCharsets.UTF_8));}
 static void save(Context ctx,String stage,Bitmap frame)throws Exception{try(FileOutputStream out=new FileOutputStream(new File(ctx.getFilesDir(),"cache-"+stage+".png"))){assertTrue(frame.compress(Bitmap.CompressFormat.PNG,100,out));}}
 static JSONObject kv(Context ctx)throws Exception{File f=new File(ctx.getFilesDir(),"podjs/podjs-kv.json");return f.isFile()?new JSONObject(new String(Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8)):new JSONObject();}
 static JSONObject result(Context ctx)throws Exception{return kv(ctx).optJSONObject("managed-cache-result");}
 static void awaitStage(Context ctx,String stage,long timeout)throws Exception{long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){JSONObject r=result(ctx);if(r!=null){assertNotEquals(r.toString(),"failed",r.optString("state"));if(stage.equals(r.optString("stage")))return;}SystemClock.sleep(100);}throw new AssertionError("No stage "+stage+": "+result(ctx));}
 static PodRuntimeView awaitView(Activity activity){long end=SystemClock.uptimeMillis()+30000;PodRuntimeView view;while((view=find(activity.getWindow().getDecorView()))==null&&SystemClock.uptimeMillis()<end)SystemClock.sleep(100);assertNotNull(view);return view;}
 static PodRuntimeView find(View v){if(v instanceof PodRuntimeView)return(PodRuntimeView)v;if(v instanceof ViewGroup)for(int n=0;n<((ViewGroup)v).getChildCount();n++){PodRuntimeView view=find(((ViewGroup)v).getChildAt(n));if(view!=null)return view;}return null;}
 static Bitmap bitmap(Instrumentation i,TextureView view){Bitmap[] result=new Bitmap[1];i.runOnMainSync(()->result[0]=view.getBitmap());return result[0];}
}
