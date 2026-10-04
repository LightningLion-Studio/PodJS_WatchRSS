#!/usr/bin/env python3
"""Execute unchanged native ArticleSyncBody for encoded bodies and malformed JSON."""
from pathlib import Path
import json,hashlib,subprocess,tempfile,base64,random
project=Path(__file__).resolve().parents[2]
native=project.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/rss'
cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0'),('org.json','json','20240303')]
cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
rng=random.Random(7325)
cases=[{'contentHtml':h,'contentText':t} for h,t in [(None,''),(None,'汉😀导入正文。 👩‍💻 🇨🇳 👍🏽'),('<p>汉/字 &amp;😀</p>','汉/字 &😀'),('', 'quote" back\\ slash/\n\t\b\f\r'+chr(1)),(None,'x\ud800y\udc00z'),(None,'a'*16383+'😀'+'中'*16385),(None,''.join(chr(32+rng.randrange(90)) for _ in range(260000)))]]
cases.append({'contentHtml':None,'contentText':cases[-1]['contentText'][:-1]+'改'})
json_cases=['{"contentText":"正文"}','{"contentText":null,"contentHtml":null}','{"contentText":"a","contentText":"b"}','{"contentHtml":"a","contentHtml":null,"contentText":"b"}','{}','{"contentText":12}','{"contentText":false}','{"contentText":[]}','{"contentText":{}}','{"contentText":"a"}false','{"contentText":"a",}','{"contentText":"a","x":[1,true,null,{"z":"v"}]}','{"contentText":"a","x":[1,]}','{"contentText":"a","x":01}','{"contentText":"a","x":1e+2}','{"contentText":"a","x":1.}','{"contentText":"a","x":"\\q"}','{"contentText":"a","x":"\\u00GG"}','{"contentText":"a","x":"\\ud800"}','{"contentText":"a","x":'+ '['*129+'0'+']'*129+'}','{"contentText":"a","x":'+ '['*128+'0'+']'*128+'}','\u00a0{"contentText":"a"}\u00a0','\ufeff{"contentText":"a"}']
probe=r'''package com.lightningstudio.watchrss.data.rss
fun article(index:Int,h:String?,t:String)=SyncedSavedArticle("case-$index","phone","https://watchrss.local/import-content/txt/$index","Test","Local","",h,t,null,"",0,0,favoriteSaved=false,favoriteChangedAt=0,favoriteSortOrder=0,watchLaterSaved=false,watchLaterChangedAt=0,watchLaterSortOrder=0,deleted=false,deletedAt=0)
fun hash(b:ByteArray)=java.security.MessageDigest.getInstance("SHA-256").digest(b).joinToString(""){"%02x".format(it)}
fun main(args:Array<String>){
 val input=org.json.JSONObject(java.io.File(args[0]).readText());val rows=input.getJSONArray("cases");val results=org.json.JSONArray()
 for(i in 0 until rows.length()){
  val row=rows.getJSONObject(i);val a=article(i,if(row.isNull("contentHtml"))null else row.getString("contentHtml"),row.getString("contentText"))
  val p=ArticleSyncBody.payloadForRequest(a,SyncedArticleBodyRequest(a.articleId,"",emptyList()))
  val out=java.io.ByteArrayOutputStream();p.chunks.forEach{out.write(it.bytes)};val bytes=out.toByteArray()
  val payload=SyncedChunkedArticle(a,p.metadata.bodyHash,p.metadata.bodyByteCount,p.metadata.chunkSize,p.metadata.chunkHashes,p.chunks)
  val rebuilt=ArticleSyncBody.rebuildBody(null,payload,"")
  results.put(org.json.JSONObject().put("bodyHash",p.metadata.bodyHash).put("bodyByteCount",p.metadata.bodyByteCount).put("chunkSize",p.metadata.chunkSize).put("chunkHashes",p.metadata.chunkHashes).put("encodedBase64",java.util.Base64.getEncoder().encodeToString(bytes)).put("jsonBase64",java.util.Base64.getEncoder().encodeToString(java.util.zip.GZIPInputStream(java.io.ByteArrayInputStream(bytes)).readBytes())).put("decoded",org.json.JSONObject().put("contentHtml",rebuilt.first?:org.json.JSONObject.NULL).put("contentText",rebuilt.second)))
 }
 val parsers=org.json.JSONArray();val texts=input.getJSONArray("jsonCases")
 for(i in 0 until texts.length()){
  val text=texts.getString(i);val b=text.toByteArray(Charsets.UTF_8);val a=article(i,null,"");val h=hash(b)
  val payload=SyncedChunkedArticle(a,h,b.size.toLong(),maxOf(1,b.size),listOf(h),listOf(SyncedArticleBodyChunk(0,h,b)))
  val result=org.json.JSONObject().put("text",text)
  try{val rebuilt=ArticleSyncBody.rebuildBody(null,payload,"");result.put("ok",true).put("body",org.json.JSONObject().put("contentHtml",rebuilt.first?:org.json.JSONObject.NULL).put("contentText",rebuilt.second))}
  catch(e:Exception){result.put("ok",false).put("error",e.message)}
  parsers.put(result)
 }
 println(org.json.JSONObject().put("cases",results).put("jsonCases",parsers))
}
'''
with tempfile.TemporaryDirectory(prefix='watchrss-sync-body-') as temp:
 root=Path(temp);(root/'Probe.kt').write_text(probe);(root/'input.json').write_text(json.dumps({'cases':cases,'jsonCases':json_cases},ensure_ascii=True))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',cp,'-d',temp,str(native/'ArticleSyncBody.kt'),str(native/'SyncedSavedArticle.kt'),str(root/'Probe.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',temp+':'+cp,'com.lightningstudio.watchrss.data.rss.ProbeKt',str(root/'input.json')],text=True))
for row,original in zip(result['cases'],cases):row['input']=original
result['sources']={str((native/f).relative_to(project.parent)):hashlib.sha256((native/f).read_bytes()).hexdigest() for f in ['ArticleSyncBody.kt','SyncedSavedArticle.kt']}
result['runtime']='Desktop JVM using unchanged native sources; device gzip identity is checked separately.'
path=project/'tests/fixtures/sync-body-native.json';path.write_text(json.dumps(result,ensure_ascii=True,indent=2)+'\n')
print(f'Captured {len(cases)} body and {len(json_cases)} parser cases into {path}')
print('Gzip header:',base64.b64decode(result['cases'][0]['encodedBase64'])[:10].hex())
