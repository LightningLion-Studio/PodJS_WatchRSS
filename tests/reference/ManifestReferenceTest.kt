package dev.podjs.androidwatch.reference
import androidx.test.platform.app.InstrumentationRegistry
import com.lightningstudio.watchrss.phoneconnection.bluetooth.LibrarySyncPayload
import com.lightningstudio.watchrss.data.rss.SyncedArticleManifest
import org.json.JSONObject as J
import org.json.JSONArray as A
import org.junit.Test
import org.junit.Assert.*
import java.io.File
class ManifestReferenceTest {
 @Test fun captureProductionManifestSelection() {
  val inst=InstrumentationRegistry.getInstrumentation();assertEquals("com.lightningstudio.watchrss.reference",inst.targetContext.packageName)
  val input=inst.context.assets.open("manifest-selection-input.json").bufferedReader().use{A(it.readText())};val rows=A()
  for(i in 0 until input.length()) {
   val row=input.getJSONObject(i)
   try {
    val local=LibrarySyncPayload.parseArticleManifest(J(row.getString("local"))).map{a->SyncedArticleManifest(articleId=a.articleId,sourceDeviceId=a.sourceDeviceId,contentHash=a.contentHash,updatedAt=a.updatedAt,independentChangedAt=a.independentChangedAt,favoriteChangedAt=a.favoriteChangedAt,watchLaterChangedAt=a.watchLaterChangedAt,deletedAt=a.deletedAt,deleted=a.deleted,bodyHash=a.bodyHash,bodyByteCount=a.bodyByteCount,chunkSize=a.chunkSize,chunkHashes=a.chunkHashes,metadataHash=a.metadataHash,bodyAvailable=a.bodyAvailable,bodySyncMode=a.bodySyncMode,readingProgress=a.readingProgress,readingPositionBytes=a.readingPositionBytes,readingPositionContentHash=a.readingPositionContentHash,readingPositionChangedAt=a.readingPositionChangedAt,isRead=a.isRead)}
    val remote=LibrarySyncPayload.parseArticleManifest(J(row.getString("remote")))
    val requests=LibrarySyncPayload.buildBodyRequestsForRemoteArticles(local,remote,row.getInt("limit"),row.getBoolean("support"))
    val out=A();for(r in requests)out.put(J().put("articleId",r.articleId).put("bodyHash",r.bodyHash).put("chunkIndexes",A(r.chunkIndexes)).put("metadataOnly",r.metadataOnly))
    row.put("ok",true).put("requests",out)
   }catch(e:Exception){row.put("ok",false).put("error",e.message)}
   rows.put(row)
  }
  File(inst.targetContext.getExternalFilesDir(null),"reference-manifest-selection.json").writeText(J().put("cases",rows).put("sdk",android.os.Build.VERSION.SDK_INT).put("device",android.os.Build.MODEL).toString())
 }
}
