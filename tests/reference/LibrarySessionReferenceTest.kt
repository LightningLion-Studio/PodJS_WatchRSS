package dev.podjs.androidwatch.reference
import androidx.test.platform.app.InstrumentationRegistry
import androidx.room.Room
import com.lightningstudio.watchrss.WatchRssApplication
import com.lightningstudio.watchrss.data.db.*
import com.lightningstudio.watchrss.data.rss.*
import com.lightningstudio.watchrss.phoneconnection.WatchDeviceIdentity
import com.lightningstudio.watchrss.phoneconnection.bluetooth.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject as J
import org.json.JSONArray as A
import org.junit.Test
import org.junit.Assert.*
import java.io.*
class LibrarySessionReferenceTest {
 @Test fun captureSession()=runBlocking {
  val inst=InstrumentationRegistry.getInstrumentation();assertEquals("com.lightningstudio.watchrss.reference",inst.targetContext.packageName)
  val app=inst.targetContext.applicationContext as WatchRssApplication;val container=app.container;val original=container.rssRepository
  val delegate=container.javaClass.getDeclaredField("rssRepository\$delegate");delegate.isAccessible=true;val oldDelegate=delegate.get(container)
  fun field(n:String):Any? {val f=DefaultRssRepository::class.java.getDeclaredField(n);f.isAccessible=true;return f.get(original)}
  val local=WatchDeviceIdentity(inst.targetContext).deviceId
  val inputs=inst.context.assets.open("library-session-input.json").bufferedReader().use{A(it.readText())};val cases=A()
  for(i in 0 until inputs.length()){
   val c=inputs.getJSONObject(i);val db=Room.inMemoryDatabaseBuilder(inst.targetContext,WatchRssDatabase::class.java).build()
   try{
    val args=arrayOf(db.rssChannelDao(),db.rssItemDao(),db.savedEntryDao(),db.savedSyncStateDao(),db.offlineMediaDao(),db.syncChangeLogDao(),db.syncPeerStateDao(),db.rssSourceSyncStateDao(),field("cacheService"),field("appScope"),field("fetchService"),field("readableService"),field("parseService"),field("offlineStore"),local,null)
    val repo=DefaultRssRepository::class.java.declaredConstructors.first{it.parameterTypes.size==16}.newInstance(*args) as DefaultRssRepository
    delegate.set(container,lazyOf(repo));assertSame(repo,container.rssRepository)
    if(c.optBoolean("seedArticle")){
     db.rssChannelDao().insertChannel(RssChannelEntity(1,"https://feed.example/rss","Feed",null,null,null,1,1,false))
     db.rssItemDao().insertItems(listOf(RssItemEntity(id=1,channelId=1,title="Saved",description="body",content="body",originalContent=null,link="https://example.com/session",guid="guid",pubDate=null,imageUrl=null,audioUrl=null,videoUrl=null,summary=null,previewImageUrl=null,isRead=false,isLiked=false,readingProgress=.2f,dedupKey="guid",fetchedAt=100,contentSizeBytes=4)))
     db.savedEntryDao().insert(SavedEntryEntity(itemId=1,saveType="FAVORITE",createdAt=100,sortOrder=100))
    }
    val window=repo.prepareLibrarySyncWindow("phone-test",local,0)
    val windowJson=LibrarySyncPayload.buildManifestResponseFromEntries(local,window.articleManifest,emptyList(),window.rssSources,0,LibraryChangeSequence(window.fromSeqExclusive,window.toSeqInclusive,window.fullSnapshot,window.fallbackReason))
    val beforeCursor=repo.getLibrarySyncCursor("phone-test")
    val exported=repo.exportSyncedSavedArticles(local);val prepared=A()
    for(article in exported){val frames=LibrarySyncPayload.buildChunkedResponseFrames(local,listOf(article),emptyList(),0,0,false);val item=frames.first().getJSONArray("articles").getJSONObject(0);val full=ArticleSyncBody.payloadForRequest(article,SyncedArticleBodyRequest(article.articleId,"",emptyList()));val b=ByteArrayOutputStream();full.chunks.forEach{b.write(it.bytes)};prepared.put(J().put("wireArticle",item).put("contentHtml",article.contentHtml?:J.NULL).put("contentText",article.contentText).put("encodedBase64",java.util.Base64.getEncoder().encodeToString(b.toByteArray())))}
    val inbound=A();fun add(j:J){inbound.put(j)}
    val goodAck=J().put("action","ack").put("success",true).put("phase","applied").put("applied",true)
    if(c.optBoolean("persistent")){add(J().put("version",14).put("action","syncLibrary").put("phase","probe").put("requestPersistentSession",true).put("supportsPersistentSession",true));add(goodAck)}
    if(c.optBoolean("cursor"))add(J().put("version",14).put("action","syncLibrary").put("phase","cursor").put("deviceId","phone-test"))
    val manifest=J().put("version",14).put("action","syncLibrary").put("phase","manifest").put("deviceId","phone-test").put("supportsChunkedBodies",true).put("supportsArticleBatches",true).put("supportsManifestBatches",true).put("supportsMetadataOnlyArticles",true).put("supportsChangeSequences",true).put("fullSnapshot",true).put("changeSeqRange",J().put("fromExclusive",0).put("toInclusive",71)).put("articleManifest",A()).put("rssSources",A())
    c.optString("libraryMode").takeIf{it.isNotBlank()}?.let{manifest.put("libraryMode",it)}
    add(manifest)
    val incoming=A();if(c.optBoolean("incomingArticle"))incoming.put(J().put("articleId","remote-only").put("url","https://phone.example/post").put("title","Phone article").put("body",J().put("bodyHash","hash").put("bodyByteCount",1).put("chunkSize",1).put("chunkHashes",A().put("chunk")).put("chunks",A().put(J().put("index",0).put("hash","chunk").put("data","AA==")))))
    val articleFrame=J().put("version",14).put("action","syncLibrary").put("phase",if(c.optBoolean("badArticlePhase"))"probe"else"articles").put("articles",incoming).put("bodyRequests",A().also{r->if(c.optBoolean("seedArticle"))r.put(J().put("articleId",exported.first().articleId).put("bodyHash","").put("chunkIndexes",A()).put("metadataOnly",false))})
    if(c.optBoolean("truncatedArticles"))articleFrame.put("batchIndex",0).put("batchCount",2)
    add(articleFrame);val acks=c.getJSONArray("ack");for(j in 0 until acks.length())add(acks.getJSONObject(j))
    if(c.optBoolean("persistent")){add(J().put("version",14).put("action","syncSession").put("phase","complete"));add(goodAck)}
    val bytes=ByteArrayOutputStream();for(j in 0 until inbound.length())BluetoothSyncProtocol.writeFrame(bytes,inbound.getJSONObject(j));val input=ByteArrayInputStream(bytes.toByteArray());val output=ByteArrayOutputStream();var closed=false;var actions=0
    val row=J().put("input",c).put("inbound",inbound).put("deviceId",local).put("preparedWindow",windowJson).put("preparedArticles",prepared).put("beforeCursor",J().put("localMaxSeq",beforeCursor.localMaxSeq).put("lastRemoteSeqApplied",beforeCursor.lastRemoteSeqApplied).put("lastLocalSeqAckedByPeer",beforeCursor.lastLocalSeqAckedByPeer))
    try{val result=WatchBluetoothSyncServer(inst.targetContext,onActionCompleted={actions++},responseAckTimeoutMs=50).serveStreams(input,output,"fixture","fixture",{closed=true},50);row.put("returned",true).put("response",result.response)}catch(e:Exception){row.put("returned",false).put("error",e.message)}
    val outFrames=A();val outInput=ByteArrayInputStream(output.toByteArray());while(outInput.available()>0)outFrames.put(BluetoothSyncProtocol.readFrame(outInput));row.put("outbound",outFrames).put("closedByServer",closed).put("unreadInputBytes",input.available()).put("completedActions",actions)
    val peer=db.syncPeerStateDao().get("phone-test");row.put("peer",if(peer==null)J.NULL else J().put("localSeq",peer.lastLocalSeqAckedByPeer).put("remoteSeq",peer.lastRemoteSeqApplied).put("protocol",peer.lastProtocolVersion).put("fullSync",peer.lastFullSyncAt>0))
    db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM rss_items").use{cursor->cursor.moveToFirst();row.put("itemCount",cursor.getLong(0))}
    cases.put(row)
   }finally{delegate.set(container,oldDelegate);db.close()}
  }
  File(inst.targetContext.getExternalFilesDir(null),"reference-library-session.json").writeText(J().put("cases",cases).put("sdk",android.os.Build.VERSION.SDK_INT).put("device",android.os.Build.MODEL).toString())
 }
}
