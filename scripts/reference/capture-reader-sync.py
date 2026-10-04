#!/usr/bin/env python3
"""Execute native wire parsing, resource transfer and conflict predicates on JVM."""
from pathlib import Path
import hashlib,json,re,subprocess,tempfile
root=Path(__file__).resolve().parents[2];native=root.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss';android=Path('/home/wilf/Android/Sdk/sources/android-36/org/json')
paths=[native/'phoneconnection/bluetooth/ReaderPresetSyncPayload.kt',native/'data/reader/ReaderResourceStore.kt',native/'data/reader/ReaderPresetEntities.kt',native/'data/reader/ReaderPresetRepository.kt']
entity=paths[2].read_text();models='\n'.join(re.findall(r'data class Reader(?:PresetEntity|FontAssetEntity|BackgroundAssetEntity|DeletionEntity)\([\s\S]*?\n\)',entity)).replace('@androidx.room.PrimaryKey ','')
repo=paths[3].read_text();models+='\n'+repo[repo.index('data class ReaderPresetSnapshot('):repo.index('\nfun ReaderPreset.toEntity')]
wins=repo[repo.index('private fun ReaderPresetEntity.winsOver'):repo.index('private fun ReaderBackgroundAssetEntity.watchVariant')].replace('private fun','fun')
cache=Path.home()/'.gradle/caches/modules-2/files-2.1';deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0')];cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
probe=r'''
import com.lightningstudio.watchrss.data.reader.*
import com.lightningstudio.watchrss.phoneconnection.bluetooth.ReaderPresetSyncPayload as Wire
import org.json.*
import java.io.File
import java.security.MessageDigest
import java.util.Base64
fun hash(b:ByteArray)=MessageDigest.getInstance("SHA-256").digest(b).joinToString(""){"%02x".format(it)}
fun main(args:Array<String>)=kotlinx.coroutines.runBlocking {
 val out=JSONObject();val parsing=JSONArray()
 val p=JSONObject().put("id","p").put("name","p").put("payloadJson","{}").put("updatedAt",1).put("modifiedBy","a").put("deleted",false)
 for(raw in listOf("{}",JSONObject().put("presets",JSONArray().put(JSONObject.NULL).put("ignored").put(p)).toString(),JSONObject().put("presets",JSONArray().put(p).put(JSONObject().put("id","bad"))).toString(),JSONObject().put("presets",JSONArray().put(JSONObject(p.toString()).put("name",JSONObject.NULL).put("deleted","TRUE").put("updatedAt","3.9"))).toString())) {
  val r=JSONObject().put("raw",raw);try{val j=JSONObject(raw);val snapshot=ReaderPresetSnapshot(Wire.parsePresets(j.optJSONArray("presets")),Wire.parseFonts(j.optJSONArray("fonts")),Wire.parseBackgrounds(j.optJSONArray("backgrounds")),Wire.parseDeletions(j.optJSONArray("deletions")));r.put("expected",Wire.snapshotJson(snapshot))}catch(e:Exception){r.put("error",true)};parsing.put(r)
 };out.put("parsing",parsing)
 val conflicts=JSONArray();for(lt in listOf(1L,2L))for(rt in listOf(1L,2L))for(ld in listOf(false,true))for(rd in listOf(false,true))for(lm in listOf("a","z"))for(rm in listOf("a","z")){val l=ReaderPresetEntity("p","p","{}",lt,lm,ld);val r=ReaderPresetEntity("p","p","{}",rt,rm,rd);conflicts.put(JSONObject().put("local",JSONObject().put("updatedAt",lt).put("deleted",ld).put("modifiedBy",lm)).put("incoming",JSONObject().put("updatedAt",rt).put("deleted",rd).put("modifiedBy",rm)).put("wins",r.winsOver(l)))};out.put("conflicts",conflicts)
 val repository=ReaderPresetRepository(ReaderResourceStore(android.content.Context(File(args[0]))));val traces=JSONArray();val data=ByteArray(1024*1024+7){3}
 fun request(index:Int)=JSONObject().put("phase","pushResource").put("kind","font").put("fileName","font.ttf").put("sha256",hash(data)).put("totalBytes",data.size).put("chunkIndex",index).put("chunkCount",2).put("data",Base64.getEncoder().encodeToString(data.copyOfRange(index*1024*1024,minOf(data.size,(index+1)*1024*1024)))).put("chunkSha256",hash(data.copyOfRange(index*1024*1024,minOf(data.size,(index+1)*1024*1024))))
 for(index in listOf(1,0,0,1,1)){val trace=JSONObject().put("index",index);try{trace.put("response",Wire.handle(request(index),repository))}catch(e:Exception){trace.put("error",e.message)};val target=repository.resourceStore.fontFile("font.ttf");if(target!=null)trace.put("targetHash",hash(target.readBytes()));traces.put(trace)};out.put("transfer",traces)
 val response=Wire.handle(JSONObject().put("phase","pullResource").put("kind","font").put("fileName","font.ttf").put("chunkIndex",1),repository);out.put("pullLast",response)
 println(out)
}
'''
with tempfile.TemporaryDirectory(prefix='reader-sync-native-') as tmp:
 d=Path(tmp);java=[]
 for p in android.glob('*.java'):
  s=re.sub(r'^import (?:static )?(?:android|libcore)\.[^;]+;','',p.read_text(),flags=re.M);s=re.sub(r'@(?:UnsupportedAppUsage|SystemApi)(?:\([^)]*\))?','',s);s=re.sub(r'@(?:NonNull|Nullable)\b','',s);q=d/p.name;q.write_text(s);java.append(str(q))
 subprocess.run(['javac','-d',tmp,*java],check=True)
 sources={'Wire.kt':paths[0].read_text(),'Resource.kt':paths[1].read_text(),'Models.kt':'package com.lightningstudio.watchrss.data.reader\n'+models+'\n'+wins,'Context.kt':'package android.content\nclass Context(val filesDir:java.io.File){val applicationContext:Context get()=this}\n','Protocol.kt':'package com.lightningstudio.watchrss.phoneconnection.bluetooth\nobject BluetoothSyncProtocol {const val ACTION_SYNC_READER="syncReader"}\n','Repository.kt':'package com.lightningstudio.watchrss.data.reader\nclass ReaderPresetRepository(val resourceStore:ReaderResourceStore){suspend fun mergeRemote(presets:List<ReaderPresetEntity>,fonts:List<ReaderFontAssetEntity>,backgrounds:List<ReaderBackgroundAssetEntity>,deletions:List<ReaderDeletionEntity>){error("Manifest repository not part of this oracle")};suspend fun exportSnapshot():ReaderPresetSnapshot=error("Not exercised")}','Probe.kt':probe}
 for name,s in sources.items():(d/name).write_text(s)
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',tmp+':'+cp,'-d',tmp,*[str(d/n) for n in sources]],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',tmp+':'+cp,'ProbeKt',str(d/'files')],text=True))
result['sourceHashes']={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths};result['runtime']='Desktop JVM: verbatim native wire/resource methods and winsOver; model declarations extracted; Android Context replaced with temporary filesDir; database merge not exercised.'
(root/'tests/fixtures/reader-sync-native.json').write_text(json.dumps(result,indent=2)+'\n');print('Captured',len(result['parsing']),'parsers',len(result['conflicts']),'conflicts',len(result['transfer']),'transfer steps')
