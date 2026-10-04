#!/usr/bin/env python3
"""Compile the unchanged native controller's pure fallback highlight and timing functions as an oracle."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

project = Path(__file__).resolve().parents[2]
native = project.parent / "Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/tts/ReadAloudController.kt"
source = native.read_text()
def function(name):
    start = source.index("fun " + name + "(")
    start = source.rfind("\n", 0, start) + 1
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]

names = ["readAloudFallbackSpeechUnits", "readAloudFallbackOffsetForProgress", "readAloudFallbackReadableOffsetForProgress", "readAloudFallbackCharUnits", "skipFallbackHighlightAnchor", "skipLeadingWhitespace", "Char.isAsciiLetter", "String.hasDigitNeighbor", "String.hasAlphanumericNeighbor", "Char.isCjkCharacter", "fallbackHighlightOffsets", "previousTokenStart", "nextTokenEnd", "nextCjkFallbackEnd", "estimateFallbackSegmentDurationMs"]
snippet = "import kotlin.math.roundToLong\n" + "\n".join(function(name) for name in names)
# The controller overload delegates directly to this extracted top-level helper.
snippet += "\nprivate fun fallbackSpeechUnits(text: String) = readAloudFallbackSpeechUnits(text)"
snippet += "\nprivate data class HighlightOffsets(val start: Int, val end: Int)"
snippet += "\nprivate var speechRate = 1f\nprivate var fallbackUnitsPerSecond = 3.75"
import re
for match in re.finditer(r"^private const val READ_ALOUD_(?:MIN_SPEECH_RATE|FALLBACK_[A-Z_]+) = .*", source, re.M):
    snippet += "\n" + match.group()
for name in ["MODEL_SEPARATORS", "SKIP_START_CHARS", "STOP_CHARS"]:
    constant = source[source.index("private val READ_ALOUD_FALLBACK_" + name):]
    # Sets contain ')' as a character; consume through the line-closing parenthesis.
    snippet += "\n" + constant[:constant.index("\n)") + 2]
probe = '''
fun main(args: Array<String>) {
  val inputs = org.json.JSONArray(java.io.File(args[0]).readText())
  val output = org.json.JSONArray()
  for (index in 0 until inputs.length()) {
    val input = inputs.getJSONObject(index)
    val text = input.getString("text")
    val progress = input.getDouble("progress").toFloat()
    speechRate = input.getDouble("rate").toFloat()
    val range = fallbackHighlightOffsets(text, progress)
    output.put(org.json.JSONObject().put("input", input)
      .put("units", readAloudFallbackSpeechUnits(text))
      .put("offset", readAloudFallbackReadableOffsetForProgress(text, progress))
      .put("start", range.start).put("end", range.end)
      .put("durationMs", estimateFallbackSegmentDurationMs(text)))
  }
  println(output)
}
'''
cases = []
for text in ["", "   ", "正文   从这里开始。下一段！", "甲， 乙。 丙！末尾", "One: two; three?", "前\r\n 后", "前\u00a0\u2007\u202f\u001c后", "前\ufeff后", "中文😀标点。English!", "e\u0301组合字", "OPPO X9 Pro (8+256GB)/A_12-4.5，速度提升！", "\t。， 末尾  ", "1２٣۴५६-ＡΒé", "あいう カタカナ 한국어", "文" * 1000]:
    for progress in [-1, 0, .05, .13, .25, .5, .75, .985, 1, 2]:
        for rate in [.05, 1, 1.15, 4]:
            cases.append({"text": text, "progress": progress, "rate": rate})
cache = Path.home() / ".gradle/caches/modules-2/files-2.1"
deps = [("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.2.21"), ("org.jetbrains.kotlin", "kotlin-stdlib", "2.2.21"), ("org.jetbrains.kotlin", "kotlin-script-runtime", "2.2.21"), ("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"), ("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330"), ("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"), ("org.jetbrains", "annotations", "13.0"), ("org.json", "json", "20240303")]
classpath = ":".join(str(next((cache / group / name / version).glob("*/*.jar"))) for group, name, version in deps)
with tempfile.TemporaryDirectory(prefix="watchrss-speech-oracle-") as folder:
    root = Path(folder)
    (root / "SpeechProbe.kt").write_text(snippet + probe)
    (root / "input.json").write_text(json.dumps(cases, ensure_ascii=False))
    subprocess.run(["java", "-cp", classpath, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-classpath", classpath, "-d", folder, str(root / "SpeechProbe.kt")], check=True)
    result = subprocess.check_output(["java", "-cp", folder + ":" + classpath, "SpeechProbeKt", str(root / "input.json")], text=True)
fixture = project / "tests/fixtures/speech-highlight-native.json"
fixture.write_text(json.dumps({"source": str(native.relative_to(project.parent)), "sha256": hashlib.sha256(native.read_bytes()).hexdigest(), "extractedSha256": hashlib.sha256(snippet.encode()).hexdigest(), "cases": json.loads(result)}, ensure_ascii=False, indent=2) + "\n")
print(f"Captured {len(cases)} native highlight cases: {fixture}")
