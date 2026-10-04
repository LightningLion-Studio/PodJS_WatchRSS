package dev.podjs.runtime;
import android.content.Context;
import android.graphics.*;
import android.text.*;
import dalvik.system.PathClassLoader;
import org.json.JSONObject;
import java.io.File;
import java.lang.reflect.*;
import java.util.Collections;
/** Executes the installed native preview builder and Compose paragraph implementation. */
final class ReaderParagraphReference {
 final ClassLoader loader;final Object codec;final Class<?> codecClass;
 ReaderParagraphReference(String apk)throws Exception{loader=new PathClassLoader(apk,ClassLoader.getSystemClassLoader());codecClass=loader.loadClass("com.lightningstudio.watchrss.data.reader.ReaderPresetCodec");codec=codecClass.getField("INSTANCE").get(null);}
 Object style(JSONObject args)throws Exception{
  float size=(float)args.getDouble("fontSizePx"),height=(float)args.getDouble("lineHeightPx");
  JSONObject body=new JSONObject().put("fontSizeSp",size).put("lineHeightEm",height/size).put("fontWeight",args.optInt("fontWeight",400)).put("italic",args.optBoolean("italic")).put("letterSpacingEm",args.optDouble("letterSpacingEm",0)).put("underline",args.optBoolean("underline")).put("strikethrough",args.optBoolean("strikethrough")).put("colorArgb",args.optLong("colorArgb",0xffffffffL))
   .put("alignment",args.optBoolean("justify")?"JUSTIFY":args.optString("align").equals("center")?"CENTER":"START").put("hyphenation",args.optString("hyphenation").equals("full")?"AUTO":"NONE").put("renderMode",args.optString("nativeRenderMode",args.optString("textMotion").equals("animated")?"LINEAR_SMOOTH":"READABILITY"));
  String mode=args.optString("lineBreak");body.put("lineBreakMode",mode.equals("simple")?"SIMPLE":mode.equals("balanced")||args.optString("lineHeightMode").equals("span")?"PARAGRAPH":"SYSTEM");
  Object preset=codecClass.getMethod("decode",String.class).invoke(codec,new JSONObject().put("schemaVersion",2).put("id","native-paragraph").put("name","Native").put("body",body).toString());return preset.getClass().getMethod("getBody").invoke(preset);
 }
 Object paragraph(Context ctx,JSONObject args,boolean preview)throws Exception{
  Object nativeStyle=style(args);String text=args.getString("text");int width=args.getInt("widthPx");
  if(preview){Class<?> file=loader.loadClass("com.lightningstudio.watchrss.ReaderPresetPreviewActivityKt");Method create=null,paintMethod=null;for(Method m:file.getDeclaredMethods()){if(m.getName().equals("createPreviewStaticLayout"))create=m;if(m.getName().equals("toPreviewTextPaint"))paintMethod=m;}create.setAccessible(true);paintMethod.setAccessible(true);
   Class<?> function=loader.loadClass("kotlin.jvm.functions.Function1");Object noFont=Proxy.newProxyInstance(loader,new Class[]{function},(proxy,method,values)->method.getName().equals("invoke")?null:method.getName().equals("toString")?"No custom font":null);
   TextPaint paint=(TextPaint)paintMethod.invoke(null,nativeStyle,noFont,1f,1f);return create.invoke(null,text,paint,nativeStyle,width,false);
  }
  Class<?> runtime=loader.loadClass("com.lightningstudio.watchrss.ui.reader.ReaderPresetRuntimeKt");Method convert=null;for(Method m:runtime.getDeclaredMethods())if(m.getName().equals("toComposeTextStyle")){convert=m;break;}convert.setAccessible(true);Object textStyle=convert.invoke(null,nativeStyle,null);
  Object density=loader.loadClass("androidx.compose.ui.unit.DensityKt").getMethod("Density",float.class,float.class).invoke(null,1f,1f);
  Object resolver=loader.loadClass("androidx.compose.ui.text.font.FontFamilyResolver_androidKt").getMethod("createFontFamilyResolver",Context.class).invoke(null,ctx);
  for(Method method:loader.loadClass("androidx.compose.ui.text.ParagraphKt").getDeclaredMethods())if(method.getName().equals("Paragraph")&&method.getParameterCount()==9&&method.getParameterTypes()[2]==float.class)return method.invoke(null,text,textStyle,(float)width,density,resolver,Collections.emptyList(),Collections.emptyList(),Integer.MAX_VALUE,false);
  throw new IllegalStateException("Native Compose Paragraph factory missing");
 }
 int count(Object p)throws Exception{return p instanceof StaticLayout?((StaticLayout)p).getLineCount():((Number)p.getClass().getMethod("getLineCount").invoke(p)).intValue();}
 int start(Object p,int line)throws Exception{return p instanceof StaticLayout?((StaticLayout)p).getLineStart(line):((Number)p.getClass().getMethod("getLineStart",int.class).invoke(p,line)).intValue();}
 int end(Object p,int line,boolean visible)throws Exception{return p instanceof StaticLayout?(visible?((StaticLayout)p).getLineVisibleEnd(line):((StaticLayout)p).getLineEnd(line)):((Number)p.getClass().getMethod("getLineEnd",int.class,boolean.class).invoke(p,line,visible)).intValue();}
 float metric(Object p,String name,int line)throws Exception{return ((Number)p.getClass().getMethod(name,int.class).invoke(p,line)).floatValue();}
 float caret(Object paragraph,int line,int offset)throws Exception{
  if(offset==end(paragraph,line,false)&&line+1<count(paragraph)){
   boolean ltr=paragraph instanceof StaticLayout?((StaticLayout)paragraph).getParagraphDirection(line)==1:paragraph.getClass().getMethod("getParagraphDirection",int.class).invoke(paragraph,start(paragraph,line)).toString().equals("Ltr");
   return metric(paragraph,ltr?"getLineRight":"getLineLeft",line);
  }
  return paragraph instanceof StaticLayout?((StaticLayout)paragraph).getPrimaryHorizontal(offset):((Number)paragraph.getClass().getMethod("getHorizontalPosition",int.class,boolean.class).invoke(paragraph,offset,true)).floatValue();
 }
 void draw(Object paragraph,Canvas canvas,int color)throws Exception{
  if(paragraph instanceof StaticLayout){((StaticLayout)paragraph).draw(canvas);return;}
  Class<?> canvasType=loader.loadClass("androidx.compose.ui.graphics.Canvas");Object wrapper=loader.loadClass("androidx.compose.ui.graphics.AndroidCanvas_androidKt").getMethod("Canvas",Canvas.class).invoke(null,canvas);
  long packed=(long)color<<32;
  for(Method m:paragraph.getClass().getMethods())if(m.getName().startsWith("paint-")&&m.getParameterCount()==4&&m.getParameterTypes()[0]==canvasType){m.invoke(paragraph,wrapper,packed,null,null);return;}
  throw new IllegalStateException("Native Compose paint missing");
 }
}
