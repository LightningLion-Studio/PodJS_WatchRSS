package dev.podjs.runtime;
import android.content.Context;
import android.graphics.*;
import android.os.CancellationSignal;
import android.text.*;
import androidx.test.platform.app.InstrumentationRegistry;
import dalvik.system.PathClassLoader;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.security.MessageDigest;
import static org.junit.Assert.*;
/** Compare the generic font host with readerTypefaceFor loaded from the installed native APK. */
public final class ReaderFontNativeTest {
 private Context context(){Context c=InstrumentationRegistry.getInstrumentation().getTargetContext();assertEquals("dev.podjs.tests.readerfonts",c.getPackageName());return c;}
 private JSONObject args(String text,String path,int face,String axes)throws Exception{return new JSONObject().put("text",text).put("fontPath",path).put("fontFaceIndex",face).put("variationSettings",axes).put("fontWeight",650).put("italic",true).put("letterSpacingEm",.02).put("fontSizePx",28).put("widthPx",256).put("heightPx",48).put("baselinePx",35);}
 private Typeface reference(ClassLoader loader,File file,JSONObject args)throws Exception {
  Class<?> codec=loader.loadClass("com.lightningstudio.watchrss.data.reader.ReaderPresetCodec");Object instance=codec.getField("INSTANCE").get(null);
  JSONObject body=new JSONObject().put("fontWeight",args.getInt("fontWeight")).put("italic",args.getBoolean("italic")).put("fontFaceIndex",args.getInt("fontFaceIndex")).put("variationSettings",args.getString("variationSettings"));
  Object preset=codec.getMethod("decode",String.class).invoke(instance,new JSONObject().put("schemaVersion",2).put("id","font-oracle").put("name","font-oracle").put("body",body).toString());Object style=preset.getClass().getMethod("getBody").invoke(preset);
  Class<?> runtime=loader.loadClass("com.lightningstudio.watchrss.ui.reader.ReaderPresetRuntimeKt");return (Typeface)runtime.getMethod("readerTypefaceFor",File.class,style.getClass()).invoke(null,file,style);
 }
 private TextPaint paint(Typeface face,JSONObject args)throws Exception{TextPaint p=new TextPaint(Paint.ANTI_ALIAS_FLAG);p.setTypeface(face);p.setTextSize((float)args.getDouble("fontSizePx"));p.setLetterSpacing((float)args.getDouble("letterSpacingEm"));p.setSubpixelText(true);p.setUnderlineText(args.optBoolean("underline",false));p.setStrikeThruText(args.optBoolean("strikethrough",false));p.setColor(Color.WHITE);return p;}
 private StaticLayout line(String text,TextPaint paint){return StaticLayout.Builder.obtain(text,0,text.length(),paint,256).setIncludePad(false).setUseLineSpacingFromFallbacks(true).setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR).setAlignment(Layout.Alignment.ALIGN_NORMAL).setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE).setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE).setMaxLines(1).build();}
 private byte[] pixels(StaticLayout layout){return pixels(layout,48,64,35);}
 private byte[] pixels(StaticLayout layout,int height,int textureHeight,int baseline){Bitmap b=Bitmap.createBitmap(256,textureHeight,Bitmap.Config.ARGB_8888);try{Canvas canvas=new Canvas(b);canvas.clipRect(0,0,256,height);canvas.translate(0,baseline-layout.getLineBaseline(0));layout.draw(canvas);int[] p=new int[256*textureHeight];b.getPixels(p,0,256,0,0,256,textureHeight);byte[] out=new byte[p.length*4];for(int x=0;x<p.length;x++){out[x*4]=(byte)(p[x]>>>16);out[x*4+1]=(byte)(p[x]>>>8);out[x*4+2]=(byte)p[x];out[x*4+3]=(byte)(p[x]>>>24);}return out;}finally{b.recycle();}}
 private static String hash(File file)throws Exception{MessageDigest md=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1)md.update(buffer,0,n);}byte[] digest=md.digest();StringBuilder out=new StringBuilder();for(byte b:digest)out.append(String.format("%02x",b&255));return out.toString();}
 @Test public void customFilesFacesAxesFallbackAndReplacementMatchNativeReader()throws Exception {
  Context c=context();String referenceApk=InstrumentationRegistry.getArguments().getString("nativeReferenceApk");assertNotNull(referenceApk);assertTrue(new File(referenceApk).isFile());
  ClassLoader loader=new PathClassLoader(referenceApk,getClass().getClassLoader());File root=new File(c.getFilesDir(),"podjs/files/font-oracle");assertTrue(root.mkdirs()||root.isDirectory());
  JSONArray cases=new JSONArray();int differing=0;
  String[][] matrix={{"NotoSerif-Regular.ttf","0","","WWW iii fonts"},{"DroidSansMono.ttf","0","","WWW iii fonts"},{"NotoSerifCJK-Regular.ttc","0","","阅读字体骨直漢字"},{"NotoSerifCJK-Regular.ttc","1","","阅读字体骨直漢字"},{"NotoSansGeorgian-VF.ttf","0","'wght' 300","აბგდევზთ"},{"NotoSansGeorgian-VF.ttf","0","'wght' 800","აბგდევზთ"},{"NotoSerif-Regular.ttf","0","invalid axis","Fallback"},{"missing.ttf","0","","Fallback"},{"corrupt.ttf","0","","Fallback"}};
  for(String[] row:matrix){File file=new File(root,row[0]);if(row[0].equals("corrupt.ttf"))Files.write(file.toPath(),new byte[]{1,2,3});else if(!row[0].equals("missing.ttf"))Files.copy(new File("/system/fonts/"+row[0]).toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING);
   JSONObject a=args(row[3],"font-oracle/"+row[0],Integer.parseInt(row[1]),row[2]);Typeface expected=reference(loader,file.isFile()?file:null,a);TextPaint oracle=paint(expected,a);float measured=(float)PodTextLayoutServices.measure(c,a,new CancellationSignal()).getDouble("widthPx");assertEquals(row[0],oracle.measureText(row[3]),measured,.001);
   JSONObject rendered=PodTextRasterServices.raster(c,a,new CancellationSignal());byte[] actual=Files.readAllBytes(new File(c.getFilesDir(),"podjs/files/"+rendered.getString("path")).toPath());StaticLayout expectedLine=line(row[3],oracle);assertArrayEquals(row[0]+" pixels",pixels(expectedLine),actual);for(int j=0;j<=row[3].length();j++)assertEquals(expectedLine.getPrimaryHorizontal(j),rendered.getJSONArray("carets").getDouble(j),.001);PodTextRasterServices.discard(c,rendered);
   TextPaint fallback=paint(Typeface.create(Typeface.DEFAULT,650,true),a);if(!java.util.Arrays.equals(pixels(line(row[3],fallback)),actual))differing++;
   String paragraph=row[3]+" "+row[3]+" "+row[3];JSONObject pa=new JSONObject(a.toString()).put("text",paragraph).put("lineBreak","simple");JSONObject layout=PodTextLayoutServices.layout(c,pa,new CancellationSignal());StaticLayout expectedLayout=StaticLayout.Builder.obtain(paragraph,0,paragraph.length(),oracle,256).setIncludePad(false).setUseLineSpacingFromFallbacks(true).setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR).setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE).setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE).build();assertEquals(expectedLayout.getLineCount(),layout.getJSONArray("lines").length());for(int j=0;j<expectedLayout.getLineCount();j++){JSONObject l=layout.getJSONArray("lines").getJSONObject(j);assertEquals(expectedLayout.getLineStart(j),l.getInt("start"));assertEquals(expectedLayout.getLineEnd(j),l.getInt("end"));}
   cases.put(new JSONObject().put("font",row[0]).put("face",Integer.parseInt(row[1])).put("axes",row[2]).put("widthPx",measured).put("sourceSha256",file.isFile()?hash(file):JSONObject.NULL).put("pixelExact",true));
  }
  assertTrue("custom fonts did not change rendering",differing>=4);
  File replace=new File(root,"replace.ttf");Files.copy(new File("/system/fonts/NotoSerif-Regular.ttf").toPath(),replace.toPath(),StandardCopyOption.REPLACE_EXISTING);JSONObject a=args("WWW iii fonts","font-oracle/replace.ttf",0,"");double before=PodTextLayoutServices.measure(c,a,new CancellationSignal()).getDouble("widthPx");Files.copy(new File("/system/fonts/DroidSansMono.ttf").toPath(),replace.toPath(),StandardCopyOption.REPLACE_EXISTING);double after=PodTextLayoutServices.measure(c,a,new CancellationSignal()).getDouble("widthPx");assertNotEquals(before,after,.01);assertEquals(paint(reference(loader,replace,a),a).measureText("WWW iii fonts"),after,.001);
  for(String path:new String[]{"../escape.ttf","/system/fonts/Roboto-Regular.ttf","font-oracle/../replace.ttf","font-oracle\\replace.ttf"})try{PodTextLayoutServices.measure(c,args("x",path,0,""),new CancellationSignal());fail("unsafe path accepted");}catch(IllegalArgumentException expected){}
  JSONObject tall=args("Hi","font-oracle/replace.ttf",0,"").put("fontSizePx",128).put("heightPx",384).put("baselinePx",200).put("underline",true).put("strikethrough",true);JSONObject tallResult=PodTextRasterServices.raster(c,tall,new CancellationSignal());assertEquals(512,tallResult.getInt("height"));assertArrayEquals(pixels(line("Hi",paint(reference(loader,replace,tall),tall)),384,512,200),Files.readAllBytes(new File(c.getFilesDir(),"podjs/files/"+tallResult.getString("path")).toPath()));PodTextRasterServices.discard(c,tallResult);
  JSONObject largest=args("H","font-oracle/replace.ttf",0,"").put("fontSizePx",320).put("heightPx",960).put("baselinePx",600);JSONObject largestResult=PodTextRasterServices.raster(c,largest,new CancellationSignal());assertEquals(1024,largestResult.getInt("height"));assertArrayEquals(pixels(line("H",paint(reference(loader,replace,largest),largest)),960,1024,600),Files.readAllBytes(new File(c.getFilesDir(),"podjs/files/"+largestResult.getString("path")).toPath()));PodTextRasterServices.discard(c,largestResult);
  JSONObject proof=new JSONObject().put("nativeReferenceApkSha256",hash(new File(referenceApk))).put("nativeMethod","ReaderPresetRuntimeKt.readerTypefaceFor").put("cases",cases).put("customCasesDifferFromSystem",differing).put("replacementInvalidatesCache",true).put("pathEscapeRejected",true).put("tallLineHeightPx",384).put("decoratedPixelsExact",true).put("largestFontSizePx",320).put("largestLineHeightPx",960);
  Files.write(new File(c.getFilesDir(),"font-native-proof.json").toPath(),proof.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
 }
}
