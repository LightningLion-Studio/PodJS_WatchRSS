package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.os.CancellationSignal;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.Test;
import java.net.*;
import java.util.concurrent.*;
/** Real guest-owned listener lifecycle on loopback. Does not change device networks. */
public class RemoteInputTcpTest {
 private PodByteStreamServices service(){return new PodByteStreamServices(InstrumentationRegistry.getInstrumentation().getTargetContext());}
 private JSONObject listen(PodByteStreamServices s)throws Exception{return s.execute("tcp.listen",new JSONObject().put("port",0).put("address","127.0.0.1"),new CancellationSignal());}
 private JSONObject args(String id,int timeout)throws Exception{return new JSONObject().put("id",id).put("timeoutMs",timeout);}
 private void refused(int port)throws Exception{try(Socket probe=new Socket()){probe.connect(new InetSocketAddress("127.0.0.1",port),500);fail("Listener still open");}catch(java.io.IOException expected){}}
 @Test public void acceptsBidirectionalBytesAndReleasesEveryHandle()throws Exception{
  try(PodByteStreamServices s=service()){
   JSONObject listener=listen(s);int port=listener.getInt("port");String id=listener.getString("id");
   try(Socket client=new Socket("127.0.0.1",port)){
    JSONObject accepted=s.execute("tcp.accept",args(id,1000),new CancellationSignal());assertEquals("127.0.0.1",accepted.getString("remoteAddress"));String stream=accepted.getString("id");
    client.getOutputStream().write(new byte[]{1,2,3});JSONObject read=s.execute("stream.read",args(stream,1000).put("maxBytes",16),new CancellationSignal());assertArrayEquals(new byte[]{1,2,3},android.util.Base64.decode(read.getString("dataBase64"),0));
    s.execute("stream.write",args(stream,1000).put("dataBase64","BAU="),new CancellationSignal());assertEquals(4,client.getInputStream().read());assertEquals(5,client.getInputStream().read());s.discard(accepted);client.setSoTimeout(1000);assertEquals(-1,client.getInputStream().read());
   }
   s.discard(listener);refused(port);
  }
 }
 @Test public void timeoutKeepsListenerReusableButCancellationClosesIt()throws Exception{
  ExecutorService executor=Executors.newSingleThreadExecutor();try(PodByteStreamServices s=service()){
   JSONObject listener=listen(s);String id=listener.getString("id");int port=listener.getInt("port");
   try{s.execute("tcp.accept",args(id,30),new CancellationSignal());fail("No timeout");}catch(SocketTimeoutException expected){}
   try(Socket client=new Socket("127.0.0.1",port)){s.discard(s.execute("tcp.accept",args(id,1000),new CancellationSignal()));}
   CancellationSignal cancel=new CancellationSignal();CountDownLatch started=new CountDownLatch(1);Future<?> pending=executor.submit(()->{started.countDown();try{s.execute("tcp.accept",args(id,5000),cancel);throw new AssertionError("Cancelled accept returned");}catch(Exception expected){}});assertTrue(started.await(1,TimeUnit.SECONDS));java.lang.reflect.Field listeners=PodByteStreamServices.class.getDeclaredField("tcpListeners");listeners.setAccessible(true);Object current=((java.util.Map<?,?>)listeners.get(s)).get(id);java.lang.reflect.Field accepting=current.getClass().getDeclaredField("accepting");accepting.setAccessible(true);java.util.concurrent.atomic.AtomicBoolean waiting=(java.util.concurrent.atomic.AtomicBoolean)accepting.get(current);long deadline=android.os.SystemClock.uptimeMillis()+1000;while(!waiting.get()&&android.os.SystemClock.uptimeMillis()<deadline)Thread.yield();assertTrue(waiting.get());cancel.cancel();pending.get(2,TimeUnit.SECONDS);refused(port);
  }finally{executor.shutdownNow();}
 }
 @Test public void handleLimitAndHostCloseReleasePorts()throws Exception{
  PodByteStreamServices s=service();int[] ports=new int[4];try{for(int i=0;i<4;i++)ports[i]=listen(s).getInt("port");try{listen(s);fail("Capacity was exceeded");}catch(IllegalStateException expected){}s.close();for(int port:ports)refused(port);}finally{s.close();}
 }
 @Test public void invalidBindDoesNotConsumeAHandle()throws Exception{
  try(PodByteStreamServices s=service()){for(Object port:new Object[]{-1,65536,1.5})try{s.execute("tcp.listen",new JSONObject().put("port",port).put("address","127.0.0.1"),new CancellationSignal());fail("Invalid port accepted");}catch(IllegalArgumentException expected){}
   try{s.execute("tcp.listen",new JSONObject().put("port",0).put("address","example.com"),new CancellationSignal());fail("DNS bind allowed");}catch(IllegalArgumentException expected){}
   s.discard(listen(s));
  }
 }
}
