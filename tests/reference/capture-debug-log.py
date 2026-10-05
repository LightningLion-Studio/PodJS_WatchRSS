"""Capture the native pullDebugLog branch with Android org.json, without a device."""
from pathlib import Path
import hashlib,json,re,subprocess,tempfile
root=Path(__file__).resolve().parents[2]
source=root.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/phoneconnection/bluetooth/WatchBluetoothSyncServer.kt'
s=source.read_text(); branch=s[s.index('                    val maxChars = request.optInt("maxChars"'):s.index('\n                BluetoothSyncProtocol.ACTION_CLEAR_LIBRARY')]
branch=branch[:branch.rfind('\n                }')].replace('                    JSONObject().apply {','                    return JSONObject().apply {')
values=['null','true','[]','{}','0','-1','1.9','-0.9','2147483648','4294967297','9007199254740993','9223372036854775807','9223372036854775808','-9223372036854775808','9007199254740993.0','1e30','"NaN"','"Infinity"','"-Infinity"','"3.9"','" 4 "','""','"0x10"','"0x1.8p2"','"3f"','"+2D"','"\\u00a04\\u00a0"','"bad"','700000','700001']
cases=['{}']+['{"maxChars":'+v+'}' for v in values]
android=Path('/home/wilf/Android/Sdk/sources/android-36/org/json');cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0')]
cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
probe='''import org.json.JSONObject
object BluetoothSyncProtocol { const val ACTION_PULL_DEBUG_LOG = "pullDebugLog" }
fun pull(request:JSONObject,raw:String):JSONObject {
'''+branch+'''
}
fun main(args:Array<String>){
 val input=org.json.JSONArray(java.io.File(args[0]).readText());val out=org.json.JSONArray()
 for(i in 0 until input.length()){
  val raw=input.getString(i);val response=pull(JSONObject(raw),"x".repeat(700005)+"中😀")
  val log=response.getString("log");response.remove("log")
  response.put("logLength",log.length).put("tailCodeUnits",org.json.JSONArray(log.takeLast(4).map{it.code}))
  out.put(JSONObject().put("raw",raw).put("expected",response))
 }
 println(out)
}
'''
with tempfile.TemporaryDirectory(prefix='debug-log-oracle-') as tmp:
 d=Path(tmp);java=[]
 for p in android.glob('*.java'):
  s=p.read_text();s=re.sub(r'^import (?:static )?(?:android|libcore)\.[^;]+;','',s,flags=re.M);s=re.sub(r'@(?:UnsupportedAppUsage|SystemApi)(?:\([^)]*\))?','',s);s=re.sub(r'@(?:NonNull|Nullable)\b','',s)
  q=d/p.name;q.write_text(s);java.append(str(q))
 subprocess.run(['javac','-d',tmp,*java],check=True)
 (d/'Probe.kt').write_text(probe);(d/'input.json').write_text(json.dumps(cases))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',tmp+':'+cp,'-d',tmp,str(d/'Probe.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',tmp+':'+cp,'ProbeKt',str(d/'input.json')],text=True))
fixture={'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'runtime':'Desktop JVM; native pullDebugLog branch, source injected as a String; Android 36 org.json. Not device evidence.','cases':result}
(root/'tests/fixtures/debug-log-native.json').write_text(json.dumps(fixture,indent=2)+'\n');print('Captured',len(result),'native cases')
