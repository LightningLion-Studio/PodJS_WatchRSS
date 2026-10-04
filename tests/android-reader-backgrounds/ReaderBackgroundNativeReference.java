package dev.podjs.runtime;
import android.app.*;
import android.content.Context;
import android.graphics.*;
import android.os.*;
import android.view.*;
import android.widget.FrameLayout;
import dalvik.system.PathClassLoader;
import java.io.File;
import java.lang.reflect.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import static org.junit.Assert.*;
/** Executes the installed APK's actual Compose background media, under an owned fixture window. */
final class ReaderBackgroundNativeReference {
 final ClassLoader loader;final Object unit;
 ReaderBackgroundNativeReference(String apk)throws Exception{loader=new PathClassLoader(apk,getClass().getClassLoader());unit=loader.loadClass("kotlin.Unit").getField("INSTANCE").get(null);}
 Object background(JSONObject preset)throws Exception{Class<?> codec=loader.loadClass("com.lightningstudio.watchrss.data.reader.ReaderPresetCodec");Object p=codec.getMethod("decode",String.class).invoke(codec.getField("INSTANCE").get(null),preset.toString());return p.getClass().getMethod("getBackground").invoke(p);}
 Bitmap compose(Instrumentation instrumentation,Activity activity,JSONObject preset,File image,int width,int height)throws Exception{
  Object b=background(preset);Class<?> functions=loader.loadClass("kotlin.jvm.functions.Function2");Class<?> type=loader.loadClass("com.lightningstudio.watchrss.ui.reader.ReaderVideoBackgroundKt");Method media=null;for(Method m:type.getDeclaredMethods())if(m.getName().equals("ReaderBackgroundMedia"))media=m;assertNotNull(media);media.setAccessible(true);final Method render=media;
  Object content=Proxy.newProxyInstance(loader,new Class[]{functions},(proxy,method,args)->{if(method.getName().equals("invoke")){render.invoke(null,image,null,b,args[0],0);return unit;}if(method.getName().equals("toString"))return "native background reference";if(method.getName().equals("hashCode"))return System.identityHashCode(proxy);if(method.getName().equals("equals"))return proxy==args[0];return null;});
  FrameLayout[] frame=new FrameLayout[1];View[] compose=new View[1];Object[] lifecycle=new Object[1];Throwable[] failure=new Throwable[1];
  instrumentation.runOnMainSync(()->{try{
   frame[0]=new FrameLayout(activity);frame[0].setBackgroundColor((int)preset.getJSONObject("background").getLong("colorArgb"));
   Class<?> lifecycleOwner=loader.loadClass("androidx.lifecycle.LifecycleOwner"),registry=loader.loadClass("androidx.lifecycle.LifecycleRegistry"),savedOwner=loader.loadClass("androidx.savedstate.SavedStateRegistryOwner");Object[] saved=new Object[1];
   Object owner=Proxy.newProxyInstance(loader,new Class[]{savedOwner},(proxy,method,args)->{switch(method.getName()){case "getLifecycle":return lifecycle[0];case "getSavedStateRegistry":return saved[0];case "hashCode":return System.identityHashCode(proxy);case "equals":return proxy==args[0];case "toString":return "owned reference lifecycle";default:throw new UnsupportedOperationException(method.getName());}});
   lifecycle[0]=registry.getConstructor(lifecycleOwner).newInstance(owner);
   Class<?> controllerClass=loader.loadClass("androidx.savedstate.SavedStateRegistryController");Object companion=controllerClass.getField("Companion").get(null);Object controller=companion.getClass().getMethod("create",savedOwner).invoke(companion,owner);saved[0]=controllerClass.getMethod("getSavedStateRegistry").invoke(controller);
   controllerClass.getMethod("performAttach").invoke(controller);controllerClass.getMethod("performRestore",Bundle.class).invoke(controller,(Object)null);
   loader.loadClass("androidx.lifecycle.ViewTreeLifecycleOwner").getMethod("set",View.class,lifecycleOwner).invoke(null,frame[0],owner);
   loader.loadClass("androidx.savedstate.ViewTreeSavedStateRegistryOwner").getMethod("set",View.class,savedOwner).invoke(null,frame[0],owner);
   for(String event:new String[]{"ON_CREATE","ON_START","ON_RESUME"})event(lifecycle[0],event);
   Class<?> composeClass=loader.loadClass("androidx.compose.ui.platform.ComposeView");compose[0]=(View)composeClass.getConstructor(Context.class).newInstance(activity);composeClass.getMethod("setContent",functions).invoke(compose[0],content);
   frame[0].addView(compose[0],new FrameLayout.LayoutParams(width,height));
   JSONObject bg=preset.getJSONObject("background");float opacity=(float)bg.getDouble("overlayOpacity");if(opacity>0){View overlay=new View(activity);overlay.setBackgroundColor(((int)bg.getLong("overlayColorArgb")&0xffffff)|(Math.round(opacity*255)<<24));frame[0].addView(overlay,new FrameLayout.LayoutParams(width,height));}
   ((ViewGroup)activity.findViewById(android.R.id.content)).addView(frame[0],new FrameLayout.LayoutParams(width,height));
  }catch(Throwable e){failure[0]=e;}});
  try{if(failure[0]!=null)throw new AssertionError("Native composition setup",failure[0]);SystemClock.sleep(2500);return window(instrumentation,activity,frame[0],width,height);}
  finally{instrumentation.runOnMainSync(()->{try{if(compose[0]!=null)compose[0].getClass().getMethod("disposeComposition").invoke(compose[0]);if(lifecycle[0]!=null){event(lifecycle[0],"ON_PAUSE");event(lifecycle[0],"ON_STOP");event(lifecycle[0],"ON_DESTROY");}if(frame[0]!=null&&frame[0].getParent() instanceof ViewGroup)((ViewGroup)frame[0].getParent()).removeView(frame[0]);}catch(Exception e){throw new AssertionError(e);}});}
 }
 @SuppressWarnings({"unchecked","rawtypes"}) void event(Object registry,String name)throws Exception{Class<?> events=loader.loadClass("androidx.lifecycle.Lifecycle$Event");registry.getClass().getMethod("handleLifecycleEvent",events).invoke(registry,Enum.valueOf((Class)events,name));}
 static Bitmap window(Instrumentation i,Activity activity,View view,int width,int height)throws Exception{Bitmap bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);CountDownLatch latch=new CountDownLatch(1);int[] result={-1};i.runOnMainSync(()->{int[] position=new int[2];view.getLocationInWindow(position);PixelCopy.request(activity.getWindow(),new Rect(position[0],position[1],position[0]+width,position[1]+height),bitmap,status->{result[0]=status;latch.countDown();},new Handler(Looper.getMainLooper()));});assertTrue(latch.await(5,TimeUnit.SECONDS));assertEquals(PixelCopy.SUCCESS,result[0]);return bitmap;}
}
