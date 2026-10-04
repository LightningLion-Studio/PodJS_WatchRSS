#!/usr/bin/env python3
"""Execute verbatim native note text functions with the project's cached Jsoup."""
from pathlib import Path
import hashlib,json,subprocess,tempfile
project=Path(__file__).resolve().parents[2];source=project.parent/'Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/note/WatchNoteRepository.kt'
text=source.read_text();functions=text[text.index('fun watchPlainText('):]
cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
deps=[('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','13.0'),('org.json','json','20240303'),('org.jsoup','jsoup','1.17.2')]
cp=':'.join(str(next((cache/g/n/v).glob('*/*.jar'))) for g,n,v in deps)
cases=['','# 标题\r\n**粗体**\n> 引用\n1. 列表','<p>第一段<br>第二行</p><div><b>粗体</b></div>', '<IMG SRC="a" ALT="图 &amp; 字"> <img src="b">', '<ul><li>一</li><li data-id="x">二</li></ul>', '<table><tr><th>头</th><td>值</td></tr></table>', '<script>alert(1)</script><custom>x</custom>', '&amp; &lt; &gt; &quot; &apos; &nbsp;', '&copy; &NotEqualTilde; &Afr; &CounterClockwiseContourIntegral;', '&copy without; &notit; &amp=foo; &AMP;', '&#0; &#x80; &#xD800; &#x110000; &#-1; &#13;', '![](x) ![图片](x) [链接](https://x)', '<img alt=unquoted><img alt="A\nB" src="x">', '\u00a0#\u00a0标题\u00a0\n\u2007a\u2007\n\u0085b\u0085', '\u001c\u001d\u001e\u001f x \u001c', '# 标题\r下一行', '##\u00a0不是ASCII空格', 'foo\n\n \t\nbar', 'a'*79+'😀尾', '<p class="x">&eacute;</p><hr><pre>x</pre>', '<img alt="a>b" src="x">']
cases += ['&'+name+suffix for name in ['not','notin','notit','frac12','frac12foo','copy','COPY','eacute','CounterClockwiseContourIntegral','amp','lt','a1b2','apos'] for suffix in [';','','=z',' x']]
probe='''import org.jsoup.parser.Parser
import java.security.MessageDigest
'''+functions+'''
fun main(args:Array<String>){val input=org.json.JSONArray(java.io.File(args[0]).readText());val out=org.json.JSONArray();for(i in 0 until input.length()){val s=input.getString(i);out.put(org.json.JSONObject().put("input",s).put("plainText",watchPlainText(s)).put("title",watchNoteTitle(s)).put("plainUnits",org.json.JSONArray(watchPlainText(s).map{it.code})).put("titleUnits",org.json.JSONArray(watchNoteTitle(s).map{it.code})))};println(out)}
'''
with tempfile.TemporaryDirectory(prefix='watchrss-note-text-') as temp:
 root=Path(temp);(root/'Probe.kt').write_text(probe);(root/'input.json').write_text(json.dumps(cases,ensure_ascii=True))
 subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',cp,'-d',temp,str(root/'Probe.kt')],check=True)
 result=json.loads(subprocess.check_output(['java','-cp',temp+':'+cp,'ProbeKt',str(root/'input.json')],text=True))
for row in result:
 for name,key in [('plainText','plainUnits'),('title','titleUnits')]:
  row[name]=b''.join(int(c).to_bytes(2,'little') for c in row.pop(key)).decode('utf-16-le','surrogatepass')
fixture={'source':str(source.relative_to(project.parent)),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'functionsSha256':hashlib.sha256(functions.encode()).hexdigest(),'runtime':'Desktop JVM; verbatim native functions, Jsoup 1.17.2; no Android UI validation.','cases':result};path=project/'tests/fixtures/note-text-native.json';path.write_text(json.dumps(fixture,ensure_ascii=True,indent=2)+'\n');print('Captured',len(result),'native note text cases')
