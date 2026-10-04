#!/usr/bin/env python3
"""Run the unchanged native file store against UTF-8 boundary and marker fixtures."""
from pathlib import Path
import hashlib,json,subprocess,tempfile
project=Path(__file__).resolve().parents[2]
native=project.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/rss/ArticleContentStore.kt'
cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0'),('org.json','json','20240303')]
classpath=':'.join(str(next((cache/group/name/version).glob('*/*.jar'))) for group,name,version in deps)+':'+str(Path.home()/'Android/Sdk/platforms/android-36/android.jar')
texts=['','a','汉字😀é终','a\r\nb\t c','a'*16383+'😀汉字尾','中'*5461+'汉'+'é'*30,'😀'*4097]
cases=[{'text':text,'chunkBytes':size} for text in texts for size in ([1,2,3,4,5,16,16384] if len(text)<100 else [16384])]
markers=[None,'','watchrss-watch-content:a.txt','watchrss-watch-content:../a.txt','watchrss-watch-content:a..b.txt','watchrss-watch-content:a.txt\n','watchrss-watch-content:.txt','watchrss-watch-content:a/b.txt','watchrss-watch-content:汉.txt','watchrss-watch-content:'+'a'*96+'.txt','watchrss-watch-content:'+'a'*97+'.txt','watchrss-watch-content:v2-'+'a'*64+'-'+'b'*64+'.txt']
writer_cases=[{'key':key,'text':text} for key,text in [
 ('same-key','first'),('same-key','second'),('same-key','second'),('../../汉😀','汉😀导入正文。'),
 ('', ''),('bad\ud800key','A\ud800B\udc00C'),('a'*32767+'😀','中'*32767+'😀尾'),('large','汉😀'*30000)
]]
probe='''package com.lightningstudio.watchrss.data.rss
fun main(args:Array<String>) {
 val root=java.io.File(args[0]);val input=org.json.JSONObject(java.io.File(args[1]).readText());val output=org.json.JSONArray()
 val store=FileArticleContentStore(root)
 val rows=input.getJSONArray("cases")
 for(i in 0 until rows.length()) {
  val row=rows.getJSONObject(i);val text=row.getString("text");val size=row.getInt("chunkBytes");val marker=store.storeText("case-$i",text)
  val handle=store.textChunkHandle(marker,size)!!;val chunks=org.json.JSONArray()
  for(index in -1..handle.chunkCount) chunks.put(store.loadTextChunk(marker,index,size)?:org.json.JSONObject.NULL)
  output.put(org.json.JSONObject().put("text",text).put("chunkBytes",size).put("byteLength",handle.byteLength).put("chunkCount",handle.chunkCount).put("marker",marker).put("chunksFromMinusOne",chunks))
 }
 val resultMarkers=org.json.JSONArray();val values=input.getJSONArray("markers")
 for(i in 0 until values.length()){val value=if(values.isNull(i))null else values.getString(i);resultMarkers.put(org.json.JSONObject().put("value",value?:org.json.JSONObject.NULL).put("valid",isArticleContentMarker(value)))}
 val writes=org.json.JSONArray();val writeRows=input.getJSONArray("writerCases")
 for(i in 0 until writeRows.length()){
  val row=writeRows.getJSONObject(i);val marker=store.storeText(row.getString("key"),row.getString("text"))
  val bytes=java.io.File(root,marker.removePrefix(ARTICLE_CONTENT_MARKER_PREFIX)).readBytes()
  writes.put(org.json.JSONObject().put("key",row.getString("key")).put("text",row.getString("text")).put("marker",marker).put("dataBase64",java.util.Base64.getEncoder().encodeToString(bytes)))
 }
 println(org.json.JSONObject().put("cases",output).put("markers",resultMarkers).put("writerCases",writes))
}
'''
with tempfile.TemporaryDirectory(prefix='watchrss-imported-reference-') as temp:
 root=Path(temp);(root/'content').mkdir();(root/'ImportedTextProbe.kt').write_text(probe);(root/'input.json').write_text(json.dumps({'cases':cases,'markers':markers,'writerCases':writer_cases},ensure_ascii=True))
 subprocess.run(['java','-cp',classpath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',classpath,'-d',temp,str(native),str(root/'ImportedTextProbe.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',temp+':'+classpath,'com.lightningstudio.watchrss.data.rss.ImportedTextProbeKt',str(root/'content'),str(root/'input.json')],text=True))
# Preserve original UTF-16 test input: Java stdout replaces lone surrogates,
# while the captured file bytes and marker remain the independent native result.
for row,original in zip(result['writerCases'],writer_cases):
 row['key']=original['key'];row['text']=original['text']
fixture=project/'tests/fixtures/imported-text-native.json';fixture.write_text(json.dumps({'source':str(native.relative_to(project.parent)),'sha256':hashlib.sha256(native.read_bytes()).hexdigest(),**result},ensure_ascii=True,indent=2)+'\n')
print(f'Captured {len(result["cases"])} file cases and {len(result["markers"])} marker cases and {len(result["writerCases"])} writer cases: {fixture}')
