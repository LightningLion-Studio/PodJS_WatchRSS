#!/usr/bin/env bash
# C7 review F2 memory probe. Owned emulator and loopback synthetic server only.
# Usage: run-c7-memory.sh <framework-worktree> <emulator-serial> <evidence-dir> <run>...
# Each run is notes:mode:limitMiB[:flush[:oversizeChars]]. A publish run with
# flush resets the synthetic account first; pull runs read the account left by
# the last flush (and, with flush, upload the edit); follow runs only follow
# that account (R4). oversizeChars > 0 first adds
# a phone-written note `big`; with WRSS_C7_READER_BUDGET below its size the
# watch must quarantine it (F1). The writer itself is capped at 2 MiB.
# Product local cipher and host bounds apply; nothing is bypassed.
set -euo pipefail
framework=$(realpath "${1:?framework worktree required}")
serial=${2:?owned emulator serial required}
evidence=${3:?evidence directory required}
shift 3
[[ $serial =~ ^emulator-[0-9]+$ ]] || { echo 'Physical devices are forbidden' >&2; exit 2; }
project=$(cd "$(dirname "$0")/../../.." && pwd)
[[ $(realpath "$project/node_modules/@podjs/framework") == "$framework/packages/framework" ]] || { echo 'Framework link mismatch' >&2; exit 2; }
adb=${ANDROID_SDK_ROOT:?ANDROID_SDK_ROOT required}/platform-tools/adb
port=${WRSS_C7_MEMORY_PORT:-18992}
mkdir -p "$evidence"
evidence=$(realpath "$evidence")
native="$framework/platforms/android/runtime/src/androidTest/java/dev/podjs/runtime/C7MemoryIntegrationTest.java"
[[ ! -e $native ]] || { echo 'Test destination exists; do not overwrite it' >&2; exit 2; }
cp "$project/tests/sync-v2/emulator/C7MemoryIntegrationTest.java" "$native"
fixture=${WRSS_C7_SERVER_FIXTURE:-"$evidence/fixture.json"}  # set to reuse a running server
server_pid=
cleanup(){
 rm -f "$native"
 [[ -n ${WRSS_C7_SERVER_FIXTURE:-} ]] || rm -f "$fixture"
 [[ -z $server_pid ]] || kill "$server_pid" 2>/dev/null || true
 "$adb" -s "$serial" shell run-as dev.podjs.runtime.test rm -rf files/syncv2-c7-memory >/dev/null 2>&1 || true
 "$adb" -s "$serial" reverse --remove "tcp:$port" >/dev/null 2>&1 || true
}
trap cleanup EXIT
(cd "$project" && bun build tests/sync-v2/emulator/c7-memory-guest.ts --target=browser --format=iife --outfile="$evidence/guest.js")
if [[ ${WRSS_C7_SKIP_BUILD:-} != 1 ]]; then
 (cd "$framework/platforms/android" && ./gradlew :runtime:assembleDebugAndroidTest --max-workers=2 -PpodAbis=x86_64 --offline) > "$evidence/build.log" 2>&1
fi
"$adb" -s "$serial" install -r "$framework/platforms/android/runtime/build/outputs/apk/androidTest/debug/runtime-debug-androidTest.apk" > "$evidence/install.log"
if [[ -z ${WRSS_C7_SERVER_FIXTURE:-} ]]; then
(cd "$project" && exec bun tests/sync-v2/emulator/c7-memory-server.ts "$port" "$fixture") > "$evidence/server.log" 2>&1 &
server_pid=$!
fi
for _ in $(seq 50); do [[ -s $fixture ]] && curl -sf "http://127.0.0.1:$port/c7/stats" >/dev/null && break; sleep 0.2; done
"$adb" -s "$serial" reverse "tcp:$port" "tcp:$port" >/dev/null
put(){ "$adb" -s "$serial" push "$1" /data/local/tmp/wrss-c7-memory.tmp >/dev/null; "$adb" -s "$serial" shell run-as dev.podjs.runtime.test cp /data/local/tmp/wrss-c7-memory.tmp "files/syncv2-c7-memory/$2"; "$adb" -s "$serial" shell rm /data/local/tmp/wrss-c7-memory.tmp; }
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test mkdir -p files/syncv2-c7-memory
put "$evidence/guest.js" guest.js
: > "$evidence/results.jsonl"
for spec in "$@"; do
 IFS=: read -r notes mode mib flush oversize <<<"$spec"
 [[ $flush == flush && $mode == publish ]] && curl -sf "http://127.0.0.1:$port/c7/reset" >/dev/null
 [[ -n ${oversize:-} && $oversize != 0 ]] && curl -sf "http://127.0.0.1:$port/c7/oversize?chars=$oversize" >/dev/null
 jq -c --arg mode "$mode" --argjson notes "$notes" --argjson chars "${WRSS_C7_NOTE_CHARS:-36000}" --argjson bytes "$((mib*1024*1024))" --argjson flush "$([[ $flush == flush ]] && echo true || echo false)" --argjson oversize "$([[ -n ${oversize:-} && $oversize != 0 ]] && echo true || echo false)" --argjson readerBudget "${WRSS_C7_READER_BUDGET:-0}" \
  '.mode=$mode|.notes=$notes|.chars=$chars|.memoryBytes=$bytes|.flush=$flush|.oversize=$oversize|.readerBudget=$readerBudget' "$fixture" > "$evidence/run-fixture.json"
 put "$evidence/run-fixture.json" fixture.json
 rm -f "$evidence/run-fixture.json"
 "$adb" -s "$serial" shell am instrument -w -e class dev.podjs.runtime.C7MemoryIntegrationTest dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner > "$evidence/instrumentation-$notes-$mode-$mib.log" 2>&1 || true
 "$adb" -s "$serial" exec-out run-as dev.podjs.runtime.test cat files/syncv2-c7-memory/result.json | jq -c . >> "$evidence/results.jsonl" || echo "{\"notes\":$notes,\"mode\":\"$mode\",\"limitMiB\":$mib,\"status\":\"no_result\"}" >> "$evidence/results.jsonl"
 tail -1 "$evidence/results.jsonl" | jq -c '{notes,mode,limitMiB:((.guestMemoryLimitBytes//0)/1048576),status,code,millis,peakHwmKiB,startRssKiB,steps:[.events[]?|select(.event=="step")|{stage,millis}],prepared:[.events[]?|select(.event=="prepared")|.segments],quarantined:[.events[]?|select(.event=="quarantined")|.code],failed:[.events[]?|select(.event=="failed")]}'
done
