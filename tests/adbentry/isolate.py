#!/usr/bin/env python3
"""Reject non-loopback traffic for the fixture UID, preserving ADB transport."""
import json,os,re,subprocess,sys
from pathlib import Path
adb=str(Path(os.environ['ANDROID_SDK_ROOT'])/'platform-tools/adb');serial=sys.argv[1]
if not re.fullmatch(r'emulator-[0-9]+',serial):raise SystemExit('emulator required')
def run(*args):return subprocess.check_output([adb,'-s',serial,*args],text=True,stderr=subprocess.STDOUT,timeout=30)
assert run('emu','avd','name').splitlines()[0].startswith('ADBENTRY_')
package='com.lightningstudio.watchrss.adbentry'
rows=run('shell','pm','list','packages','-U',package)
match=re.search(r'^package:'+re.escape(package)+r' uid:(\d+)$',rows,re.M)
if not match:raise SystemExit('exact fixture UID required')
uid=match.group(1)
for binary in ['iptables','ip6tables']:
 run('shell',f'su 0 {binary} -I OUTPUT 1 -m owner --uid-owner {uid} ! -o lo -j REJECT')
print(json.dumps({'avd':'ADBENTRY_Watch_API35_20261115','serial':serial,'package':package,'uid':int(uid),'rule':'IPv4/IPv6 OUTPUT uid !lo REJECT'}))
