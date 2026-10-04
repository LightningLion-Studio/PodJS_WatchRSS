package dev.podjs.runtime;
import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.*;
import android.os.*;
import android.text.StaticLayout;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
/** Full-paragraph source shaping compared with actual native preview and Compose. */
public final class ReaderParagraphNativeTest {
 @Test public void paragraphSlicesMatchNativeShaping()throws Exception{
  Context ctx=InstrumentationRegistry.getInstrumentation().getTargetContext();assertEquals("dev.podjs.tests.readerparagraphs",ctx.getPackageName());
  LocaleList previous=LocaleList.getDefault();LocaleList.setDefault(new LocaleList(Locale.US));
  try{String apk=InstrumentationRegistry.getArguments().getString("nativeReferenceApk");ReaderParagraphReference reference=new ReaderParagraphReference(apk);JSONArray cases=new JSONArray();int hyphenated=0,linesChecked=0,caretsChecked=0;java.util.Map<String,String> unhyphenated=new java.util.HashMap<>();PodParagraphLayout.Cache cache=new PodParagraphLayout.Cache();
   String[] texts={"Extraordinary internationalization and characterization demonstrate interoperability between independent implementations.","An English sentence with spaces and several different word widths.\nAnother paragraph follows.","مرحبا بالعالم، هذا نص عربي مع English 123. 中文与表情😀 é 混合排版。","","A short line\n\n","Decorated text with several words and punctuation."};
   for(boolean preview:new boolean[]{true,false})for(String motion:preview?new String[]{"subpixel"}:new String[]{"static","system","animated"})for(String align:new String[]{"left","center","justify"})for(String hyphens:new String[]{"none","full"})for(String text:texts){
    JSONObject args=new JSONObject().put("text",text).put("widthPx",256).put("fontSizePx",28f).put("lineHeightPx",28f*1.35f).put("fontWeight",400).put("italic",false).put("letterSpacingEm",0).put("hyphenation",hyphens).put("justify",align.equals("justify")).put("align",align.equals("center")?"center":"left").put("textMotion",motion.equals("system")?"static":motion).put("nativeRenderMode",motion.equals("system")?"SYSTEM":motion.equals("animated")?"LINEAR_SMOOTH":"READABILITY").put("underline",text.startsWith("Decorated")).put("strikethrough",text.startsWith("Decorated")).put("lineHeightMode",preview?"spacing":"span").put("fallbackLineSpacing",!preview).put("lineBreak",preview?"balanced":"paragraph").put("colorArgb",0xffe7e1d9L);
    Object nativeParagraph=reference.paragraph(ctx,args,preview);JSONObject metrics=PodTextLayoutServices.layout(ctx,args,new CancellationSignal(),cache);JSONArray rows=metrics.getJSONArray("lines");assertEquals("line count "+args,reference.count(nativeParagraph),rows.length());
    PodParagraphLayout.Prepared prepared=PodParagraphLayout.obtain(ctx,args,new CancellationSignal(),cache);long builds=cache.builds;
    for(int line=0;line<rows.length();line++){
     JSONObject row=rows.getJSONObject(line);assertEquals(reference.start(nativeParagraph,line),row.getInt("start"));assertEquals(reference.end(nativeParagraph,line,false),row.getInt("end"));assertEquals(reference.end(nativeParagraph,line,true),row.getInt("visibleEnd"));
     assertEquals(reference.metric(nativeParagraph,"getLineTop",line),row.getInt("topPx"),0);assertEquals(reference.metric(nativeParagraph,"getLineBottom",line),row.getInt("bottomPx"),0);assertEquals(reference.metric(nativeParagraph,"getLineBaseline",line),row.getInt("baselinePx"),0);
     int h=row.getInt("bottomPx")-row.getInt("topPx")+(line+1==rows.length()?2:0),baseline=row.getInt("baselinePx")-row.getInt("topPx");
     JSONObject raster=new JSONObject(args.toString()).put("text",text.substring(row.getInt("start"),row.getInt("visibleEnd"))).put("heightPx",h).put("baselinePx",baseline).put("paragraph",new JSONObject(args.toString()).put("lineIndex",line));
     JSONObject result=PodTextRasterServices.raster(ctx,raster,new CancellationSignal(),cache);try{
      Bitmap expected=Bitmap.createBitmap(result.getInt("width"),result.getInt("height"),Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(expected);canvas.clipRect(0,0,256,h);canvas.translate(0,-reference.metric(nativeParagraph,"getLineTop",line));reference.draw(nativeParagraph,canvas,(int)args.getLong("colorArgb"));byte[] rgba=rgba(expected);expected.recycle();byte[] actual=Files.readAllBytes(new File(ctx.getFilesDir(),"podjs/files/"+result.getString("path")).toPath());
      assertArrayEquals("pixels profile="+(preview?"preview":"compose")+" motion="+motion+" alignment="+align+" hyphens="+hyphens+" line="+line+" text="+text,rgba,actual);
      assertEquals(raster.getString("text").length()+1,result.getJSONArray("carets").length());for(int at=0;at<result.getJSONArray("carets").length();at++){assertEquals("caret "+at+" on "+args,reference.caret(nativeParagraph,line,row.getInt("start")+at),result.getJSONArray("carets").getDouble(at),.0001);caretsChecked++;}
     }finally{PodTextRasterServices.discard(ctx,result);}linesChecked++;

    }
    String key=preview+"|"+motion+"|"+align+"|"+text;JSONArray ends=new JSONArray();for(int n=0;n<rows.length();n++)ends.put(rows.getJSONObject(n).getInt("end"));if(hyphens.equals("none"))unhyphenated.put(key,ends.toString());else if(!ends.toString().equals(unhyphenated.get(key)))hyphenated++;
    assertEquals("Each visible line rebuilt its paragraph",builds,cache.builds);cases.put(new JSONObject().put("profile",preview?"preview":"compose").put("textMotion",motion.equals("system")?"static":motion).put("nativeRenderMode",motion.equals("system")?"SYSTEM":motion.equals("animated")?"LINEAR_SMOOTH":"READABILITY").put("underline",text.startsWith("Decorated")).put("strikethrough",text.startsWith("Decorated")).put("align",align).put("hyphenation",hyphens).put("text",text).put("lines",rows.length()).put("pixelsExact",true));
   }
   assertTrue("Fixture did not exercise hyphenation-dependent wrapping",hyphenated>0);
   for(int index=0;index<40;index++){JSONObject args=new JSONObject().put("text","Cache paragraph "+index).put("fontSizePx",28).put("widthPx",256);PodParagraphLayout.obtain(ctx,args,new CancellationSignal(),cache);}assertTrue(cache.entries.size()<=32&&cache.units<=262144);cache.clear();assertEquals(0,cache.entries.size());assertEquals(0,cache.units);
   JSONObject proof=new JSONObject().put("nativeReferenceApkSha256",hash(new File(apk))).put("locale","en-US within owned process only").put("cases",cases).put("linesChecked",linesChecked).put("caretsChecked",caretsChecked).put("hyphenationChangedParagraphs",hyphenated).put("cacheReused",true).put("cacheBoundedAndCleared",true).put("passed",true);
   Files.write(new File(ctx.getFilesDir(),"paragraph-native-proof.json").toPath(),proof.toString().getBytes(StandardCharsets.UTF_8));
  }finally{LocaleList.setDefault(previous);}
 }
 static byte[] rgba(Bitmap image){int[] pixels=new int[image.getWidth()*image.getHeight()];image.getPixels(pixels,0,image.getWidth(),0,0,image.getWidth(),image.getHeight());byte[] data=new byte[pixels.length*4];for(int n=0;n<pixels.length;n++){int v=pixels[n],i=n*4;data[i]=(byte)(v>>>16);data[i+1]=(byte)(v>>>8);data[i+2]=(byte)v;data[i+3]=(byte)(v>>>24);}return data;}
 static String hash(File file)throws Exception{java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);}StringBuilder out=new StringBuilder();for(byte b:digest.digest())out.append(String.format("%02x",b&255));return out.toString();}
}
