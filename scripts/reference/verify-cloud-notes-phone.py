#!/usr/bin/env python3
"""Execute the unchanged phone codecs and NoteRepository on the desktop JVM.

Room annotations are inert stubs. The DAO is an in-memory test double; parsing,
export, Markdown hashing, three-way merge and conflict decisions are phone code.
Usage: verify-cloud-notes-phone.py input.json output.json [phone checkout]
Run under the caller's flock/capmem (including when invoked by Bun tests).
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

phone = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).resolve().parents[3] / 'Android_WatchRSS_Phone.wt-v2'
native = phone / 'app/src/main/java/com/lightningstudio/watchrss/phone/data/note'
names = ['NoteEntities.kt', 'NoteDao.kt', 'NoteRepository.kt', 'NoteCloudStateCodec.kt', 'MarkdownNoteCodec.kt', 'MarkdownThreeWayMerge.kt', 'MarkdownNoteArchive.kt']
cache = Path.home() / '.gradle/caches/modules-2/files-2.1'
deps = [('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.2.21'), ('org.jetbrains.kotlin', 'kotlin-stdlib', '2.2.21'), ('org.jetbrains.kotlin', 'kotlin-script-runtime', '2.2.21'), ('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'), ('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'), ('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'), ('org.jetbrains', 'annotations', '13.0'), ('org.json', 'json', '20240303'), ('org.jsoup', 'jsoup', '1.17.2')]
cp = ':'.join(str(next((cache / g / n / v).glob('*/*.jar'))) for g, n, v in deps)
annotations = '''package androidx.room
annotation class Entity(val tableName:String="",val indices:Array<Index> = [])
annotation class Index(val value:Array<String>,val unique:Boolean=false)
annotation class PrimaryKey
annotation class Dao
annotation class Query(val value:String)
annotation class Insert(val onConflict:Int=0)
annotation class Transaction
object OnConflictStrategy {const val REPLACE=1;const val IGNORE=2}
'''
probe = r'''package com.lightningstudio.watchrss.phone.data.note
import org.json.JSONObject
import org.json.JSONArray
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import java.util.Base64
class MemoryDao:NoteDao {
 val rows=linkedMapOf<String,NoteEntity>();val conflicts=linkedMapOf<String,NoteConflictEntity>()
 override suspend fun hasAny()=rows.isNotEmpty()
 override fun observeFolders():Flow<List<NoteFolderEntity>> = flowOf(emptyList())
 override fun observeNotes():Flow<List<NoteEntity>> = flowOf(rows.values.toList())
 override fun observeUnresolvedConflicts():Flow<List<NoteConflictEntity>> = flowOf(conflicts.values.toList())
 override suspend fun note(noteId:String)=rows[noteId]
 override suspend fun search(query:String)=rows.values.filter{query in it.markdown}
 override suspend fun allNotes()=rows.values.toList()
 override suspend fun assets(noteId:String)=emptyList<NoteAssetEntity>()
 override suspend fun assetByHash(sha256:String):NoteAssetEntity? = null
 override suspend fun upsertFolders(items:List<NoteFolderEntity>){}
 override suspend fun upsertAssets(items:List<NoteAssetEntity>){}
 override suspend fun upsertNotes(items:List<NoteEntity>){items.forEach{rows[it.noteId]=it}}
 override suspend fun upsertConflicts(items:List<NoteConflictEntity>){items.forEach{conflicts.putIfAbsent(it.conflictId,it)}}
 override suspend fun resolveConflict(conflictId:String,resolvedAt:Long){conflicts[conflictId]?.let{conflicts[conflictId]=it.copy(resolvedAt=resolvedAt)}}
 override suspend fun clearConflicts(){conflicts.clear()}
 override suspend fun clearAssets(){}
 override suspend fun clearNotes(){rows.clear()}
 override suspend fun clearFolders(){}
}
fun raw(s:String)=Base64.getDecoder().decode(s)
fun b64(b:ByteArray)=Base64.getEncoder().encodeToString(b)
fun main(args:Array<String>)=runBlocking{
 val input=JSONArray(java.io.File(args[0]).readText());val out=JSONArray()
 for(i in 0 until input.length()){
  val c=input.getJSONObject(i);val dao=MemoryDao();val repo=NoteRepository(dao,"phone"){999L}
  if(c.has("local"))dao.upsertNotes(NoteCloudStateCodec.decode(raw(c.getString("local"))))
  val incoming=NoteCloudStateCodec.decode(raw(c.getString("state")))
  for(n in incoming)repo.applyRemote(n,n.modifiedBy)
  val result=JSONObject().put("label",c.getString("label")).put("state",JSONObject(String(NoteCloudStateCodec.encode(repo.allNotes()),Charsets.UTF_8)))
  result.put("baseHashes",JSONObject().apply{repo.allNotes().forEach{put(it.noteId,it.baseContentHash)}})
  result.put("markdown",JSONObject().apply{repo.allNotes().filterNot{it.deleted}.forEach{put(it.noteId,b64(MarkdownNoteCodec.export(it).toByteArray()))}})
  result.put("conflicts",JSONArray().apply{dao.conflicts.values.forEach{put(JSONObject().put("noteId",it.noteId).put("base",it.baseMarkdown).put("local",it.localMarkdown).put("remote",it.remoteMarkdown).put("remoteDeviceId",it.remoteDeviceId))}})
  if(c.has("zip")){
   val entries=MarkdownNoteArchive.read(raw(c.getString("zip")))
   result.put("entries",JSONArray().apply{entries.forEach{entry->put(JSONObject().put("path",entry.path).put("bytes",b64(entry.bytes)))}})
   val exported=entries.filter{it.path.startsWith("notes/assets/")}+repo.allNotes().filterNot{it.deleted}.map{MarkdownArchiveEntry(MarkdownNoteArchive.safePath("notes/${it.noteId}.md"),MarkdownNoteCodec.export(it).toByteArray())}
   result.put("reexportZip",b64(MarkdownNoteArchive.write(exported)))
  }
  out.put(result)
 }
 println(out.toString())
}
'''
with tempfile.TemporaryDirectory(prefix='podnotes-phone-jvm-') as folder:
    root = Path(folder)
    (root / 'Room.kt').write_text(annotations)
    (root / 'Probe.kt').write_text(probe)
    subprocess.run(['java', '-cp', cp, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', cp, '-d', folder, *(str(native / n) for n in names), str(root / 'Room.kt'), str(root / 'Probe.kt')], check=True)
    rows = json.loads(subprocess.check_output(['java', '-cp', folder + ':' + cp, 'com.lightningstudio.watchrss.phone.data.note.ProbeKt', sys.argv[1]], text=True))
result = {'runtime': 'Desktop JVM; unchanged phone codecs and repository; in-memory DAO; no Android or cloud', 'sources': {n: hashlib.sha256((native / n).read_bytes()).hexdigest() for n in names}, 'cases': rows}
Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
