#!/usr/bin/env python3
"""Compile the unchanged native controller's pure segmentation functions as an oracle."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

project = Path(__file__).resolve().parents[2]
native = project.parent / "Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/tts/ReadAloudController.kt"
source = native.read_text()
snippet = source[source.index("private data class ReadAloudSegmentSlice("):source.index("private fun skipLeadingWhitespace(")]
probe = '''
private const val READ_ALOUD_TTS_SEGMENT_MAX_CHARS = 240
private val READ_ALOUD_SEGMENT_ENDINGS = setOf('。', '！', '？', '!', '?', ';', '；', '.', ':', '：')
fun main(args: Array<String>) {
  val inputs = org.json.JSONArray(java.io.File(args[0]).readText())
  val output = org.json.JSONArray()
  for (index in 0 until inputs.length()) {
    val input = inputs.getJSONObject(index)
    val slices = readAloudSegmentSlices(input.getString("text"), input.getInt("base"), input.getInt("limit"))
    output.put(org.json.JSONObject().put("input", input).put("segments", org.json.JSONArray(slices.map { org.json.JSONObject().put("text", it.text).put("sourceOffsets", org.json.JSONArray(it.sourceOffsets.toList())).put("isTitle", false) })))
  }
  println(output)
}
'''
cases = []
for text in ["", "   ", "  标题\t正文。第二句！\n第三句?", "One sentence. Next: detail; done!", "字" * 720, "一。二！三？" * 120, "\u00a0空格\u2007再来\u202f结束\u001c", "A\r\nB\rC\t\tD", "中文😀标点。English!", "e\u0301组合字", "前\ufeff后"]:
    for base in [0, 19]:
        for limit in [12, 240]:
            cases.append({"text": text, "base": base, "limit": limit})
cache = Path.home() / ".gradle/caches/modules-2/files-2.1"
deps = [("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.2.21"), ("org.jetbrains.kotlin", "kotlin-stdlib", "2.2.21"), ("org.jetbrains.kotlin", "kotlin-script-runtime", "2.2.21"), ("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"), ("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330"), ("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"), ("org.jetbrains", "annotations", "13.0"), ("org.json", "json", "20240303")]
classpath = ":".join(str(next((cache / group / name / version).glob("*/*.jar"))) for group, name, version in deps)
with tempfile.TemporaryDirectory(prefix="watchrss-speech-oracle-") as folder:
    root = Path(folder)
    (root / "SpeechProbe.kt").write_text(snippet + probe)
    (root / "input.json").write_text(json.dumps(cases, ensure_ascii=False))
    subprocess.run(["java", "-cp", classpath, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-classpath", classpath, "-d", folder, str(root / "SpeechProbe.kt")], check=True)
    result = subprocess.check_output(["java", "-cp", folder + ":" + classpath, "SpeechProbeKt", str(root / "input.json")], text=True)
fixture = project / "tests/fixtures/speech-segments-native.json"
fixture.write_text(json.dumps({"source": str(native.relative_to(project.parent)), "sha256": hashlib.sha256(native.read_bytes()).hexdigest(), "extractedSha256": hashlib.sha256(snippet.encode()).hexdigest(), "cases": json.loads(result)}, ensure_ascii=False, indent=2) + "\n")
print(f"Captured {len(cases)} native segmentation cases: {fixture}")
