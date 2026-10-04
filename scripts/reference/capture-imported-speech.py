#!/usr/bin/env python3
"""Execute the unchanged native imported source with an in-memory repository."""
import hashlib,json,subprocess,tempfile
from pathlib import Path
project=Path(__file__).resolve().parents[2]
native=project.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/tts/ReadAloudController.kt'
segmenter=native.with_name('ReadAloudTextSegmenter.kt')
source=native.read_text(); start=source.index('    private class ImportedTextSegmentSource('); end=source.index('\n}\n',start)
source_class=source[start:end]
slices=source[source.index('private data class ReadAloudSegmentSlice('):source.index('private fun skipLeadingWhitespace(')]
normalize=segmenter.read_text(); normalize=normalize[normalize.index('    fun normalizePlainText('):normalize.index('\n    fun segment(')]
cases=[]
for title,chunks in [(' 标题\t 测试 ',[' 前\t后。','',None,'汉😀字']),('题'*500,['x'*510,'\u00a0\u001c','末尾']),('\u00a0 a\u2007b \u00a0',['a\r\nb','tail']),('',[]),('Title?',[None,'\u2007','body'])]:
 for chunk in [None,-1,0,1,len(chunks),len(chunks)+2]:
  for offset in [0,2,999]:cases.append(dict(title=title,chunks=chunks,chunk=chunk,offset=offset))
probe='''
import kotlinx.coroutines.runBlocking
private const val READ_ALOUD_TTS_SEGMENT_MAX_CHARS = 240
private val READ_ALOUD_SEGMENT_ENDINGS = setOf('。', '！', '？', '!', '?', ';', '；', '.', ':', '：')
private data class RssItem(val title:String)
private data class ImportedTextReader(val marker:String,val chunkCount:Int)
private interface RssRepository { suspend fun loadImportedTextChunk(marker:String,index:Int):String? }
private data class ReadAloudSegment(val text:String,val importedChunkIndex:Int?=null,val sourceOffsets:IntArray)
private interface ReadAloudTextSegmentSource { val segmentCount:Int; suspend fun next():ReadAloudSegment? }
private object ReadAloudTextSegmenter { NORMALIZE }
private object Controller {
CLASS
 suspend fun capture(input:org.json.JSONObject):org.json.JSONObject {
  val chunks=input.getJSONArray("chunks");val reads=org.json.JSONArray()
  val repository=object:RssRepository { override suspend fun loadImportedTextChunk(marker:String,index:Int):String? { reads.put(index);return if(chunks.isNull(index))null else chunks.getString(index) } }
  val stream=ImportedTextSegmentSource(RssItem(input.getString("title")),ImportedTextReader("marker",chunks.length()),repository,if(input.isNull("chunk"))null else input.getInt("chunk"),input.getInt("offset"))
  val segments=org.json.JSONArray()
  while(true) {val s=stream.next()?:break;val row=org.json.JSONObject().put("text",s.text).put("sourceOffsets",org.json.JSONArray(s.sourceOffsets.toList())).put("isTitle",false);if(s.importedChunkIndex!=null)row.put("importedChunkIndex",s.importedChunkIndex);segments.put(row)}
  return org.json.JSONObject().put("input",input).put("segments",segments).put("reads",reads).put("segmentCount",stream.segmentCount)
 }
}
fun main(args:Array<String>)=runBlocking {val input=org.json.JSONArray(java.io.File(args[0]).readText());val out=org.json.JSONArray();for(i in 0 until input.length())out.put(Controller.capture(input.getJSONObject(i)));println(out)}
'''.replace('NORMALIZE',normalize).replace('CLASS',source_class)+slices
cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0'),('org.json','json','20240303')]
cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
with tempfile.TemporaryDirectory(prefix='watchrss-imported-speech-') as folder:
 root=Path(folder);(root/'Probe.kt').write_text(probe);(root/'input.json').write_text(json.dumps(cases,ensure_ascii=False))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',cp,'-d',folder,str(root/'Probe.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',folder+':'+cp,'ProbeKt',str(root/'input.json')],text=True))
fixture=project/'tests/fixtures/imported-speech-native.json'
fixture.write_text(json.dumps(dict(source=str(native.relative_to(project.parent)),sha256=hashlib.sha256(native.read_bytes()).hexdigest(),classSha256=hashlib.sha256(source_class.encode()).hexdigest(),normalizeSha256=hashlib.sha256(normalize.encode()).hexdigest(),cases=result),ensure_ascii=False,indent=2)+'\n')
print(f'Captured {len(result)} native imported speech cases')
