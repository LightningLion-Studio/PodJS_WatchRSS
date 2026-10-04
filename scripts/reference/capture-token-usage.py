#!/usr/bin/env python3
"""Run the native Kotlin normalizer with Android SDK org.json on desktop JVM."""
from pathlib import Path
import hashlib,json,re,subprocess,tempfile
root=Path(__file__).resolve().parents[2]
source=root.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/llm/LlmTokenUsageRepository.kt'
text=source.read_text(); data=text[text.index('    data class NormalizedTokens('):text.index('    fun observeRecent')]; fn=text[text.index('    fun normalize('):text.rindex('\n}')]
android=Path('/home/wilf/Android/Sdk/sources/android-36/org/json')
values=['null','true','[]','{}','0','-1','1.9','-0.9','2147483648','4294967297','9007199254740993','9223372036854775807','9223372036854775808','-9223372036854775808','9007199254740993.0','1e30','"NaN"','"Infinity"','"-Infinity"','"3.9"','" 4 "','""','"0x10"','"0x1.8p2"','"3f"','"+2D"','"\\u00a04\\u00a0"','"bad"']
cases=['{}','{"input_tokens":2,"output_tokens":3,"inputTokens":9,"totalTokens":12}','{"completion_tokens_details":{"reasoning_tokens":-1},"reasoning_tokens":7,"cached_tokens":9}','{"completion_tokens_details":{"reasoning_tokens":0},"reasoning_tokens":7,"prompt_tokens_details":{"cached_tokens":2}}']
fields=['prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens','promptTokenCount','candidatesTokenCount','totalTokenCount']
cases += ['{'+','.join(json.dumps(k)+':'+v for k in fields)+',"completion_tokens_details":{"reasoning_tokens":'+v+'},"prompt_tokens_details":{"cached_tokens":'+v+'}}' for v in values]
cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0')]
cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
probe='import org.json.JSONObject\n'+data+fn+'''\nfun main(args:Array<String>){val input=org.json.JSONArray(java.io.File(args[0]).readText());val out=org.json.JSONArray();for(i in 0 until input.length()){val raw=input.getString(i);val n=normalize(JSONObject(raw));val result=JSONObject();for(f in n.javaClass.declaredFields){f.isAccessible=true;result.putOpt(f.name,f.get(n))};out.put(JSONObject().put("raw",raw).put("expected",result))};println(out)}\n'''
with tempfile.TemporaryDirectory(prefix='token-usage-oracle-') as tmp:
 d=Path(tmp); java=[]
 for p in android.glob('*.java'):
  s=p.read_text();s=re.sub(r'^import (?:static )?(?:android|libcore)\.[^;]+;','',s,flags=re.M);s=re.sub(r'@(?:UnsupportedAppUsage|SystemApi)(?:\([^)]*\))?','',s);s=re.sub(r'@(?:NonNull|Nullable)\b','',s)
  q=d/p.name;q.write_text(s);java.append(str(q))
 subprocess.run(['javac','-d',tmp,*java],check=True)
 (d/'Probe.kt').write_text(probe);(d/'input.json').write_text(json.dumps(cases))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',tmp+':'+cp,'-d',tmp,str(d/'Probe.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',tmp+':'+cp,'ProbeKt',str(d/'input.json')],text=True))
fixture={'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'androidSourceHashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in android.glob('*.java')},'runtime':'Desktop JVM, verbatim native Kotlin normalize and Android 36 org.json; annotations removed only. No device/UI acceptance.','cases':result}
(root/'tests/fixtures/token-usage-native.json').write_text(json.dumps(fixture,indent=2)+'\n');print('Captured',len(result),'native cases')
