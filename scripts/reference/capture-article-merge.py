#!/usr/bin/env python3
"""Execute verbatim native upsert with DAO and file/metadata helper doubles.
Covers entity merge decisions, not codec, Room or external file publication.
"""
from pathlib import Path
import json,hashlib,subprocess,tempfile,re
p=Path(__file__).resolve().parents[2];root=p.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data'
source=root/'rss/DefaultRssRepository.kt';text=source.read_text();method=text[text.index('    private suspend fun upsertSyncedArticleItem('):text.index('    private suspend fun ensureSyncedArticleMetadata(')]
entity=(root/'db/RssItemEntity.kt').read_text();entity=entity[entity.index('data class RssItemEntity('):].replace('    @PrimaryKey(autoGenerate = true)\n','')
model=(root/'rss/SyncedSavedArticle.kt').read_text();model=model[model.index('data class SyncedSavedArticle('):model.index('data class SyncedSavedArticleMergeStats(')]
fields=dict(re.findall(r'val (\w+): ([\w?]+)',entity));names=re.findall(r'^            (\w+) =',method[method.index('itemDao.updateSyncedArticle('):],re.M)
params=', '.join(n+': '+fields[n] for n in names);copy=', '.join(n+'='+n for n in names)
cases=[]
for body in ['old body','changed body','']:
 for authoritative in [False,True]:
  for oldtime,newtime in [(100,99),(100,100),(100,101),(0,0)]:
   for progress in [.1,.7]:
    cases.append(dict(body=body,authoritative=authoritative,oldTime=oldtime,newTime=newtime,progress=progress))
stub=r'''
import kotlinx.coroutines.runBlocking
import org.json.JSONObject as J
import org.json.JSONArray as A
data class ArticleBodyMetadata(val bodyHash:String,val bodyByteCount:Long=20,val chunkSize:Int=131072,val chunkHashes:List<String> = listOf("chunk"),val metadataHash:String="metadata")
fun ArticleBodyMetadata.isCurrentFor(a:SyncedSavedArticle)=true
object ArticleSyncBody {fun metadataFor(a:SyncedSavedArticle)=a.cachedBodyMetadata!!}
fun List<String>.toJsonString()=J().put("a",this).getJSONArray("a").toString()
fun RssItemEntity.externalizeLargeContent()=this
fun estimateSyncedContentSize(t:String,e:String,c:String?,u:String,i:String?)=0L
fun syncedArticleFetchedAt(a:SyncedSavedArticle,fallbackNow:Long)=maxOf(a.updatedAt,a.importedAt).takeIf{it>0}?:fallbackNow
class ItemDao {
 var item:RssItemEntity?=null
 fun getItemByDedupKey(c:Long,k:String)=item
 fun insertItems(items:List<RssItemEntity>):List<Long>{item=items.first().copy(id=1);return listOf(1)}
 UPDATE
}
class Probe {val itemDao=ItemDao();suspend fun call(a:SyncedSavedArticle,b:Boolean)=upsertSyncedArticleItem(1,a,b)
'''.replace('UPDATE',f'fun updateSyncedArticle({params})'+'{item=item!!.copy('+copy+')}')
main=r'''
}
fun article(body:String,time:Long,progress:Float)=SyncedSavedArticle(articleId="one",sourceDeviceId="phone",url="https://article/a",title="Article",siteName="Site",excerpt="excerpt",contentHtml=null,contentText=body,imageUrl=null,contentHash="unused",importedAt=100,updatedAt=100,favoriteSaved=true,favoriteChangedAt=100,favoriteSortOrder=100,watchLaterSaved=false,watchLaterChangedAt=0,watchLaterSortOrder=0,deleted=false,deletedAt=0,readingProgress=progress,readingPositionBytes=9,readingPositionContentHash="incoming-position-hash",readingPositionChangedAt=time,isRead=false,cachedBodyMetadata=ArticleBodyMetadata(if(body=="old body")"old" else "new"))
fun main(args:Array<String>)=runBlocking {
 val input=A(java.io.File(args[0]).readText());val out=A()
 for(i in 0 until input.length()){
  val row=input.getJSONObject(i);val probe=Probe()
  probe.call(article("old body",row.getLong("oldTime"),.5f).copy(isRead=true,readingPositionBytes=4,readingPositionContentHash="old-position-hash"),false)
  probe.call(article(row.getString("body"),row.getLong("newTime"),row.getDouble("progress").toFloat()),row.getBoolean("authoritative"))
  val e=probe.itemDao.item!!;row.put("expected",J().put("content",e.content).put("originalContent",e.originalContent).put("bodyHash",e.syncBodyHash).put("progress",e.readingProgress.toDouble()).put("positionBytes",e.readingPositionBytes).put("positionHash",e.readingPositionContentHash).put("changedAt",e.readingPositionChangedAt).put("isRead",e.isRead));out.put(row)
 }
 println(out)
}
'''
cache=Path.home()/'.gradle/caches/modules-2/files-2.1';deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0'),('org.json','json','20240303')];cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
with tempfile.TemporaryDirectory(prefix='watchrss-article-merge-') as tmp:
 d=Path(tmp);(d/'Probe.kt').write_text(stub+method+main);(d/'Models.kt').write_text(entity+'\n'+model);(d/'in.json').write_text(json.dumps(cases))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',cp,'-d',tmp,str(d/'Probe.kt'),str(d/'Models.kt')],check=True)
 rows=json.loads(subprocess.check_output(['java','-cp',tmp+':'+cp,'ProbeKt',str(d/'in.json')],text=True))
result={'source':str(source.relative_to(p.parent)),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'methodSha256':hashlib.sha256(method.encode()).hexdigest(),'scope':'Verbatim native upsert method, native data classes with Room annotation removed; DAO, externalization, metadata calculation and size helpers doubled. Entity merge decisions only.','cases':rows}
(p/'tests/fixtures/article-merge-native.json').write_text(json.dumps(result,indent=2)+'\n');print(f'Captured {len(rows)} native article merge cases')
