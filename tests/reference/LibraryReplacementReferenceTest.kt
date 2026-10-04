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
class LibraryReplacementReferenceTest {
 @Test fun captureReplacement()=runBlocking {
  val inst=InstrumentationRegistry.getInstrumentation();assertEquals("com.lightningstudio.watchrss.reference",inst.targetContext.packageName)
  val inputs=inst.context.assets.open("library-replacement-input.json").bufferedReader().use{A(it.readText())};val base=(inst.targetContext.applicationContext as WatchRssApplication).container.rssRepository
  fun field(n:String):Any?{val f=DefaultRssRepository::class.java.getDeclaredField(n);f.isAccessible=true;return f.get(base)}
  val results=A()
  for(i in 0 until inputs.length()) {val c=inputs.getJSONObject(i);val db=Room.inMemoryDatabaseBuilder(inst.targetContext,WatchRssDatabase::class.java).build()
   try {
    val args=arrayOf(db.rssChannelDao(),db.rssItemDao(),db.savedEntryDao(),db.savedSyncStateDao(),db.offlineMediaDao(),db.syncChangeLogDao(),db.syncPeerStateDao(),db.rssSourceSyncStateDao(),field("cacheService"),field("appScope"),field("fetchService"),field("readableService"),field("parseService"),field("offlineStore"),"local",null)
    val repo=DefaultRssRepository::class.java.declaredConstructors.first{it.parameterTypes.size==16}.newInstance(*args) as DefaultRssRepository
    val urls=listOf("watchrss://phone-imports","https://feed.example/rss","https://other.example/rss")
    for((index,url) in urls.withIndex())db.rssChannelDao().insertChannel(RssChannelEntity((index+1).toLong(),url,"Channel",null,null,null,1,1,false))
    val keys=listOf("keep-id","rss-guid","feed-id","other-id")
    for((index,key) in keys.withIndex()){val id=(index+1).toLong();val ch=if(index<2)1L else index.toLong();db.rssItemDao().insertItems(listOf(RssItemEntity(id=id,channelId=ch,title=key,description=null,content="body",originalContent=null,link="https://example.com/$key",guid=key,pubDate=null,imageUrl=null,audioUrl=null,videoUrl=null,summary=null,previewImageUrl=null,isRead=false,isLiked=false,readingProgress=0f,dedupKey=key,fetchedAt=100,contentSizeBytes=4)));db.savedEntryDao().insert(SavedEntryEntity(itemId=id,saveType="FAVORITE",createdAt=100,sortOrder=100));db.savedSyncStateDao().upsert(SavedSyncStateEntity(key,"FAVORITE",id,"https://example.com/$key",true,100,100,"local"))}
    db.savedSyncStateDao().upsert(SavedSyncStateEntity("obsolete","ARTICLE_DELETE",null,"https://example.com/gone",false,10,0,"local"))
    for(url in urls.drop(1))db.rssSourceSyncStateDao().upsert(RssSourceSyncStateEntity(url,"local","Channel","",null,null,1,1,1,false,false,0))
    db.syncChangeLogDao().insert(SyncChangeLogEntity(kind="article",entityId="keep-id",changedAt=100,originDeviceId="local",reason="test",createdAt=100));db.syncPeerStateDao().upsert(SyncPeerStateEntity("phone",1,4,100,14,100))
    fun strings(name:String)=c.getJSONArray(name).let{a->(0 until a.length()).map{a.getString(it)}}
    repo.finalizeAuthoritativeLibrarySnapshot(strings("articles"),strings("sources"))
    val items=A();for(ch in 1L..3L)for(item in db.rssItemDao().getItemsForChannelSync(ch,100).sortedBy{it.id})items.put(J().put("id",item.id).put("channelId",item.channelId).put("dedupKey",item.dedupKey))
    val channels=A();for(ch in db.rssChannelDao().getAllChannels().sortedBy{it.id})channels.put(J().put("id",ch.id).put("url",ch.url))
    val entries=A();for(entry in db.savedEntryDao().getSavedItems("FAVORITE").sortedBy{it.item.id})entries.put(entry.item.id)
    val states=A();for(s in db.savedSyncStateDao().getAll().sortedBy{it.articleId})states.put(J().put("articleId",s.articleId).put("type",s.saveType).put("itemId",s.itemId?:J.NULL))
    results.put(J().put("input",c).put("items",items).put("channels",channels).put("entries",entries).put("states",states).put("sourceStates",A(db.rssSourceSyncStateDao().getAll().map{it.url}.sorted())).put("logMax",db.syncChangeLogDao().maxSeq()).put("peerExists",db.syncPeerStateDao().get("phone")!=null))
   }finally{db.close()}
  }
  File(inst.targetContext.getExternalFilesDir(null),"reference-library-replacement.json").writeText(J().put("cases",results).toString())
 }
}
