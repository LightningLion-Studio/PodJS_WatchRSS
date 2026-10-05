#!/usr/bin/env python3
"""Offline oracle: compile original Kotlin codec/protocol without changing it.
Also feed JS-generated PCM into the unmodified native decoder. No device/network.
"""
from pathlib import Path
import json,subprocess,tempfile,hashlib
project=Path(__file__).resolve().parents[2]
native=project.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss'
cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0'),('org.json','json','20240303')]
cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
probe=r'''
import com.lightningstudio.watchrss.phoneconnection.acoustic.AcousticCodec
import com.lightningstudio.watchrss.phoneconnection.*
import java.io.File
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import org.json.JSONObject
fun main(args:Array<String>){
 val root=File(args[0]);val payload=File(root,"payload.txt").readBytes()
 if(args.size>1){val bytes=File(root,"js.pcm").readBytes();val samples=ShortArray(bytes.size/2);ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(samples);File(root,"native-from-js.txt").writeText(AcousticCodec.decode(samples)?.toString(Charsets.UTF_8)?:"DECODE_FAILED");return}
 val packet=AcousticCodec.encode(payload);val pcm=ByteBuffer.allocate(packet.waveform.size*2).order(ByteOrder.LITTLE_ENDIAN);packet.waveform.forEach{pcm.putShort(it)};File(root,"native.pcm").writeBytes(pcm.array())
 val sink=ByteArrayOutputStream();GZIPOutputStream(sink).use{it.write(payload)}
 val compact=AcousticConnectionProtocol.buildGuidedWifi(PhoneConnectionAbility.REMOTE_INPUT,"W123","ABCDEFGH","192.168.43.1",8080,"TOKEN123")
 val legacy=AcousticConnectionProtocol.parseGuidedWifi("""{"kind":"guided_wifi","ability":"REMOTE_INPUT","ssid":"WatchRSS","passphrase":"12345678","host":"192.168.43.1","port":8080,"token":"token"}""".toByteArray())
 val existing=AcousticConnectionProtocol.buildGuidedWifi(PhoneConnectionAbility.REMOTE_INPUT,"mi108507","","192.168.31.234",8080,"TOKEN123")
 File(root,"oracle.json").writeText(JSONObject().put("durationMs",packet.durationMs).put("compressedBytes",packet.compressedBytes).put("encodedChars",packet.encodedChars).put("gzipBase64",Base64.getEncoder().encodeToString(sink.toByteArray())).put("nativeRoundtrip",AcousticCodec.decode(packet.waveform)?.toString(Charsets.UTF_8)).put("compact",JSONObject(compact.toString(Charsets.UTF_8))).put("legacyAbility",legacy.ability.name).put("existing",JSONObject(existing.toString(Charsets.UTF_8))).toString())
}
'''
payload='{"kind":"pure_sound","ability":"watchrss-remote-input","url":"https://example.com/feed.xml?x=1&y=2"}'
with tempfile.TemporaryDirectory(prefix='wrss-acoustic-oracle-') as tmp:
 p=Path(tmp);(p/'payload.txt').write_text(payload);(p/'Probe.kt').write_text(probe)
 (p/'SavedItem.kt').write_text('package com.lightningstudio.watchrss.data.rss\ndata class SavedArticle(val link:String?)\ndata class SavedItem(val item:SavedArticle)\n')
 sources=[native/'phoneconnection/acoustic/AcousticCodec.kt',native/'phoneconnection/AcousticConnectionProtocol.kt',native/'phoneconnection/PhoneConnectionAbility.kt',native/'phoneconnection/SavedItemsSyncPayload.kt',p/'SavedItem.kt',p/'Probe.kt']
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',cp,'-d',tmp,*map(str,sources)],check=True)
 subprocess.run(['java','-cp',tmp+':'+cp,'ProbeKt',tmp],check=True)
 fixture=json.loads((p/'oracle.json').read_text());fixture['payload']=payload;fixture['nativePcmSha256']=hashlib.sha256((p/'native.pcm').read_bytes()).hexdigest();fixture['sourceSha256']={str(s.relative_to(native)):hashlib.sha256(s.read_bytes()).hexdigest() for s in sources[:4]}
 # Produce JS waveform using the exact native compressed packet, then decode native waveform in JS.
 subprocess.run(['bun',str(project/'scripts/reference/check-acoustic.ts'),tmp],check=True,cwd=project)
 subprocess.run(['java','-cp',tmp+':'+cp,'ProbeKt',tmp,'decode-js'],check=True)
 assert (p/'native-from-js.txt').read_text()==payload,'unmodified native decoder rejected JS waveform'
 assert (p/'js-from-native.txt').read_text()==payload,'JS decoder rejected native waveform'
 fixture['jsPcmSha256']=hashlib.sha256((p/'js.pcm').read_bytes()).hexdigest()
 assert fixture['jsPcmSha256']==fixture['nativePcmSha256'],'PCM sample bytes differ'
 # Exercise the encoder workaround against the real signed-CRC receiver too.
 import base64,zlib
 for number in range(20):
  high_payload=json.dumps({'kind':'pure_sound','ability':'SYNC_FAVORITES','items':[{'link':f'https://example.com/{number}'}]},separators=(',',':'))
  (p/'payload.txt').write_text(high_payload)
  subprocess.run(['java','-cp',tmp+':'+cp,'ProbeKt',tmp],check=True)
  high=json.loads((p/'oracle.json').read_text())
  if zlib.crc32(base64.b64decode(high['gzipBase64']))<0x80000000:continue
  assert 'nativeRoundtrip' not in high,'expected original signed CRC rejection'
  subprocess.run(['bun',str(project/'scripts/reference/check-acoustic.ts'),tmp],check=True,cwd=project)
  (p/'js.pcm').write_bytes((p/'js-encoded.pcm').read_bytes())
  subprocess.run(['java','-cp',tmp+':'+cp,'ProbeKt',tmp,'decode-js'],check=True)
  assert (p/'native-from-js.txt').read_text()==high_payload,'native rejected compatible gzip header'
  assert (p/'js-from-native.txt').read_text()==high_payload,'JS rejected original native high CRC'
  fixture['highCrcInterop']={'payload':high_payload,'nativeGzipBase64':high['gzipBase64'],'nativeOriginalRejected':True,'jsReceivesNative':True,'nativeReceivesJsCompatibleHeader':True}
  break
 else:raise AssertionError('No high CRC case found')
 target=project/'tests/phoneconnection/native-acoustic-oracle.json';target.write_text(json.dumps(fixture,ensure_ascii=False,indent=2)+'\n')
 print('PASS: unmodified Kotlin -> JS and JS -> unmodified Kotlin; identical PCM16 bytes; protocol vectors captured')
