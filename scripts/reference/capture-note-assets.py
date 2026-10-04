#!/usr/bin/env python3
"""Run unchanged native note asset receiver on an isolated desktop file directory."""
from pathlib import Path
import hashlib,json,subprocess,tempfile
project=Path(__file__).resolve().parents[2];native=project.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/phoneconnection/bluetooth/WatchNoteAssetSyncPayload.kt';cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0'),('org.json','json','20240303')]
cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)+':'+str(Path.home()/'Android/Sdk/platforms/android-36/android.jar')
sha=lambda b:hashlib.sha256(b).hexdigest();N=512*1024
base=lambda n=3,**extra:dict(version=1,storageKey='test.png',sha256=sha(b'A'*n),chunkIndex=0,chunkCount=1,dataLength=n,dataByte=65,**extra)
cases=[{'name':'single-and-reuse','steps':[base(),dict(base(),data='not base64')]},{'name':'empty','steps':[base(0)]},{'name':'two-chunks','steps':[dict(base(N+5),dataLength=N,chunkCount=2),dict(base(N+5),dataLength=5,chunkIndex=1,chunkCount=2)]},{'name':'short-intermediate','steps':[dict(base(8),chunkCount=2),dict(base(8),chunkIndex=1,chunkCount=2,dataLength=5)]},{'name':'bad-hash-preserves-target','steps':[base(),dict(base(4),sha256=sha(b'B'*4))]},{'name':'restart-first','steps':[dict(base(N+5),chunkCount=2,dataLength=N),base()]},{'name':'rejected-inputs','steps':[dict(base(),version=2),dict(base(),storageKey='../escape'),dict(base(),storageKey='.'),dict(base(),sha256='bad'),dict(base(),chunkIndex=1),dict(base(),chunkCount=0),dict(base(),data='!'),base(N+1)]}]
cases.append({'name':'trailing-line-breaks','steps':[dict(base(),storageKey='a\n'),dict(base(),sha256=sha(b'A'*3)+'\n'),dict(base(),data='QUFB\n')]})
probe='''package com.lightningstudio.watchrss.phoneconnection.bluetooth
import java.io.File
import java.security.MessageDigest
import org.json.JSONObject
import org.json.JSONArray
fun hash(b:ByteArray)=MessageDigest.getInstance("SHA-256").digest(b).joinToString(""){"%02x".format(it)}
fun main(args:Array<String>){val input=JSONArray(File(args[0]).readText());val out=JSONArray();for(i in 0 until input.length()){val c=input.getJSONObject(i);val root=File(args[1],i.toString()).also{it.mkdirs()};val steps=c.getJSONArray("steps");val results=JSONArray();for(k in 0 until steps.length()){val spec=steps.getJSONObject(k);val request=JSONObject(spec.toString());if(!request.has("data"))request.put("data",java.util.Base64.getEncoder().encodeToString(ByteArray(request.getInt("dataLength")){request.getInt("dataByte").toByte()}));val result=JSONObject();try{result.put("response",WatchNoteAssetSyncPayload.apply(root,request))}catch(e:Exception){result.put("error",e.message)};val files=JSONObject();root.walkTopDown().filter{it.isFile}.forEach{files.put(it.relativeTo(root).path,JSONObject().put("size",it.length()).put("sha256",hash(it.readBytes())))};result.put("files",files);results.put(result)};out.put(JSONObject().put("name",c.getString("name")).put("steps",steps).put("results",results))};println(out)}
'''
with tempfile.TemporaryDirectory(prefix='watchrss-note-assets-') as temp:
 root=Path(temp);(root/'Probe.kt').write_text(probe);(root/'input.json').write_text(json.dumps(cases))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',cp,'-d',temp,str(native),str(root/'Probe.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',temp+':'+cp,'com.lightningstudio.watchrss.phoneconnection.bluetooth.ProbeKt',str(root/'input.json'),str(root/'files')],text=True))
path=project/'tests/fixtures/note-assets-native.json';path.write_text(json.dumps({'source':str(native.relative_to(project.parent)),'sourceSha256':sha(native.read_bytes()),'runtime':'Unchanged native receiver on desktop JVM with real files; not Android Bluetooth/UI.','cases':result},indent=2)+'\n');print('Captured',sum(len(c['steps']) for c in result),'native asset steps')
