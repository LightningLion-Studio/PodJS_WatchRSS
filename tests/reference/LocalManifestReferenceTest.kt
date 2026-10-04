package dev.podjs.androidwatch.reference
import androidx.test.platform.app.InstrumentationRegistry
import androidx.room.Room
import com.lightningstudio.watchrss.WatchRssApplication
import com.lightningstudio.watchrss.data.db.*
import com.lightningstudio.watchrss.data.rss.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject as J
import org.json.JSONArray as A
import org.junit.Test
import org.junit.Assert.*
import java.io.File
class LocalManifestReferenceTest {
 private fun stable(value:String):String {val m=Class.forName("com.lightningstudio.watchrss.data.rss.DefaultRssRepositoryKt").getDeclaredMethod("stableArticleId",String::class.java);m.isAccessible=true;return m.invoke(null,value) as String}
 private fun nullable(r:J,k:String)=if(r.isNull(k))null else r.getString(k)
 private fun json(value:Any):J {val out=J();for(f in value.javaClass.declaredFields){if(f.isSynthetic||f.name=="cachedBodyMetadata")continue;f.isAccessible=true;val v=f.get(value);out.put(f.name,when(v){null->J.NULL;is Float->v.toDouble();is List<*>->A(v);else->v})};return out}
 @Test fun captureRoomExport()=runBlocking {
  val inst=InstrumentationRegistry.getInstrumentation();assertEquals("com.lightningstudio.watchrss.reference",inst.targetContext.packageName)
  val input=inst.context.assets.open("local-manifest-input.json").bufferedReader().use{J(it.readText())}
  val db=Room.inMemoryDatabaseBuilder(inst.targetContext,WatchRssDatabase::class.java).build()
  val directory=File(inst.targetContext.cacheDir,"manifest-reference-content");directory.mkdirs()
  val constructor=FileArticleContentStore::class.java.getDeclaredConstructor(File::class.java);constructor.isAccessible=true;val store=constructor.newInstance(directory)
  try {
   val base=(inst.targetContext.applicationContext as WatchRssApplication).container.rssRepository
   fun field(n:String):Any? {val f=DefaultRssRepository::class.java.getDeclaredField(n);f.isAccessible=true;return f.get(base)}
   val args=arrayOf(db.rssChannelDao(),db.rssItemDao(),db.savedEntryDao(),db.savedSyncStateDao(),db.offlineMediaDao(),db.syncChangeLogDao(),db.syncPeerStateDao(),db.rssSourceSyncStateDao(),field("cacheService"),field("appScope"),field("fetchService"),field("readableService"),field("parseService"),field("offlineStore"),"local",store)
   val repo=DefaultRssRepository::class.java.declaredConstructors.first{it.parameterTypes.size==16}.newInstance(*args) as DefaultRssRepository
   val channels=input.getJSONArray("channels");for(i in 0 until channels.length()){val c=channels.getJSONObject(i);db.rssChannelDao().insertChannel(RssChannelEntity(c.getLong("id"),c.getString("url"),c.getString("title"),null,null,null,1,0,false))}
   val items=input.getJSONArray("items");for(i in 0 until items.length()){val r=items.getJSONObject(i);val content=nullable(r,"content")?.let{if(it=="@missing")store.markerFor("missing") else if(it.length>50000)store.storeText("large",it)else it}
    db.rssItemDao().insertItems(listOf(RssItemEntity(id=r.getLong("id"),channelId=r.getLong("channelId"),title=r.getString("title"),description=nullable(r,"description"),content=content,originalContent=nullable(r,"originalContent"),link=r.getString("url"),guid=null,pubDate=null,imageUrl=nullable(r,"imageUrl"),audioUrl=null,videoUrl=null,summary=nullable(r,"summary"),previewImageUrl=nullable(r,"previewImageUrl"),isRead=r.getBoolean("isRead"),isLiked=false,readingProgress=r.getDouble("readingProgress").toFloat(),dedupKey="item-${r.getLong("id")}",fetchedAt=r.getLong("fetchedAt"),contentSizeBytes=0,syncBodyHash=r.getString("syncBodyHash"),readingPositionBytes=r.getLong("readingPositionBytes"),readingPositionContentHash=r.getString("readingPositionContentHash"),readingPositionChangedAt=r.getLong("readingPositionChangedAt"))))
   }
   fun saveType(s:String)=when(s){"favorite"->"FAVORITE";"watchLater"->"WATCH_LATER";else->"ARTICLE_DELETE"}
   val saves=input.getJSONArray("saves");for(i in 0 until saves.length()){val s=saves.getJSONObject(i);db.savedEntryDao().insert(SavedEntryEntity(itemId=s.getLong("itemId"),saveType=saveType(s.getString("type")),createdAt=s.getLong("createdAt"),sortOrder=s.getLong("sortOrder")))}
   val states=input.getJSONArray("states");for(i in 0 until states.length()){val s=states.getJSONObject(i);db.savedSyncStateDao().upsert(SavedSyncStateEntity(stable(s.getString("url")),saveType(s.getString("type")),if(s.isNull("itemId"))null else s.getLong("itemId"),s.getString("url"),s.getBoolean("saved"),s.getLong("changedAt"),s.getLong("sortOrder"),s.getString("sourceDeviceId")))}
   val articles=A();for(a in repo.exportSyncedSavedArticles("local"))articles.put(J().put("article",json(a)).put("metadataHash",ArticleSyncBody.metadataHashFor(a)))
   val first=A();for(a in repo.exportSyncedArticleManifests("local"))first.put(json(a))
   val second=A();for(a in repo.exportSyncedArticleManifests("local"))second.put(json(a))
   val requests=(0 until first.length()).map{val m=first.getJSONObject(it);SyncedArticleBodyRequest(m.getString("articleId"),"",emptyList())}
   val payloads=A();for(a in repo.exportSyncedSavedArticlesForRequests("local",requests)){val payload=ArticleSyncBody.payloadForRequest(a,SyncedArticleBodyRequest(a.articleId,"",emptyList()));val bytes=java.io.ByteArrayOutputStream();for(c in payload.chunks)bytes.write(c.bytes);payloads.put(J().put("article",json(a)).put("encodedBase64",java.util.Base64.getEncoder().encodeToString(bytes.toByteArray())))}
   val urls=A();for(i in 0 until input.getJSONArray("urls").length()){val value=input.getJSONArray("urls").getString(i);urls.put(J().put("value",value).put("articleId",stable(value)))}
   val output=J().put("input",input).put("articles",articles).put("first",first).put("second",second).put("urls",urls).put("payloads",payloads).put("sdk",android.os.Build.VERSION.SDK_INT).put("device",android.os.Build.MODEL)
   File(inst.targetContext.getExternalFilesDir(null),"reference-local-manifest.json").writeText(output.toString())
  }finally{db.close();directory.deleteRecursively()}
 }
}
