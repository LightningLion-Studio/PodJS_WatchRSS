package dev.podjs.runtime;
import org.json.*;
import java.lang.reflect.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
/** Invoke installed native route handlers without constructing its data container or starting a server. */
final class NativeRemoteInputOracle {
 final ClassLoader loader;final Class<?> type;final Object server;String received;
 NativeRemoteInputOracle(String apk)throws Exception{
  loader=new dalvik.system.PathClassLoader(apk,ClassLoader.getSystemClassLoader());type=loader.loadClass("com.lightningstudio.watchrss.phoneconnection.LocalHttpServer");
  Class<?> unsafeType=Class.forName("sun.misc.Unsafe");Field singleton=unsafeType.getDeclaredField("theUnsafe");singleton.setAccessible(true);Object unsafe=singleton.get(null);server=unsafeType.getMethod("allocateInstance",Class.class).invoke(unsafe,type);
  Class<?> ability=loader.loadClass("com.lightningstudio.watchrss.phoneconnection.PhoneConnectionAbility");Object remote=ability.getField("REMOTE_INPUT").get(null);set("preferredAbility",remote);set("abilities",Collections.singleton(remote));
  Class<?> function=loader.loadClass("kotlin.jvm.functions.Function1");Object callback=Proxy.newProxyInstance(loader,new Class[]{function},(p,m,args)->{if(m.getName().equals("invoke")){received=(String)args[0];return loader.loadClass("kotlin.Unit").getField("INSTANCE").get(null);}return null;});set("onRemoteInput",callback);
 }
 void set(String name,Object value)throws Exception{Field f=type.getDeclaredField(name);f.setAccessible(true);f.set(server,value);}
 JSONObject route(JSONObject request)throws Exception{
  received=null;String uri=request.getString("target"),body=request.getString("body");Map<String,String> headers=new HashMap<>();JSONObject raw=request.getJSONObject("headers");for(Iterator<String> it=raw.keys();it.hasNext();){String key=it.next();headers.put(key,raw.getString(key));}
  Class<?> sessionType=loader.loadClass("fi.iki.elonen.NanoHTTPD$IHTTPSession");Object session=Proxy.newProxyInstance(loader,new Class[]{sessionType},(proxy,method,args)->{switch(method.getName()){
   case "getUri":return uri;case "getHeaders":return headers;case "getParameters":return Collections.emptyMap();case "parseBody":((Map<String,String>)args[0]).put("postData",body);return null;case "getMethod":return loader.loadClass("fi.iki.elonen.NanoHTTPD$Method").getField(body.isEmpty()?"GET":"POST").get(null);default:return null;}});
  Object response=type.getMethod("serve",sessionType).invoke(server,session);Class<?> responseType=loader.loadClass("fi.iki.elonen.NanoHTTPD$Response");Object status=responseType.getMethod("getStatus").invoke(response);int code=((Number)loader.loadClass("fi.iki.elonen.NanoHTTPD$Response$IStatus").getMethod("getRequestStatus").invoke(status)).intValue();
  String mime=(String)responseType.getMethod("getMimeType").invoke(response);ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream stream=(InputStream)responseType.getMethod("getData").invoke(response)){byte[] buffer=new byte[1024];int count;while((count=stream.read(buffer))!=-1)bytes.write(buffer,0,count);}
  JSONObject result=new JSONObject().put("status",code).put("type",mime).put("body",new String(bytes.toByteArray(),StandardCharsets.UTF_8));if(received!=null)result.put("url",received);return result;
 }
 static void same(Object a,Object b)throws Exception{
  if(a instanceof JSONObject&&b instanceof JSONObject){JSONObject x=(JSONObject)a,y=(JSONObject)b;org.junit.Assert.assertEquals(x.length(),y.length());for(Iterator<String> it=x.keys();it.hasNext();){String key=it.next();same(x.get(key),y.get(key));}}
  else if(a instanceof JSONArray&&b instanceof JSONArray){JSONArray x=(JSONArray)a,y=(JSONArray)b;org.junit.Assert.assertEquals(x.length(),y.length());for(int i=0;i<x.length();i++)same(x.get(i),y.get(i));}
  else org.junit.Assert.assertEquals(a,b);
 }
}
