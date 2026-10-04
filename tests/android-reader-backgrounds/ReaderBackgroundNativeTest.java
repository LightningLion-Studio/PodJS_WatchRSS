package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.*;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.Files;
import java.security.MessageDigest;
/** Geometry, color transform and Android 11 blur execute the installed native APK's methods. */
public final class ReaderBackgroundNativeTest {
 @SuppressWarnings({"unchecked","rawtypes"})
 @Test public void nativeGeometryColorBlurAndLocalPathRulesMatch()throws Exception{
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();assertEquals("dev.podjs.tests.readerbackgrounds",context.getPackageName());String apk=InstrumentationRegistry.getArguments().getString("nativeReferenceApk");ReaderBackgroundNativeReference reference=new ReaderBackgroundNativeReference(apk);ClassLoader loader=reference.loader;
  Class<?> fit=loader.loadClass("com.lightningstudio.watchrss.data.reader.ReaderBackgroundFit"),geometry=loader.loadClass("com.lightningstudio.watchrss.ui.reader.ReaderVideoBackgroundKt");Method plane=geometry.getDeclaredMethod("readerBackgroundPlane",int.class,int.class,float.class,float.class,fit,float.class,float.class,float.class);plane.setAccessible(true);
  int planeCases=0;for(String mode:new String[]{"CROP","FIT","FILL"})for(float zoom:new float[]{.25f,1f,1.25f,8f})for(float focus:new float[]{0,.2f,.5f,1})for(float[] dimensions:new float[][]{{200,120},{120,200},{1,1},{1920,1080}}){
   PodMediaSurfaceServices.Style style=new PodMediaSurfaceServices.Style(new JSONObject().put("fit",mode.toLowerCase()).put("zoom",zoom).put("focusX",focus).put("focusY",1-focus));int[] actual=PodMediaSurfaceServices.plane(466,466,dimensions[0],dimensions[1],style);
   Object expected=plane.invoke(null,466,466,dimensions[0],dimensions[1],Enum.valueOf((Class)fit,mode),zoom,focus,1-focus);int index=0;for(String method:new String[]{"getWidth","getHeight","getX","getY"}){Method getter=expected.getClass().getDeclaredMethod(method);getter.setAccessible(true);assertEquals(mode+" "+zoom+" "+focus,((Number)getter.invoke(expected)).intValue(),actual[index++]);}planeCases++;
  }
  Class<?> runtime=loader.loadClass("com.lightningstudio.watchrss.ui.reader.ReaderPresetRuntimeKt");Method color=null;for(Method method:runtime.getDeclaredMethods())if(method.getName().startsWith("backgroundColorMatrix"))color=method;assertNotNull(color);color.setAccessible(true);int colors=0;
  for(float brightness:new float[]{-1,0,.5f,1,1.3f,2,3})for(float saturation:new float[]{-1,0,.5f,1,1.3f,2,3}){Object returned=color.invoke(null,brightness,saturation);float[] expected=returned instanceof float[]?(float[])returned:(float[])returned.getClass().getMethod("getValues").invoke(returned);assertArrayEquals(expected,PodMediaSurfaceServices.colorMatrix(brightness,saturation).getArray(),0f);colors++;}
  Bitmap pattern=Bitmap.createBitmap(64,40,Bitmap.Config.ARGB_8888);for(int y=0;y<40;y++)for(int x=0;x<64;x++)pattern.setPixel(x,y,Color.argb(128+x*2,x*4,y*6,((x/4+y/4)%2)*255));
  Class<?> blurClass=loader.loadClass("com.lightningstudio.watchrss.ui.reader.ReaderBackgroundBlurTransformation");Constructor<?> constructor=blurClass.getDeclaredConstructor(Context.class,float.class);constructor.setAccessible(true);Method transform=null;for(Method method:blurClass.getDeclaredMethods())if(method.getName().equals("transform"))transform=method;assertNotNull(transform);transform.setAccessible(true);int blurs=0;
  for(float radius:new float[]{.1f,12,50,128}){Object nativeBlur=constructor.newInstance(context,radius);Bitmap expected=(Bitmap)transform.invoke(nativeBlur,pattern,null,null),actual=PodMediaSurfaceServices.blur(context,pattern,radius);int[] a=new int[64*40],b=new int[64*40];actual.getPixels(a,0,64,0,0,64,40);expected.getPixels(b,0,64,0,0,64,40);assertArrayEquals("blur "+radius,b,a);actual.recycle();expected.recycle();blurs++;}pattern.recycle();
  PodMediaSurfaceServices service=new PodMediaSurfaceServices(context);int rejected=0;try{Method file=PodMediaSurfaceServices.class.getDeclaredMethod("file",JSONObject.class,String.class,boolean.class);file.setAccessible(true);
   for(String path:new String[]{"../escape.png","/system/image.png","reader_assets/../image.png","reader_assets\\image.png","reader_assets//image.png","reader_assets/./image.png"})try{file.invoke(service,new JSONObject().put("path",path),"path",true);fail(path);}catch(InvocationTargetException e){assertTrue(e.getCause() instanceof IllegalArgumentException);rejected++;}
  }finally{service.close();}
  JSONObject proof=new JSONObject().put("nativeReferenceApkSha256",hash(new File(apk))).put("geometryCases",planeCases).put("colorMatrixCases",colors).put("intrinsicBlurCases",blurs).put("pathCasesRejected",rejected).put("allExact",true);
  Files.write(new File(context.getFilesDir(),"background-native-proof.json").toPath(),proof.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
 }
 static String hash(File file)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1)digest.update(bytes,0,n);}StringBuilder result=new StringBuilder();for(byte b:digest.digest())result.append(String.format("%02x",b&255));return result.toString();}
}
