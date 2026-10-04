package dev.podjs.androidwatch.reference
import androidx.test.platform.app.InstrumentationRegistry
import com.lightningstudio.watchrss.data.rss.*
import com.lightningstudio.watchrss.phoneconnection.bluetooth.*
import org.json.JSONObject as J
import org.json.JSONArray as A
import org.junit.Test
import org.junit.Assert.*
import java.io.*
class LibraryWireReferenceTest {
 private fun body(length:Int):String{var x=123456789L;val alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";val out=StringBuilder();for(i in 0 until length){x=(x*1664525L+1013904223L)and 0xffffffffL;if(i%257==0)out.append("文😀")else out.append(alphabet[(x ushr 26).toInt()])};return out.toString()}
 @Test fun captureWire(){
  val inst=InstrumentationRegistry.getInstrumentation();assertEquals("com.lightningstudio.watchrss.reference",inst.targetContext.packageName)
  val input=inst.context.assets.open("library-wire-input.json").bufferedReader().use{A(it.readText())};val output=A()
  for(i in 0 until input.length()){
   val c=input.getJSONObject(i);val text=body(c.getInt("length"));val articles=(0 until c.getInt("copies")).map{n->SyncedSavedArticle(articleId="wire-$n",sourceDeviceId="watch",url="https://example.com/$n",title="标题 \"Quote\" / $n",siteName="Site",excerpt="Description",contentHtml=null,contentText=text,imageUrl=null,contentHash="content-$n",importedAt=100,updatedAt=200,independentSaved=true,independentChangedAt=100,independentSortOrder=100,rssSourceUrl=null,rssSourceTitle=null,favoriteSaved=true,favoriteChangedAt=200,favoriteSortOrder=300,watchLaterSaved=false,watchLaterChangedAt=0,watchLaterSortOrder=0,deleted=false,deletedAt=0,readingProgress=.2f)}
   val prepared=A();val requests=articles.map{a->val metadata=ArticleSyncBody.metadataFor(a);SyncedArticleBodyRequest(a.articleId,if(c.getString("mode")=="stale")"stale"else metadata.bodyHash,when(c.getString("mode")){"subset"->listOf(1);"invalid"->listOf(99);else->emptyList()},c.getString("mode") in listOf("metadata","stale"))}
   for(a in articles){val metadata=ArticleSyncBody.metadataFor(a);val full=ArticleSyncBody.payloadForRequest(a,SyncedArticleBodyRequest(a.articleId,"",emptyList()));val bytes=ByteArrayOutputStream();full.chunks.forEach{bytes.write(it.bytes)};val basic=LibrarySyncPayload.buildChunkedResponseFrames("watch",listOf(a),listOf(SyncedArticleBodyRequest(a.articleId,metadata.bodyHash,emptyList(),true)),0,0,false).first().getJSONArray("articles").getJSONObject(0)
    prepared.put(J().put("article",basic).put("metadataHash",metadata.metadataHash).put("encodedBase64",java.util.Base64.getEncoder().encodeToString(bytes.toByteArray())))
   }
   val req=A();requests.forEach{r->req.put(J().put("articleId",r.articleId).put("bodyHash",r.bodyHash).put("chunkIndexes",A(r.chunkIndexes)).put("metadataOnly",r.metadataOnly))}
   val row=J().put("input",c).put("prepared",prepared).put("requests",req)
   try{val frames=LibrarySyncPayload.buildChunkedResponseFrames("watch",articles,requests,3,2,c.getBoolean("batches"));row.put("ok",true).put("frames",A(frames))}catch(e:Exception){row.put("ok",false).put("error",e.message)}
   output.put(row)
  }
  val floats=A();for(bits in listOf(0,1,2,0x00800000,0x38d1b717,0x322bcc77,0x3eaaaaab,0x3dcccccd,0x3f7fffff,0x3f800000)){val f=java.lang.Float.intBitsToFloat(bits);floats.put(J().put("bits",bits).put("value",f))}
  File(inst.targetContext.getExternalFilesDir(null),"reference-library-wire.json").writeText(J().put("cases",output).put("floatProgress",floats).toString())
 }
}
