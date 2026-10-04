package dev.podjs.androidwatch.reference
import androidx.test.platform.app.InstrumentationRegistry
import androidx.room.Room
import com.lightningstudio.watchrss.WatchRssApplication
import com.lightningstudio.watchrss.data.db.*
import com.lightningstudio.watchrss.data.rss.*
import com.lightningstudio.watchrss.phoneconnection.bluetooth.LibrarySyncPayload
import kotlinx.coroutines.runBlocking
import org.json.JSONObject as J
import org.json.JSONArray as A
import org.junit.Test
import org.junit.Assert.*
import java.io.*
class LibraryRepositoryReferenceTest {
 private fun stable(value:String):String {val m=Class.forName("com.lightningstudio.watchrss.data.rss.DefaultRssRepositoryKt").getDeclaredMethod("stableArticleId",String::class.java);m.isAccessible=true;return m.invoke(null,value) as String}
 private fun str(j:J,k:String):String?=if(j.has(k)&&!j.isNull(k))j.getString(k)else null
 @Test fun captureRepository()=runBlocking {
  val inst=InstrumentationRegistry.getInstrumentation();assertEquals("com.lightningstudio.watchrss.reference",inst.targetContext.packageName)
  val input=inst.context.assets.open("library-repository-input.json").bufferedReader().use{J(it.readText())};val base=(inst.targetContext.applicationContext as WatchRssApplication).container.rssRepository
  fun field(n:String):Any? {val f=DefaultRssRepository::class.java.getDeclaredField(n);f.isAccessible=true;return f.get(base)}
  fun repository(db:WatchRssDatabase):DefaultRssRepository{val args=arrayOf(db.rssChannelDao(),db.rssItemDao(),db.savedEntryDao(),db.savedSyncStateDao(),db.offlineMediaDao(),db.syncChangeLogDao(),db.syncPeerStateDao(),db.rssSourceSyncStateDao(),field("cacheService"),field("appScope"),field("fetchService"),field("readableService"),field("parseService"),field("offlineStore"),"local",null);return DefaultRssRepository::class.java.declaredConstructors.first{it.parameterTypes.size==16}.newInstance(*args) as DefaultRssRepository}
  val sources=A()
  for(i in 0 until input.getJSONArray("sources").length()){
   val c=input.getJSONArray("sources").getJSONObject(i);val db=Room.inMemoryDatabaseBuilder(inst.targetContext,WatchRssDatabase::class.java).build()
   try{
    val repo=repository(db)
    if(c.getBoolean("existing"))db.rssChannelDao().insertChannel(RssChannelEntity(1,"https://feed.example/rss","Old Feed","Old description","old-image",100,10,40,false,true,true))
    val s=c.getJSONObject("source");val source=SyncedRssSource(s.getString("url"),s.getString("sourceDeviceId"),s.getString("title"),s.getString("description"),str(s,"siteUrl"),str(s,"imageUrl"),s.getLong("createdAt"),s.getLong("updatedAt"),s.getLong("sortOrder"),s.getBoolean("isPinned"),s.getBoolean("deleted"),s.getLong("deletedAt"))
    val method=DefaultRssRepository::class.java.getDeclaredMethod("normalizeUrl",String::class.java);method.isAccessible=true;val normalized=method.invoke(repo,source.url) as String;val android=android.net.Uri.parse(normalized)
    val started=System.currentTimeMillis();val stats=repo.mergeSyncedRssSources(listOf(source),c.getString("peer"),"local",c.getBoolean("authoritative"));val finished=System.currentTimeMillis()
    val row=J().put("input",c).put("normalizedUrl",normalized).put("androidUri",J().put("valid",true).put("scheme",android.scheme?:J.NULL).put("host",android.host?:J.NULL).put("rawPath",android.encodedPath?:J.NULL).put("rawQuery",android.encodedQuery?:J.NULL)).put("applied",stats.applied)
    val channels=A();var effectiveNow=started
    for(ch in db.rssChannelDao().getAllChannels()){if(ch.sortOrder in started..finished)effectiveNow=ch.sortOrder;if(ch.createdAt in started..finished)effectiveNow=ch.createdAt;channels.put(J().put("id",ch.id).put("url",ch.url).put("title",ch.title).put("description",ch.description?:J.NULL).put("imageUrl",ch.imageUrl?:J.NULL).put("lastFetchedAt",ch.lastFetchedAt?:J.NULL).put("createdAt",ch.createdAt).put("sortOrder",ch.sortOrder).put("isPinned",ch.isPinned).put("original",ch.useOriginalContent).put("background",ch.continuePlaybackInBackground))}
    row.put("channels",channels).put("now",effectiveNow).put("exportedSources",LibrarySyncPayload.buildManifestResponseFromEntries("local",emptyList(),emptyList(),repo.exportSyncedRssSources("local")).getJSONArray("rssSources"));sources.put(row)
   }finally{db.close()}
  }
  val deletions=A();val url="https://example.com/deletion";val id=stable(url)
  for(i in 0 until input.getJSONArray("deletions").length()){
   val c=input.getJSONArray("deletions").getJSONObject(i);val db=Room.inMemoryDatabaseBuilder(inst.targetContext,WatchRssDatabase::class.java).build()
   try{
    val repo=repository(db);db.rssChannelDao().insertChannel(RssChannelEntity(1,"https://feed.example/rss","Feed",null,null,null,1,1,false))
    if(!c.optBoolean("missingItem")){
     db.rssItemDao().insertItems(listOf(RssItemEntity(id=1,channelId=1,title="Original",description="body",content=if(c.optBoolean("noStoredBody"))null else"body",originalContent=null,link=url,guid="guid",pubDate=null,imageUrl=null,audioUrl=null,videoUrl=null,summary=null,previewImageUrl=null,isRead=false,isLiked=false,readingProgress=.2f,dedupKey="guid",fetchedAt=100,contentSizeBytes=4)))
     for(type in listOf("FAVORITE","WATCH_LATER")){val t=if(type=="FAVORITE")300L else 310L;db.savedEntryDao().insert(SavedEntryEntity(itemId=1,saveType=type,createdAt=t,sortOrder=t));db.savedSyncStateDao().upsert(SavedSyncStateEntity(id,type,1,url,true,t,t,"local"))}
    }
    if(c.has("currentDeleteAt"))db.savedSyncStateDao().upsert(SavedSyncStateEntity(id,"ARTICLE_DELETE",null,url,false,c.getLong("currentDeleteAt"),0,c.getString("currentDeletePeer")))
    val article=SyncedSavedArticle(articleId=id,sourceDeviceId=c.getString("peer"),url=url,title="Deleted",siteName="Feed",excerpt="",contentHtml=null,contentText=if(c.optBoolean("keepBody"))"body"else"",imageUrl=null,contentHash="",importedAt=100,updatedAt=200,rssSourceUrl="https://feed.example/rss",rssSourceTitle="Feed",favoriteSaved=c.getBoolean("favoriteSaved"),favoriteChangedAt=c.getLong("favoriteAt"),favoriteSortOrder=0,watchLaterSaved=c.getBoolean("laterSaved"),watchLaterChangedAt=c.getLong("laterAt"),watchLaterSortOrder=0,deleted=true,deletedAt=c.getLong("deletedAt"))
    val full=ArticleSyncBody.payloadForRequest(article,SyncedArticleBodyRequest(id,"",emptyList()));val m=full.metadata;val payload=SyncedChunkedArticle(article,if(c.optBoolean("badHash"))"bad"else m.bodyHash,m.bodyByteCount,m.chunkSize,m.chunkHashes,if(c.getBoolean("metadataOnly"))emptyList()else full.chunks,c.getBoolean("metadataOnly"));val bytes=ByteArrayOutputStream();full.chunks.forEach{bytes.write(it.bytes)}
    val row=J().put("input",c).put("articleId",id).put("bodyHash",m.bodyHash).put("bodyBytes",m.bodyByteCount).put("chunkSize",m.chunkSize).put("chunkHashes",A(m.chunkHashes)).put("encodedBase64",java.util.Base64.getEncoder().encodeToString(bytes.toByteArray()))
    try{val result=repo.mergeSyncedChunkedArticles(listOf(payload),c.getString("peer"),"local",c.getBoolean("authoritative"));row.put("ok",true).put("applied",result.applied)}catch(e:Exception){row.put("ok",false).put("error",e.message)}
    val items=A();for(item in db.rssItemDao().getItemsForChannelSync(1,100))items.put(J().put("id",item.id).put("title",item.title).put("content",item.content?:J.NULL))
    val entries=A();for(type in listOf("FAVORITE","WATCH_LATER"))for(saved in db.savedEntryDao().getSavedItems(type))entries.put(J().put("itemId",saved.item.id).put("type",type).put("createdAt",saved.savedAt))
    val states=A();for(s in db.savedSyncStateDao().getAll().sortedBy{it.saveType})states.put(J().put("articleId",s.articleId).put("type",s.saveType).put("itemId",s.itemId?:J.NULL).put("url",s.url).put("saved",s.saved).put("changedAt",s.changedAt).put("sortOrder",s.sortOrder).put("source",s.sourceDeviceId))
    val manifests=repo.exportSyncedArticleManifests("local");row.put("items",items).put("entries",entries).put("states",states).put("manifest",LibrarySyncPayload.buildManifestResponseFromEntries("local",manifests,emptyList()).getJSONArray("articleManifest"));deletions.put(row)
   }finally{db.close()}
  }
  File(inst.targetContext.getExternalFilesDir(null),"reference-library-repository.json").writeText(J().put("input",input).put("sources",sources).put("deletions",deletions).toString())
 }
}
