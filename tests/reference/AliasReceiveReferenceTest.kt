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
class AliasReceiveReferenceTest {
 private fun stable(value:String):String {val m=Class.forName("com.lightningstudio.watchrss.data.rss.DefaultRssRepositoryKt").getDeclaredMethod("stableArticleId",String::class.java);m.isAccessible=true;return m.invoke(null,value) as String}
 @Test fun captureAliasReceive()=runBlocking {
  val inst=InstrumentationRegistry.getInstrumentation();assertEquals("com.lightningstudio.watchrss.reference",inst.targetContext.packageName)
  val input=inst.context.assets.open("alias-receive-input.json").bufferedReader().use{A(it.readText())};val output=A()
  val base=(inst.targetContext.applicationContext as WatchRssApplication).container.rssRepository
  fun field(n:String):Any? {val f=DefaultRssRepository::class.java.getDeclaredField(n);f.isAccessible=true;return f.get(base)}
  val url="https://example.com/alias";val id=stable(url)
  for(i in 0 until input.length()){
   val c=input.getJSONObject(i);val db=Room.inMemoryDatabaseBuilder(inst.targetContext,WatchRssDatabase::class.java).build()
   try {
    val args=arrayOf(db.rssChannelDao(),db.rssItemDao(),db.savedEntryDao(),db.savedSyncStateDao(),db.offlineMediaDao(),db.syncChangeLogDao(),db.syncPeerStateDao(),db.rssSourceSyncStateDao(),field("cacheService"),field("appScope"),field("fetchService"),field("readableService"),field("parseService"),field("offlineStore"),"local",null)
    val repo=DefaultRssRepository::class.java.declaredConstructors.first{it.parameterTypes.size==16}.newInstance(*args) as DefaultRssRepository
    db.rssChannelDao().insertChannel(RssChannelEntity(1,"https://feed.example/rss","Feed",null,null,null,1,1,false))
    db.rssItemDao().insertItems(listOf(RssItemEntity(id=1,channelId=1,title="Original RSS",description="body",content=if(c.optBoolean("noStoredBody"))null else "body",originalContent=null,link=url,guid="feed-guid",pubDate=null,imageUrl=null,audioUrl=null,videoUrl=null,summary=null,previewImageUrl=null,isRead=true,isLiked=false,readingProgress=.8f,dedupKey="feed-guid",fetchedAt=100,contentSizeBytes=4,readingPositionBytes=3,readingPositionContentHash="old",readingPositionChangedAt=200)))
    for(type in listOf("FAVORITE","WATCH_LATER")){val favorite=type=="FAVORITE";db.savedEntryDao().insert(SavedEntryEntity(itemId=1,saveType=type,createdAt=if(favorite)30 else 40,sortOrder=if(favorite)300 else 400));if(!c.optBoolean("noStates"))db.savedSyncStateDao().upsert(SavedSyncStateEntity(id,type,1,url,true,if(favorite)100 else 120,if(favorite)300 else 400,"local"))}
    val article=SyncedSavedArticle(articleId=id,sourceDeviceId=c.getString("peer"),url=url,title="Remote",siteName="Feed",excerpt="body",contentHtml=null,contentText="body",imageUrl=null,contentHash="",importedAt=150,updatedAt=150,rssSourceUrl="https://feed.example/rss",rssSourceTitle="Feed",favoriteSaved=c.getBoolean("favorite"),favoriteChangedAt=c.getLong("favoriteAt"),favoriteSortOrder=500,watchLaterSaved=c.getBoolean("later"),watchLaterChangedAt=c.getLong("laterAt"),watchLaterSortOrder=600,deleted=false,deletedAt=0,readingProgress=.2f,readingPositionBytes=1,readingPositionContentHash="remote",readingPositionChangedAt=50,isRead=false)
    val metadata=ArticleSyncBody.metadataFor(article);val full=ArticleSyncBody.payloadForRequest(article,SyncedArticleBodyRequest(id,"",emptyList()))
    val payload=SyncedChunkedArticle(article,if(c.optBoolean("badHash"))"bad" else metadata.bodyHash,metadata.bodyByteCount,metadata.chunkSize,metadata.chunkHashes,if(c.getBoolean("metadataOnly"))emptyList()else full.chunks,c.getBoolean("metadataOnly"))
    val result=J().put("input",c).put("articleId",id).put("bodyHash",metadata.bodyHash).put("bodyBytes",metadata.bodyByteCount).put("chunkSize",metadata.chunkSize).put("chunkHashes",A(metadata.chunkHashes));val encoded=java.io.ByteArrayOutputStream();for(chunk in full.chunks)encoded.write(chunk.bytes);result.put("encodedBase64",java.util.Base64.getEncoder().encodeToString(encoded.toByteArray()))
    try{val stats=repo.mergeSyncedChunkedArticles(listOf(payload),c.getString("peer"),"local",c.getBoolean("authoritative"));result.put("ok",true).put("applied",stats.applied)}catch(e:Exception){result.put("ok",false).put("error",e.message)}
    val items=A();for(item in db.rssItemDao().getItemsForChannelSync(1,100).sortedBy{it.id})items.put(J().put("id",item.id).put("dedupKey",item.dedupKey).put("title",item.title).put("content",item.content?:J.NULL).put("progress",item.readingProgress.toDouble()).put("position",item.readingPositionBytes).put("readingAt",item.readingPositionChangedAt).put("isRead",item.isRead));result.put("items",items)
    val entries=A();for(type in listOf("FAVORITE","WATCH_LATER"))for(saved in db.savedEntryDao().getSavedItems(type).sortedBy{it.item.id})entries.put(J().put("itemId",saved.item.id).put("type",type).put("createdAt",saved.savedAt));result.put("entries",entries)
    val states=A();for(s in db.savedSyncStateDao().getAll().sortedBy{it.saveType})states.put(J().put("itemId",s.itemId?:J.NULL).put("type",s.saveType).put("saved",s.saved).put("changedAt",s.changedAt).put("sortOrder",s.sortOrder).put("source",s.sourceDeviceId));result.put("states",states);output.put(result)
   }finally{db.close()}
  }
  File(inst.targetContext.getExternalFilesDir(null),"reference-alias-receive.json").writeText(J().put("cases",output).put("sdk",android.os.Build.VERSION.SDK_INT).put("device",android.os.Build.MODEL).toString())
 }
}
