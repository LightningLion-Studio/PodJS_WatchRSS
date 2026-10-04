#!/usr/bin/env python3
"""Run verbatim native saved-state methods with in-memory DAO/media doubles.
This isolates merge decisions; it does not qualify Room, media or transport.
"""
from pathlib import Path
import hashlib,json,subprocess,tempfile
project=Path(__file__).resolve().parents[2]
source=project.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/rss/DefaultRssRepository.kt'
text=source.read_text()
methods=text[text.index('    private suspend fun applySyncedState('):text.index('    private suspend fun applySyncedArticleDeletion(')]
cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0'),('org.json','json','20240303')]
cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
base={'saved':True,'changedAt':100,'sortOrder':42,'sourceDeviceId':'phone'}
cases=[]
for current in [None,dict(base),dict(base,sourceDeviceId='😀'),dict(base,sourceDeviceId='\ue000')]:
 for saved,changed,device in [(False,0,'z'),(True,0,'z'),(False,99,'z'),(False,100,'a'),(False,100,'phone'),(False,100,'z'),(True,101,'a'),(False,100,'😀'),(False,100,'\ue000')]:
  for authoritative,tombstone in [(False,False),(True,False),(False,True),(True,True)]:
   cases.append({'current':current,'remote':{'saved':saved,'changedAt':changed,'sortOrder':73,'sourceDeviceId':device},'authoritative':authoritative,'tombstone':tombstone})
stubs=r'''
import org.json.JSONObject as J
import org.json.JSONArray as A
import kotlinx.coroutines.runBlocking
enum class SaveType { FAVORITE, WATCH_LATER }
data class SyncedSavedArticle(val articleId:String="a",val url:String="https://a",val favoriteSaved:Boolean,val favoriteChangedAt:Long,val favoriteSortOrder:Long,val watchLaterSaved:Boolean=false,val watchLaterChangedAt:Long=0,val watchLaterSortOrder:Long=0)
data class SavedSyncStateEntity(val articleId:String,val saveType:String,val itemId:Long?,val url:String,val saved:Boolean,val changedAt:Long,val sortOrder:Long,val sourceDeviceId:String)
data class SavedEntryEntity(val itemId:Long,val saveType:String,val createdAt:Long,val sortOrder:Long)
class StateDao {var state:SavedSyncStateEntity?=null;fun get(a:String,t:String)=state;fun upsert(s:SavedSyncStateEntity){state=s}}
class EntryDao {val entries=mutableListOf<SavedEntryEntity>();fun getByItemId(id:Long)=entries.filter{it.itemId==id};fun updateSortOrder(id:Long,t:String,sort:Long){val i=entries.indexOfFirst{it.itemId==id&&it.saveType==t};if(i>=0)entries[i]=entries[i].copy(sortOrder=sort)};fun insert(e:SavedEntryEntity){entries.add(e)};fun delete(id:Long,t:String){entries.removeAll{it.itemId==id&&it.saveType==t}};fun countByItemId(id:Long)=getByItemId(id).size}
class ItemDao {fun getItem(id:Long):Long?=id}
class OfflineStore {fun downloadMediaForItem(id:Long){};fun deleteMediaForItem(id:Long){}}
class Probe {
 val savedSyncStateDao=StateDao();val savedEntryDao=EntryDao();val itemDao=ItemDao();val offlineStore=OfflineStore()
 suspend fun call(a:SyncedSavedArticle,remote:String,authoritative:Boolean,tombstone:Boolean)=if(tombstone)applySyncedTombstoneState(a,SaveType.FAVORITE,remote,"local",authoritative) else applySyncedState(a,1,SaveType.FAVORITE,remote,"local",authoritative)
'''
main=r'''
}
fun state(j:J,item:Long?)=SavedSyncStateEntity("a","FAVORITE",item,"https://a",j.getBoolean("saved"),j.getLong("changedAt"),j.getLong("sortOrder"),j.getString("sourceDeviceId"))
fun main(args:Array<String>)=runBlocking {
 val input=A(java.io.File(args[0]).readText());val output=A()
 for(i in 0 until input.length()){
  val row=input.getJSONObject(i);val p=Probe();val tombstone=row.getBoolean("tombstone")
  if(!row.isNull("current")){val s=state(row.getJSONObject("current"),if(tombstone)null else 1);p.savedSyncStateDao.state=s;if(s.saved&&!tombstone)p.savedEntryDao.insert(SavedEntryEntity(1,"FAVORITE",s.changedAt,s.sortOrder))}
  val r=row.getJSONObject("remote");val a=SyncedSavedArticle(favoriteSaved=r.getBoolean("saved"),favoriteChangedAt=r.getLong("changedAt"),favoriteSortOrder=r.getLong("sortOrder"))
  val applied=p.call(a,r.getString("sourceDeviceId"),row.getBoolean("authoritative"),tombstone);val s=p.savedSyncStateDao.state
  row.put("applied",applied).put("expected",if(s==null)J.NULL else J().put("saved",s.saved).put("changedAt",s.changedAt).put("sortOrder",s.sortOrder).put("sourceDeviceId",s.sourceDeviceId).put("itemId",s.itemId?:J.NULL)).put("entrySaved",p.savedEntryDao.entries.isNotEmpty())
  output.put(row)
 }
 println(output)
}
'''
with tempfile.TemporaryDirectory(prefix='watchrss-saved-state-') as temp:
 root=Path(temp);(root/'Probe.kt').write_text(stubs+methods+main);(root/'input.json').write_text(json.dumps(cases,ensure_ascii=True))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',cp,'-d',temp,str(root/'Probe.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',temp+':'+cp,'ProbeKt',str(root/'input.json')],text=True))
fixture={'source':str(source.relative_to(project.parent)),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'extractedMethodsSha256':hashlib.sha256(methods.encode()).hexdigest(),'runtime':'Desktop JVM; verbatim native applySyncedState/applySyncedTombstoneState; DAO/media doubles, not Room or media validation.','cases':result}
path=project/'tests/fixtures/saved-state-native.json';path.write_text(json.dumps(fixture,ensure_ascii=True,indent=2)+'\n');print(f'Captured {len(result)} native saved-state cases: {path}')
