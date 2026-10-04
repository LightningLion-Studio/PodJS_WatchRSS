package dev.podjs.runtime;
import static org.junit.Assert.*;
import java.io.*;import java.lang.reflect.*;import java.util.*;import org.json.*;
/** Reads installed native classes; all files given to eviction belong to this fixture. */
final class ManagedCacheNativePolicy {
 static void verify(String apk,File directory,JSONObject cases)throws Exception{
  ClassLoader loader=new dalvik.system.PathClassLoader(apk,ClassLoader.getSystemClassLoader());
  Class<?> service=loader.loadClass("com.lightningstudio.watchrss.data.cache.ManagedCacheService"),bucket=loader.loadClass("com.lightningstudio.watchrss.data.cache.ManagedCacheBucket"),entry=loader.loadClass("com.lightningstudio.watchrss.data.cache.ManagedCacheService$CacheFileEntry");
  Class<?> unsafe=Class.forName("sun.misc.Unsafe");Field field=unsafe.getDeclaredField("theUnsafe");field.setAccessible(true);Object instance=unsafe.getMethod("allocateInstance",Class.class).invoke(field.get(null),service);
  Constructor<?> constructor=entry.getDeclaredConstructor(bucket,File.class,long.class,long.class);constructor.setAccessible(true);Method evict=service.getDeclaredMethod("evictBucket",List.class,bucket,long.class,long.class,int.class);evict.setAccessible(true);
  JSONArray matrix=cases.getJSONArray("evictions");String[] names={"DOUYIN_PRELOAD","RSS_IMAGES","BILI_PREVIEW","DOUYIN_PRELOAD"};int[] reserve={6,0,0,4};
  for(int c=0;c<matrix.length();c++){
   File root=new File(directory,"case-"+c);assertTrue(root.mkdirs());List<Object> files=new ArrayList<>();Map<String,File> own=new LinkedHashMap<>();
   for(int n=0;n<11;n++){String name=n<8?"d"+n:n==8?"image":n==9?"bili":"offline";String type=n<8?"DOUYIN_PRELOAD":n==8?"RSS_IMAGES":n==9?"BILI_PREVIEW":"RSS_OFFLINE";File file=new File(root,name);try(RandomAccessFile out=new RandomAccessFile(file,"rw")){out.setLength(n==10?1000:10);}own.put(name,file);files.add(constructor.newInstance(Enum.valueOf((Class)bucket,type),file,n==10?1000L:10L,n<8?(long)n:n==10?0L:1L));}
   long total=1100,limit=matrix.getJSONObject(c).getLong("limit");List<String> removed=new ArrayList<>();
   for(int pass=0;pass<4;pass++){total=(Long)evict.invoke(instance,files,Enum.valueOf((Class)bucket,names[pass]),total,limit,reserve[pass]);for(Map.Entry<String,File> f:own.entrySet())if(!f.getValue().exists()&&!removed.contains(f.getKey()))removed.add(f.getKey());List<Object> remaining=new ArrayList<>();for(Object e:files){Method getFile=entry.getDeclaredMethod("getFile");getFile.setAccessible(true);if(((File)getFile.invoke(e)).exists())remaining.add(e);}files=remaining;}
   assertEquals(matrix.getJSONObject(c).getJSONArray("removed").toString(),new JSONArray(removed).toString());assertTrue(own.get("offline").isFile());for(File f:own.values())f.delete();assertTrue(root.delete());
  }
  Class<?> screen=loader.loadClass("com.lightningstudio.watchrss.ui.screen.rss.SettingsScreenKt");Method format=screen.getDeclaredMethod("formatCacheSize",long.class);format.setAccessible(true);JSONArray labels=cases.getJSONArray("labels");for(int n=0;n<labels.length();n++){JSONObject value=labels.getJSONObject(n);assertEquals(value.getString("label"),format.invoke(null,value.getLong("value")));}
  Class<?> mode=loader.loadClass("com.lightningstudio.watchrss.data.settings.RssInlineImagePrefetchMode");Object[] modes=mode.getEnumConstants();for(int n=0;n<modes.length;n++){JSONObject expected=cases.getJSONArray("prefetch").getJSONObject(n);assertEquals(expected.getString("label"),mode.getMethod("getLabel").invoke(modes[n]));assertEquals(expected.getString("summary"),mode.getMethod("getSummary").invoke(modes[n]));assertEquals(expected.isNull("count")?null:expected.getInt("count"),mode.getMethod("getPrefetchCount").invoke(modes[n]));}
 }
}
