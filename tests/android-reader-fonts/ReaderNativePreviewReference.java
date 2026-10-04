package dev.podjs.runtime;
import android.content.Context;
import android.graphics.*;
import android.text.StaticLayout;
import dalvik.system.PathClassLoader;
import java.io.File;
import java.lang.reflect.*;
import java.util.List;
import org.json.JSONObject;
/** Draw only native preview paragraphs, using the installed reference APK's actual private builder. */
public final class ReaderNativePreviewReference {
 public static Bitmap render(Context context,String apk,JSONObject preset,int width,int height,float pixelScale)throws Exception{
  ClassLoader loader=new PathClassLoader(apk,ReaderNativePreviewReference.class.getClassLoader());Class<?> codec=loader.loadClass("com.lightningstudio.watchrss.data.reader.ReaderPresetCodec");Object instance=codec.getField("INSTANCE").get(null),value=codec.getMethod("decode",String.class).invoke(instance,preset.toString());
  Class<?> function=loader.loadClass("kotlin.jvm.functions.Function1");Object fonts=Proxy.newProxyInstance(loader,new Class[]{function},(proxy,method,args)->{
   if(method.getName().equals("invoke")){String id=(String)args[0];if(!"serif".equals(id)&&!"sans".equals(id))return null;File file=new File(context.getFilesDir(),"podjs/files/reader_assets/fonts/"+id+".ttc");return file.isFile()?file:null;}
   if(method.getName().equals("toString"))return "owned font fixture";if(method.getName().equals("hashCode"))return System.identityHashCode(proxy);if(method.getName().equals("equals"))return proxy==args[0];throw new UnsupportedOperationException(method.getName());
  });
  Class<?> activity=loader.loadClass("com.lightningstudio.watchrss.ReaderPresetPreviewActivityKt");Method build=null;for(Method m:activity.getDeclaredMethods())if(m.getName().equals("buildNativePreviewLayout"))build=m;if(build==null)throw new NoSuchMethodException("buildNativePreviewLayout");build.setAccessible(true);Object layout=build.invoke(null,value,fonts,width-28*pixelScale,150*pixelScale,190*pixelScale,6*pixelScale,pixelScale,1f);
  Method paragraphs=layout.getClass().getDeclaredMethod("getParagraphs");paragraphs.setAccessible(true);Bitmap bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(bitmap);canvas.drawColor(Color.BLACK);canvas.translate(14*pixelScale,22*pixelScale);
  for(Object paragraph:(List<?>)paragraphs.invoke(layout)){Class<?> c=paragraph.getClass();Method text=c.getDeclaredMethod("getLayout"),left=c.getDeclaredMethod("getLeftPx"),top=c.getDeclaredMethod("getTopPx");text.setAccessible(true);left.setAccessible(true);top.setAccessible(true);canvas.save();canvas.translate(((Number)left.invoke(paragraph)).floatValue(),((Number)top.invoke(paragraph)).floatValue());((StaticLayout)text.invoke(paragraph)).draw(canvas);canvas.restore();}
  return bitmap;
 }
}
