package dev.podjs.androidwatch.reference
import androidx.test.platform.app.InstrumentationRegistry
import com.lightningstudio.watchrss.phoneconnection.bluetooth.LibrarySyncPayload
import com.lightningstudio.watchrss.data.rss.ArticleSyncBody
import org.json.JSONObject as J
import org.json.JSONArray as A
import org.junit.Test
import org.junit.Assert.*
import java.io.File

class ArticleBatchReferenceTest {
 @Test fun captureProductionArticleParser(){
  val inst=InstrumentationRegistry.getInstrumentation();assertEquals("com.lightningstudio.watchrss.reference",inst.targetContext.packageName)
  val input=inst.context.assets.open("article-batches-input.json").bufferedReader().use{J(it.readText())};val output=J()
  val cases=input.getJSONArray("articles");val articles=A()
  for(i in 0 until cases.length()){
   val row=cases.getJSONObject(i);val r=J().put("name",row.getString("name")).put("frames",row.getJSONArray("frames"))
   try{
    val frames=row.getJSONArray("frames");val values=LibrarySyncPayload.parseChunkedArticles((0 until frames.length()).map{J(frames.getString(it))});val parsed=A()
    for(p in values){val a=p.article;val article=J().put("articleId",a.articleId).put("url",a.url).put("sourceDeviceId",a.sourceDeviceId).put("title",a.title).put("siteName",a.siteName).put("excerpt",a.excerpt).put("imageUrl",a.imageUrl?:J.NULL).put("contentHash",a.contentHash).put("importedAt",a.importedAt).put("updatedAt",a.updatedAt).put("independentSaved",a.independentSaved).put("independentChangedAt",a.independentChangedAt).put("independentSortOrder",a.independentSortOrder).put("rssSourceUrl",a.rssSourceUrl?:J.NULL).put("rssSourceTitle",a.rssSourceTitle?:J.NULL).put("favoriteSaved",a.favoriteSaved).put("favoriteChangedAt",a.favoriteChangedAt).put("favoriteSortOrder",a.favoriteSortOrder).put("watchLaterSaved",a.watchLaterSaved).put("watchLaterChangedAt",a.watchLaterChangedAt).put("watchLaterSortOrder",a.watchLaterSortOrder).put("deleted",a.deleted).put("deletedAt",a.deletedAt).put("readingProgress",a.readingProgress.toDouble()).put("readingPositionBytes",a.readingPositionBytes).put("readingPositionContentHash",a.readingPositionContentHash).put("readingPositionChangedAt",a.readingPositionChangedAt).put("isRead",a.isRead)
     val chunks=A();for(c in p.chunks)chunks.put(J().put("index",c.index).put("hash",c.hash).put("data",ArticleSyncBody.encodeChunkData(c.bytes)))
     parsed.put(J().put("article",article).put("body",J().put("articleId",a.articleId).put("bodyHash",p.bodyHash).put("bodyByteCount",p.bodyByteCount).put("chunkSize",p.chunkSize).put("chunkHashes",A(p.chunkHashes)).put("chunks",chunks).put("metadataOnly",p.metadataOnly)))
    };r.put("ok",true).put("parsed",parsed)
   }catch(e:Exception){r.put("ok",false).put("error",e.message)};articles.put(r)
  };output.put("articles",articles)
  val batches=A();val source=input.getJSONArray("batches")
  for(i in 0 until source.length()){val r=source.getJSONObject(i);try{r.put("result",LibrarySyncPayload.validateArticleRequestFrame(J(r.getString("frame")),r.getInt("index"),if(r.isNull("count"))null else r.getInt("count"))).put("ok",true)}catch(e:Exception){r.put("ok",false).put("error",e.message)};batches.put(r)};output.put("batches",batches)
  val base=A();val encoded=input.getJSONArray("base64")
  for(i in 0 until encoded.length()){val v=encoded.getString(i);val r=J().put("input",v);try{r.put("encoded",ArticleSyncBody.encodeChunkData(ArticleSyncBody.decodeChunkData(v))).put("ok",true)}catch(e:Exception){r.put("ok",false)};base.put(r)};output.put("base64",base)
  output.put("sdk",android.os.Build.VERSION.SDK_INT).put("device",android.os.Build.MODEL)
  File(inst.targetContext.getExternalFilesDir(null),"reference-article-batches.json").writeText(output.toString())
 }
}
