package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.Context;
import android.graphics.Bitmap;
import android.view.*;
import org.json.*;
import java.util.*;
import java.io.*;
import java.lang.reflect.*;
import java.security.MessageDigest;
/** Read-only device observation helpers for the transfer fixture. */
final class ReaderTransferDevice {
 static JSONObject one(Instrumentation i,PodRuntimeView view)throws Exception{JSONArray all=states(i,view);assertEquals(all.toString(),1,all.length());return all.getJSONObject(0);}
 static JSONArray states(Instrumentation i,PodRuntimeView view)throws Exception{JSONArray[] output={new JSONArray()};Throwable[] error={null};i.runOnMainSync(()->{try{Field a=PodRuntimeView.class.getDeclaredField("services");a.setAccessible(true);Object services=a.get(view);Field b=PodServices.class.getDeclaredField("mediaSurfaces");b.setAccessible(true);Object surface=b.get(services);Field c=PodMediaSurfaceServices.class.getDeclaredField("sessions");c.setAccessible(true);for(Object entry:((Map<?,?>)c.get(surface)).values()){PodMediaSurfaceServices.Session session=(PodMediaSurfaceServices.Session)entry;Field playerField=session.getClass().getDeclaredField("player");playerField.setAccessible(true);Object player=playerField.get(session);if(player!=null)assertEquals(0,((Number)Class.forName("androidx.media3.common.Player").getMethod("getVolume").invoke(player)).floatValue(),0);JSONObject state=session.state();if(player!=null)state.put("playbackState",((Number)Class.forName("androidx.media3.common.Player").getMethod("getPlaybackState").invoke(player)).intValue());output[0].put(state);}}catch(Throwable e){error[0]=e;}});if(error[0]!=null)throw new AssertionError(error[0]);return output[0];}
 static void save(Context ctx,String name,Bitmap bitmap)throws Exception{saveFile(new File(ctx.getFilesDir(),name),bitmap);}
 static void saveFile(File file,Bitmap bitmap)throws Exception{try(FileOutputStream out=new FileOutputStream(file)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}}
 static int changed(Bitmap a,Bitmap b,int y0){assertEquals(a.getWidth(),b.getWidth());assertEquals(a.getHeight(),b.getHeight());int count=0;for(int y=y0;y<a.getHeight();y++)for(int x=0;x<a.getWidth();x++)if(a.getPixel(x,y)!=b.getPixel(x,y))count++;return count;}
 static PodRuntimeView find(View v){if(v instanceof PodRuntimeView)return (PodRuntimeView)v;if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++){PodRuntimeView found=find(((ViewGroup)v).getChildAt(i));if(found!=null)return found;}return null;}
 static Bitmap bitmap(Instrumentation i,PodRuntimeView v){Bitmap[] result={null};i.runOnMainSync(()->result[0]=v.getBitmap());return result[0];}
 static String hash(File file)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1)digest.update(bytes,0,n);}StringBuilder result=new StringBuilder();for(byte b:digest.digest())result.append(String.format("%02x",b&255));return result.toString();}
}
