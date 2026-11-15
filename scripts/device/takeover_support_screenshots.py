#!/usr/bin/env python3
"""Capture production native support widgets on a caller-owned, isolated emulator only."""
import argparse
import json
import hashlib
import math
from pathlib import Path
import re
import struct
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = 'com.lightningstudio.watchrss.podjs.supportrehearsal'
ACTIVITY = PACKAGE + '/dev.podjs.runtime.SupportUiFixtureActivity'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--adb', required=True)
    parser.add_argument('--apkanalyzer', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--server-port', type=int, required=True)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--screens', default='blocked-466,paused-466,preview-466,consent-466,success-466,unknown-466')
    args = parser.parse_args()
    if args.serial != 'emulator-5586' or args.server_port != 5056:
        raise SystemExit('only this task-owned emulator-5586 / isolated server 5056 is allowed')
    def run(*command, binary=False):
        return subprocess.check_output(command, text=not binary, timeout=60)
    def adb(*command, binary=False):
        return run(args.adb, '-P', str(args.server_port), '-s', args.serial, *command, binary=binary)
    if adb('shell', 'getprop', 'ro.kernel.qemu').strip() != '1':
        raise SystemExit('physical devices are forbidden')
    if run(args.apkanalyzer, 'manifest', 'application-id', str(args.apk)).strip() != PACKAGE:
        raise SystemExit('wrong fixture package')
    if 'android.permission.INTERNET' in run(args.apkanalyzer, 'manifest', 'permissions', str(args.apk)):
        raise SystemExit('fixture must have no INTERNET permission')
    args.out.mkdir(parents=True, exist_ok=True)
    adb('install', '-r', str(args.apk))
    previous=args.out/'screenshots.json'
    results=json.loads(previous.read_text()) if previous.exists() else []
    selected=set(args.screens.split(','))
    apk_sha=hashlib.sha256(args.apk.read_bytes()).hexdigest()
    def dump():
        adb('shell', 'uiautomator', 'dump', '/sdcard/takeover-support-ui.xml')
        return adb('exec-out', 'cat', '/sdcard/takeover-support-ui.xml')
    def capture(name, screen, size=466, scroll=False):
        if name not in selected:
            return
        print('Capturing '+name,flush=True)
        current=adb('shell','wm','size')
        if re.findall(r'\d+x\d+',current)[-1] != f'{size}x{size}':
            adb('shell', 'wm', 'size', f'{size}x{size}')
        density='320' if size==466 else '160'
        if re.findall(r'\d+',adb('shell','wm','density'))[-1] != density:
            adb('shell', 'wm', 'density', density)
        adb('shell', 'am', 'force-stop', PACKAGE)
        adb('shell', 'am', 'start', '-W', '-n', ACTIVITY, '--es', 'screen', screen)
        time.sleep(1)
        if scroll:
            for _ in range(5):
                adb('shell', 'input', 'swipe', str(size//2), str(size*4//5), str(size//2), str(size//5), '200')
        xml = dump()
        if screen == 'success':
            deadline = time.monotonic() + 15
            while '日志编号：123456' not in xml and time.monotonic() < deadline:
                time.sleep(.3)
                xml = dump()
            if '日志编号：123456' not in xml:
                raise AssertionError('fake receiver success receipt absent')
            # Center the receipt as a user scrolls to read/share its number on the round viewport.
            adb('shell','input','swipe',str(size//2),str(size//3),str(size//2),str(size//3+size//5),'800')
            xml=dump()
        png = adb('exec-out', 'screencap', '-p', binary=True)
        width, height = struct.unpack('>II', png[16:24])
        (args.out/(name+'.png')).write_bytes(png)
        (args.out/(name+'.xml')).write_text(xml)
        buttons = []
        if screen in ('blocked', 'paused'):
            for text in ('重试迁移', '上传日志'):
                nodes = [n for n in ET.fromstring(xml).iter('node') if n.attrib.get('text') == text]
                if len(nodes) != 1:
                    raise AssertionError(f'missing unique button {text}')
                bounds = list(map(int, re.findall(r'\d+', nodes[0].attrib['bounds'])))
                x1,y1,x2,y2 = bounds
                inside = all(math.hypot(x-width/2,y-height/2) <= min(width,height)/2-2+1e-6
                             for x in (x1,x2) for y in (y1,y2))
                if not inside:
                    raise AssertionError(f'button outside circle: {text} {bounds} viewport={width}x{height}')
                buttons.append({'label':text,'bounds':bounds,'fourCornersInside':inside,'enabled':nodes[0].attrib.get('enabled')})
            if buttons[0]['bounds'][3] >= buttons[1]['bounds'][1]:
                raise AssertionError('buttons are not vertically stacked')
        if screen == 'unknown':
            texts = [n.attrib.get('text', '') for n in ET.fromstring(xml).iter('node')]
            if '正在检查数据' not in texts or any(label in ' '.join(texts) for label in ('迁移未完成', 'unknown_user_files', '上传日志', '重试迁移', '无法识别')):
                raise AssertionError('legacy unknown file state leaked a failure notice')
        results[:]=[row for row in results if row['name'] != name]
        results.append({'apkSha256':apk_sha,'name':name,'screen':screen,'requestedSize':size,'width':width,'height':height,'viewportMatched':width==size and height==size,'buttons':buttons,'receiver':'local fake; INTERNET permission absent'})
        previous.write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
        print('Captured '+name,flush=True)
    try:
        capture('blocked-466','blocked')
        capture('paused-466','paused')
        capture('preview-466','preview')
        capture('consent-466','preview',scroll=True)
        capture('success-466','success')
        capture('unknown-466','unknown')
        capture('blocked-192','blocked',size=192)
        (args.out/'screenshots.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
        (args.out/'fixture-logcat.txt').write_text(adb('logcat','-d','-s','TakeoverSupportFixture:I','AndroidRuntime:E','*:S'))
    finally:
        adb('shell', 'am', 'force-stop', PACKAGE)
        adb('uninstall', PACKAGE)
    print(json.dumps({'screenshots':len(results),'physicalDevicesAccessed':False,'onlineUploads':0}))

if __name__ == '__main__':
    main()
