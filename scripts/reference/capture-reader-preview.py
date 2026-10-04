#!/usr/bin/env python3
"""Exercise the unmodified native preview payload and session on desktop JVM."""
from pathlib import Path
import hashlib,json,re,subprocess,tempfile
root=Path(__file__).resolve().parents[2];native=root.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss';android=Path('/home/wilf/Android/Sdk/sources/android-36/org/json')
paths=[native/'data/reader/ReaderPresetModels.kt',native/'data/reader/WatchReaderPresetPreviewSession.kt',native/'phoneconnection/bluetooth/ReaderPresetPreviewPayload.kt']
base=json.loads(subprocess.check_output(['bun','-e',"import {defaultReaderPreset} from './src/reader/preset.ts';process.stdout.write(JSON.stringify(defaultReaderPreset('p','base')));"],cwd=root,text=True))
requests=[{'phase':'heartbeat','sequence':1},{'phase':'update','sequence':1,'preset':base},{'phase':'update','sequence':1,'changes':{'name':'stale'}},{'phase':'update','sequence':2,'changes':{'name':' renamed ','body':{**base['body'],'fontSizeSp':22}}},{'phase':'update','sequence':3,'changes':{}},{'phase':'heartbeat','sequence':7},{'phase':'update','sequence':8,'changes':{'body':None}},{'phase':'update','sequence':8,'changes':{'name':'failed-sequence-retry'}},{'phase':'heartbeat','sequence':0},{'phase':'stop','sessionId':'other'},{'phase':'resourceHandoff','sequence':9,'presetJson':json.dumps(base)},{'phase':'stop'},{'phase':'update','sequence':10,'changes':{'name':'missing-baseline'}}]
requests=[{'version':2,'sessionId':' s ',**r} for r in requests]
cache=Path.home()/'.gradle/caches/modules-2/files-2.1';deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0')];cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
probe=r'''
import com.lightningstudio.watchrss.data.reader.*
import com.lightningstudio.watchrss.phoneconnection.bluetooth.ReaderPresetPreviewPayload as Wire
import kotlinx.coroutines.*
import org.json.*
fun snapshot(s:WatchReaderPresetPreviewSession):Any {val state=s.state.value?:return JSONObject.NULL;return JSONObject().put("sessionId",state.sessionId).put("sequence",state.sequence).put("name",state.preset.name).put("fontSizeSp",state.preset.body.fontSizeSp.toDouble()).put("resourceTransferInProgress",state.resourceTransferInProgress)}
fun main(args:Array<String>)=runBlocking {
 val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined);val s=WatchReaderPresetPreviewSession(scope,10000,0);val input=JSONArray(java.io.File(args[0]).readText());val cases=JSONArray()
 for(i in 0 until input.length()){val request=input.getJSONObject(i);val row=JSONObject().put("request",request);try{row.put("response",Wire.handle(request,s))}catch(e:Exception){row.put("error",true)};row.put("state",snapshot(s));cases.put(row)}
 val base=ReaderPreset.darkDefault("p","base");val c=WatchReaderPresetPreviewSession(scope,5000,1000);c.update("c",0,base);c.updateDelta("c",1,JSONObject().put("name","one"));c.updateDelta("c",2,JSONObject().put("name","two"));val before=snapshot(c);delay(1100);val after=snapshot(c);check(c.state.value?.sequence==2L);check(c.state.value?.preset?.name=="two")
 val exp=WatchReaderPresetPreviewSession(scope,80,0);exp.update("expires",0,base);delay(120);check(exp.state.value==null)
 println(JSONObject().put("cases",cases).put("coalescingBefore",before).put("coalescingAfter",after).put("timeoutExpired",true));scope.cancel()
}
'''
with tempfile.TemporaryDirectory(prefix='reader-preview-native-') as tmp:
 d=Path(tmp);java=[]
 for p in android.glob('*.java'):
  s=re.sub(r'^import (?:static )?(?:android|libcore)\.[^;]+;','',p.read_text(),flags=re.M);s=re.sub(r'@(?:UnsupportedAppUsage|SystemApi)(?:\([^)]*\))?','',s);s=re.sub(r'@(?:NonNull|Nullable)\b','',s);q=d/p.name;q.write_text(s);java.append(str(q))
 subprocess.run(['javac','-d',tmp,*java],check=True);(d/'Probe.kt').write_text(probe);(d/'Protocol.kt').write_text('package com.lightningstudio.watchrss.phoneconnection.bluetooth\nobject BluetoothSyncProtocol{const val ACTION_PREVIEW_READER="previewReader"}\n');(d/'input.json').write_text(json.dumps(requests))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',tmp+':'+cp,'-d',tmp,*map(str,paths),str(d/'Probe.kt'),str(d/'Protocol.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',tmp+':'+cp,'ProbeKt',str(d/'input.json')],text=True))
result['sourceHashes']={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths};result['runtime']='Desktop JVM with unmodified native preview session/payload/models and Android JSON. Wire cases disable coalescing; separate coalescing test uses 1000 ms and expiry test uses 80 ms. Not device/UI validation.'
(root/'tests/fixtures/reader-preview-native.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print('Captured',len(result['cases']),'wire steps; native coalescing and expiry passed')
