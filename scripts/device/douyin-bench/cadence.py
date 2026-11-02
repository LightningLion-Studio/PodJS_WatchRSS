"""One device shell owns swipe timing. All emitted times come from /proc/uptime.
The caller owns the traffic guard and device lock; terminate the returned adb
process immediately when the guard trips. No playback waits alter the cadence.
"""
import argparse
import json
import subprocess
import os
import tempfile
import re
from pathlib import Path


def script(count, pace_ms, direction='next', duration_ms=120):
    if not 1 <= count <= 200 or pace_ms not in (200, 500, 1000, 2000, 3000):
        raise ValueError('count/pace outside bounded matrix')
    if direction not in ('next', 'prev') or not 1 <= duration_ms < pace_ms:
        raise ValueError('invalid direction/duration')
    y1, y2 = (330, 220) if direction == 'next' else (220, 330)
    # Android input works on the watch and emulator. x=233, y=220..330 excludes mute.
    return f'''now() {{ read up rest < /proc/uptime; frac=${{up#*.}}; ms=$(( ${{up%.*}} * 1000 + 10#$frac * 10 )); }}
i=0
while [ "$i" -lt {count} ]; do
  now; start=$ms
  input swipe 233 {y1} 233 {y2} {duration_ms}
  rc=$?
  now; finish=$ms
  printf 'trial=%s start_ms=%s end_ms=%s status=%s\\n' "$i" "$start" "$finish" "$rc"
  [ "$rc" -eq 0 ] || exit "$rc"
  i=$((i+1))
  [ "$i" -lt {count} ] || break
  wait_ms=$(( {pace_ms} - finish + start ))
  if [ "$wait_ms" -gt 0 ]; then sleep "$(printf '%d.%03d' $((wait_ms/1000)) $((wait_ms%1000)))"; fi
done
'''


def build_driver(out):
    sdk = Path(os.environ.get('ANDROID_SDK_ROOT', '/home/wilf/Android/Sdk'))
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).parent / 'input/DyPrepCadence.java'
    android = sdk / 'platforms/android-36/android.jar'
    subprocess.run(['javac', '-source', '8', '-target', '8', '-cp', str(android),
                    '-d', str(out), str(source)], check=True, capture_output=True)
    subprocess.run([str(sdk/'build-tools/36.0.0/d8'), '--min-api', '30', '--lib', str(android),
                    '--output', str(out), str(out/'DyPrepCadence.class')], check=True, capture_output=True)
    return out/'classes.dex'


def start(serial, count, pace_ms, direction='next', duration_ms=None, task_tag='T-DYPREP'):
    if task_tag not in ('T-DYPREP','T-DYBYTES','T-DYSWAP','T-DYHIT'):raise ValueError('invalid task owner')
    duration_ms = (120 if pace_ms == 200 else 260) if duration_ms is None else duration_ms
    payload = script(count, pace_ms, direction, duration_ms) # validate first
    if serial not in ('e3aca8af', 'emulator-5560'):
        raise ValueError('only T-DYPREP targets')
    if serial == 'e3aca8af':
        owner = Path('/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/device/DEVICE_OWNER')
        if owner.read_text().strip() != task_tag:
            raise RuntimeError('T-DYPREP device ownership required')
        # One shell VM invokes Android Input.main repeatedly. A fresh input VM
        # per gesture cost >1 s on this watch, even inside one shell script.
        with tempfile.TemporaryDirectory(prefix='dyprep-driver-') as directory:
            dex = build_driver(directory)
            subprocess.run(['adb', '-s', serial, 'push', str(dex),
                            f'/data/local/tmp/{task_tag}-input.dex'], check=True, capture_output=True)
        payload = (f'export CLASSPATH=/system/framework/input.jar:/data/local/tmp/{task_tag}-input.dex\n'
                   'exec app_process /system/bin DyPrepCadence '+str(count)+' '+str(pace_ms)+' '+direction+' '+str(duration_ms)+'\n')
    process = subprocess.Popen(['adb', '-s', serial, 'shell', 'sh'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    process.stdin.write(payload)
    process.stdin.close()
    return process


def parse(output):
    rows = []
    for line in output.splitlines():
        if not line.startswith('trial='):
            continue
        row = {key: int(value) for key, value in (part.split('=') for part in line.split())}
        if set(row) != {'trial', 'start_ms', 'end_ms', 'status'}:
            raise ValueError('invalid cadence row')
        rows.append(row)
    return rows


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--serial', required=True, choices=['e3aca8af', 'emulator-5560'])
    p.add_argument('--count', required=True, type=int)
    p.add_argument('--pace-ms', required=True, type=int, choices=[200, 500, 1000, 2000, 3000])
    p.add_argument('--direction', default='next', choices=['next', 'prev'])
    p.add_argument('--out', required=True, type=Path)
    a = p.parse_args()
    if a.serial == 'e3aca8af':
        lock = Path('/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/device/DEVICE_OWNER')
        if lock.read_text().strip() != 'T-DYPREP':
            raise RuntimeError('T-DYPREP device ownership required')
    process = start(a.serial, a.count, a.pace_ms, a.direction)
    output = process.stdout.read()
    error = process.stderr.read()
    rc = process.wait()
    a.out.write_text(json.dumps({'requestedPaceMs': a.pace_ms, 'returnCode': rc,
                                'rows': parse(output)}, indent=2) + '\n')
    if rc or len(parse(output)) != a.count:
        raise SystemExit('device cadence incomplete')


def stop_watch_driver(process, pid, task_tag='T-DYPREP'):
    """Stop only the captured task class, before disconnecting the adb shell."""
    owner = Path('/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/device/DEVICE_OWNER')
    if owner.read_text().strip() != task_tag:
        raise RuntimeError('T-DYPREP device ownership required')
    if pid is not None and isinstance(pid, int) and pid > 1:
        p = subprocess.run(['adb', '-s', 'e3aca8af', 'shell', 'cat', f'/proc/{pid}/cmdline'], capture_output=True)
        if p.returncode == 0 and b'DyPrepCadence' in p.stdout:
            subprocess.run(['adb', '-s', 'e3aca8af', 'shell', 'kill', str(pid)], check=True, capture_output=True)
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
