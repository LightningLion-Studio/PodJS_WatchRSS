#!/usr/bin/env python3
"""Run native byte-position functions unchanged, without a Compose UI dependency."""
from pathlib import Path
import hashlib,json,subprocess,tempfile
project=Path(__file__).resolve().parents[2];native=project.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/rss'
screen=(native/'DetailScreen.kt').read_text();support=(native/'DetailBehaviorSupport.kt').read_text()
utf8=screen[screen.index('private fun utf8ByteCount(text:'):screen.index('private const val DETAIL_CONTENT_START_ITEM_INDEX')]
start=support.index('internal data class ImportedTextByteRestoreTarget(');definition=support[start:support.index('\n\n',start)]
start=support.index('internal fun importedTextByteRestoreTarget(');target=support[start:support.index('\ninternal fun Modifier.',start)]
texts=['','A汉😀B','a\r\nb','中'*12,'\ufeff\u00a0é终','😀😀😀','e\u0301','𝄞末尾']
cases=[{'byteLength':size,'progress':progress,'chunkCount':max(1,(size+16383)//16384)} for size in [0,1,10,16384,50000,33554437] for progress in [0,.00001,.2,.5,.9999999,1,-.1,1.1]]
probe='''
fun main(args:Array<String>){
 val input=org.json.JSONObject(java.io.File(args[0]).readText());val strings=input.getJSONArray("texts");val textRows=org.json.JSONArray()
 for(i in 0 until strings.length()){val text=strings.getString(i);val before=org.json.JSONArray();val chars=org.json.JSONArray();for(n in -1..text.length+1)before.put(utf8ByteCountBeforeCharOffset(text,n));for(n in -1..utf8ByteCount(text)+1)chars.put(utf8CharOffsetForByteOffset(text,n));textRows.put(org.json.JSONObject().put("text",text).put("bytesFromMinusOne",before).put("charsFromMinusOne",chars))}
 val cases=input.getJSONArray("cases");val targets=org.json.JSONArray()
 for(i in 0 until cases.length()){val row=cases.getJSONObject(i);val value=importedTextByteRestoreTarget(row.getDouble("progress").toFloat(),7,row.getLong("byteLength"),row.getInt("chunkCount"),16384);targets.put(org.json.JSONObject().put("input",row).put("chunkIndex",value.chunkIndex).put("byteOffset",value.byteOffsetInChunk))}
 println(org.json.JSONObject().put("texts",textRows).put("targets",targets))
}
'''
cache=Path.home()/'.gradle/caches/modules-2/files-2.1';deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0'),('org.json','json','20240303')];cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
with tempfile.TemporaryDirectory(prefix='watchrss-imported-reader-') as folder:
 root=Path(folder);(root/'Probe.kt').write_text('import kotlin.math.roundToLong\n'+definition+'\n'+target+'\n'+utf8+'\n'+probe);(root/'input.json').write_text(json.dumps(dict(texts=texts,cases=cases),ensure_ascii=False))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',cp,'-d',folder,str(root/'Probe.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',folder+':'+cp,'ProbeKt',str(root/'input.json')],text=True))
(project/'tests/fixtures/imported-reader-native.json').write_text(json.dumps(dict(sources={str(p.relative_to(project.parent)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [native/'DetailScreen.kt',native/'DetailBehaviorSupport.kt']},**result),ensure_ascii=False,indent=2)+'\n')
print('Captured',len(result['texts']),'UTF-8 coordinate cases and',len(result['targets']),'byte restore targets')
