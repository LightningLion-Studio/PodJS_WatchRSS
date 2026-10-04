package dev.podjs.androidwatch.reference

import androidx.test.platform.app.InstrumentationRegistry
import com.lightningstudio.watchrss.data.rss.*
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Test
import org.junit.Assert.*
import java.io.File
import java.io.ByteArrayOutputStream
import java.io.ByteArrayInputStream
import java.util.Base64
import java.util.zip.GZIPInputStream

class SyncBodyReferenceTest {
 @Test fun captureProductionBodyCodec() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  assertEquals("com.lightningstudio.watchrss.reference",instrumentation.targetContext.packageName)
  val input=instrumentation.context.assets.open("sync-body-input.json").bufferedReader().use{JSONObject(it.readText())}.getJSONArray("cases")
  val rows=JSONArray()
  for(i in 0 until input.length()){
   val row=input.getJSONObject(i)
   val article=SyncedSavedArticle("case-$i","phone","https://watchrss.local/import-content/txt/$i","Test","Local","",if(row.isNull("contentHtml"))null else row.getString("contentHtml"),row.getString("contentText"),null,"",0,0,favoriteSaved=false,favoriteChangedAt=0,favoriteSortOrder=0,watchLaterSaved=false,watchLaterChangedAt=0,watchLaterSortOrder=0,deleted=false,deletedAt=0)
   val payload=ArticleSyncBody.payloadForRequest(article,SyncedArticleBodyRequest(article.articleId,"",emptyList()))
   val output=ByteArrayOutputStream();payload.chunks.forEach{output.write(it.bytes)};val bytes=output.toByteArray()
   val rebuilt=ArticleSyncBody.rebuildBody(null,SyncedChunkedArticle(article,payload.metadata.bodyHash,payload.metadata.bodyByteCount,payload.metadata.chunkSize,payload.metadata.chunkHashes,payload.chunks),"")
   rows.put(JSONObject().put("bodyHash",payload.metadata.bodyHash).put("bodyByteCount",payload.metadata.bodyByteCount).put("chunkSize",payload.metadata.chunkSize).put("chunkHashes",JSONArray(payload.metadata.chunkHashes)).put("encodedBase64",Base64.getEncoder().encodeToString(bytes)).put("jsonBase64",Base64.getEncoder().encodeToString(GZIPInputStream(ByteArrayInputStream(bytes)).readBytes())).put("decoded",JSONObject().put("contentHtml",rebuilt.first?:JSONObject.NULL).put("contentText",rebuilt.second)))
  }
  assertEquals(8,rows.length())
  val result=JSONObject().put("sdk",android.os.Build.VERSION.SDK_INT).put("device",android.os.Build.MODEL).put("cases",rows)
  File(instrumentation.targetContext.getExternalFilesDir(null),"reference-sync-body.json").writeText(result.toString())
 }
}
