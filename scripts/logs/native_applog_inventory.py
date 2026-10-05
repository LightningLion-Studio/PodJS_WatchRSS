#!/usr/bin/env python3
"""Offline inventory. Reads reference sources only; never invokes adb or network.
Usage: python scripts/logs/native_applog_inventory.py --native-root PATH [--check]
--check detects reference drift and missing application locators.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
FIXTURE = APP / "tests/fixtures/native-applog-inventory.json"
COVERAGE = APP / "scripts/logs/native-applog-coverage.json"
DOC = APP / "docs/native-applog-coverage.md"

def quoted_end(text, start):
    quote = '"""' if text.startswith('"""', start) else text[start]
    i = start + len(quote)
    while i < len(text):
        if text.startswith(quote, i): return i + len(quote)
        if len(quote) == 1 and text[i] == "\\": i += 2; continue
        if text.startswith("${", i): i = balanced_end(text, i + 1, "{", "}"); continue
        i += 1
    raise ValueError("Unclosed string")

def balanced_end(text, start, opening="(", closing=")"):
    depth = 1
    i = start + 1
    while i < len(text):
        if text[i] in "\"'": i = quoted_end(text, i); continue
        if text.startswith("//", i):
            end = text.find("\n", i); i = len(text) if end < 0 else end; continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0: raise ValueError("Unclosed comment")
            i = end + 2; continue
        if text[i] == opening: depth += 1
        elif text[i] == closing:
            depth -= 1
            if depth == 0: return i + 1
        i += 1
    raise ValueError("Unclosed call")

def mask_literals(text):
    chars = list(text)
    i = 0
    while i < len(text):
        if text[i] in "\"'": end = quoted_end(text, i)
        elif text.startswith("//", i):
            end = text.find("\n", i)
            if end < 0: end = len(text)
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2) + 2
            if end == 1: raise ValueError("Unclosed comment")
        else: i += 1; continue
        chars[i:end] = ["\n" if ch == "\n" else " " for ch in chars[i:end]]
        i = end
    return "".join(chars)

def scan(root):
    rows, hashes = [], {}
    for source_set in ("main", "debug"):
        for path in sorted((root / "app/src" / source_set).rglob("*.kt")):
            text = path.read_text()
            if "AppLogger" not in text and "WatchBluetoothDebugLog." not in text: continue
            relative = path.relative_to(root).as_posix()
            constants = dict(re.findall(r'(?:const\s+)?val\s+(\w+)\s*=\s*"([^"\n]*)"', text))
            code = mask_literals(text)
            pattern = r'\b(AppLogger|WatchBluetoothDebugLog)\.(log|[vdiwe]|event|warn|error)\s*\('
            matches = list(re.finditer(pattern, code))
            if path.name == "AppLogger.kt":
                # Internal init/clear messages are unqualified calls; exclude the method definition.
                matches += [m for m in re.finditer(r'\b(log)\s*\(', code) if not re.search(r'fun\s+$', code[max(0, m.start()-10):m.start()])]
            for match in sorted(matches, key=lambda m: m.start()):
                end = balanced_end(text, match.end() - 1)
                args = text[match.end():end-1].strip()
                internal = match.lastindex == 1
                logger, method = ("AppLogger", "log") if internal else (match[1], match[2])
                tag = args.split(",", 1)[0].strip()
                tag = "BtSyncDebug" if logger == "WatchBluetoothDebugLog" else constants.get(tag, tag.strip('"'))
                functions = list(re.finditer(r'\bfun\s+(\w+)\s*\(', code[:match.start()]))
                line = text[:match.start()].count("\n") + 1
                rows.append({"id": f"{relative}:{line}", "file": relative, "line": line,
                    "logger": logger, "level": {"log":"D","event":"I","warn":"W","error":"E"}.get(method, method.upper()),
                    "tag": tag, "scope": functions[-1][1] if functions else "initialization/callback",
                    "call": re.sub(r"\s+", " ", args)})
            if matches: hashes[relative] = hashlib.sha256(text.encode()).hexdigest()
    return {"nativeRevision": subprocess.check_output(["git","-C",str(root),"rev-parse","HEAD"], text=True).strip(),
            "filesSha256": hashes, "calls": rows}

def render(snapshot, coverage):
    counts = {}
    for value in coverage.values(): counts[value["status"]] = counts.get(value["status"], 0) + 1
    lines = [
        "# L2 原生 AppLogger 逐点对照（离线）", "",
        "本表只比较本地 Android_WatchRSS 的 AppLogger，以及转发到它的 WatchBluetoothDebugLog；不把 Android Log、SDK BiliDebugLog/DebugLogBuffer 误算为 AppLogger。内部 init/clear 两点也列入。原生只读，无设备/生产网络证据。",
        "", f"原生 HEAD：`{snapshot['nativeRevision']}`。逐文件 SHA-256 和完整调用参数在 `tests/fixtures/native-applog-inventory.json`；这是源码快照，不声称该 HEAD 的运行时日志已验证。",
        "", f"共 **{len(snapshot['calls'])}** 点：" + "；".join(f"{key} {count}" for key,count in sorted(counts.items())) + "。",
        "",
        "- **已补**：存在对应业务事件，使用原生 tag/级别/固定模板。私有字段用 `<redacted>`，异常不传入日志。",
        "- **已有**：基线已包含该消息。",
        "- **部分**：可观察边界已记录；字段、触发粒度或原生专用分支仍有明确差异，不能计作逐字全等。",
        "- **热路径排除**：按任务禁止在滚动/逐帧/逐行路径加日志；保留边界/失败日志。",
        "- **无对应事件**：原生机制在 PodJS 当前应用中不存在，或仅由宿主执行且没有细分事件回传；不伪造日志、不新增业务功能来制造触发点。",
        "",
        "安全差异：搜索词、正文片段、二维码、URL、账户/peer 标识、header signature、原始异常及服务端 message 不写入；记录计数/布尔状态和固定枚举。裸签名参数仍经既有 redact 二次脱敏。兼容 warn/error 丢弃额外异常参数。debug 命令沿用 application.buildInfo().debugBuild gate。",
        "",
        "宿主专属差异主要包括：Android Activity/vendor 手势、网络 ContentObserver、WebView JS 检测/图片解码细节、原生 RAM proxy/pinned byte cache、ExoPlayer codec policy/slot/poster 的细粒度事件。现有 PodJS metadata 缓存或 host 成功返回不能充当这些事件的证据。",
        "",
        "RSS 刷新/解析、云同步、备忘录、导入正文存储、通用离线媒体、通知/推送：当前原生这些模块没有 AppLogger 调用点；RSS 等现有 PodJS 附加诊断可保留，不虚构原生模板。阅读器导入进度/朗读触摸以及手机同步调用按下面各行单独比较。",
        "",
        "复查：`python scripts/logs/native_applog_inventory.py --native-root /home/wilf/data/OPPO_Develop/Android_WatchRSS --check`。若原生源码漂移会失败，须重新逐点审核，不自动把新点判为已覆盖。",
        "",
        "| 原生位置 | tag / 级别 | 触发范围（原生函数/回调） | 原生调用参数 / 消息模板 | 改前 → 当前 | PodJS 对应位置 / 差异 |",
        "|---|---|---|---|---|---|"
    ]
    esc=lambda value: str(value).replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("|","&#124;").replace("\n"," ").replace("`","&#96;")
    for row in snapshot["calls"]:
        entry=coverage[row["id"]]
        source=f"{Path(row['file']).name}:{row['line']}"
        target=f"/home/wilf/data/OPPO_Develop/Android_WatchRSS/{row['id']}"
        location="；".join(f"`{item['file']}:{item['line']}`" for item in entry["locations"]) or "—"
        lines.append(f"| [{source}]({target}) | {esc(row['tag'])} / {row['level']} | {esc(row['scope'])} | {esc(row['call'])} | {esc(entry['before'])} → **{entry['status']}** | {location} — {esc(entry['note'])} |")
    return "\n".join(lines)+"\n"

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-root",required=True,type=Path)
    parser.add_argument("--check",action="store_true")
    parser.add_argument("--snapshot-only",action="store_true")
    args=parser.parse_args()
    snapshot=scan(args.native_root)
    if args.snapshot_only:
        FIXTURE.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2)+"\n")
        print(f"snapshot: {len(snapshot['calls'])} calls");return
    coverage=json.loads(COVERAGE.read_text())
    if set(coverage)!=set(row["id"] for row in snapshot["calls"]):
        raise SystemExit("Coverage rows do not exactly match reference calls; audit required")
    for row in coverage.values():
        for loc in row["locations"]:
            lines=(APP/loc["file"]).read_text().splitlines()
            found=[i+1 for i,line in enumerate(lines) if loc["anchor"] in line]
            if not found: raise SystemExit(f"Missing application anchor: {loc}")
            loc["line"]=found[0]
    doc=render(snapshot,coverage)
    if args.check:
        if json.loads(FIXTURE.read_text())!=snapshot: raise SystemExit("Native source snapshot drift")
        if DOC.read_text()!=doc: raise SystemExit("Coverage document drift; regenerate after review")
    else:
        FIXTURE.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2)+"\n")
        COVERAGE.write_text(json.dumps(coverage,ensure_ascii=False,indent=2)+"\n")
        DOC.write_text(doc)
    print(f"{'checked' if args.check else 'wrote'} {len(snapshot['calls'])} native callpoints; all application anchors resolve")
if __name__=="__main__":main()
