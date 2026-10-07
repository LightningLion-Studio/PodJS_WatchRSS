import kotlin.text.StringsKt;
import java.util.Locale;
import org.json.JSONObject;
import org.json.JSONArray;
/** Runs Kotlin/JVM trim itself (not a port of its whitespace predicate).
 * Native semantics from 6bb99ed4 ImportedContentIds.kt:10-15,22-25,36-41. */
public final class ImportedContentKotlinOracle {
 static String normalize(String value) { return value==null?"":StringsKt.trim(value).toString().toLowerCase(Locale.ROOT); }
 static boolean imported(String value) {
  String s=normalize(value);
  return s.startsWith("https://watchrss.local/import-content")||s.startsWith("https://watchrss.local/import-epub")||s.startsWith("https://watchrss.local/import-txt-novel")||s.equals("watchrss://phone-imports");
 }
 public static void main(String[] args) throws Exception {
  JSONArray whitespace=new JSONArray(),cases=new JSONArray();
  for(int cp=0;cp<=65535;cp++)if(StringsKt.trim(String.valueOf((char)cp)).length()==0)whitespace.put(cp);
  String[] urls={null,"","https://watchrss.local/import-content/txt/book","https://watchrss.local/import-epub","https://watchrss.local/import-txt-novel/book/chapter/001","watchrss://phone-imports","HTTPS://WATCHRSS.LOCAL/IMPORT-TXT-NOVEL","https://watchrss.local/import-content-extra","https://example.com"};
  String[] edges={""," ","\u001c","\u001d","\u001e","\u001f","\u00a0","\u0085","\u180e","\ufeff","\u200b","\u3000"};
  for(String url:urls)for(String edge:edges){String value=url==null?null:edge+url+edge;
   cases.put(new JSONObject().put("url",value==null?JSONObject.NULL:value).put("imported",imported(value)).put("deletable",imported(value)).put("textItem",normalize(value).startsWith("https://watchrss.local/import-content/txt/")));
  }
  System.out.println(new JSONObject().put("oracle","Kotlin/JVM 2.0.21 StringsKt.trim; native ImportedContentIds 6bb99ed4").put("whitespaceCodePoints",whitespace).put("cases",cases).toString(2));
 }
}
