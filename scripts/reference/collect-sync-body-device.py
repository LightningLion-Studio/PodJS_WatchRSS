#!/usr/bin/env python3
"""Collect the completed SyncBodyReferenceTest capture without running another test."""
from pathlib import Path
import argparse,json,hashlib,subprocess
parser=argparse.ArgumentParser();parser.add_argument('--serial',required=True);args=parser.parse_args()
app=Path(__file__).resolve().parents[2]
desktop=json.loads((app/'tests/fixtures/sync-body-native.json').read_text())
for path,digest in desktop['sources'].items():
 assert hashlib.sha256((app.parent/path).read_bytes()).hexdigest()==digest,'Native source changed; recapture the JVM corpus first'
raw=subprocess.check_output(['adb','-s',args.serial,'exec-out','cat','/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-sync-body.json'])
device=json.loads(raw);assert len(device['cases'])==len(desktop['cases'])
for row,original in zip(device['cases'],desktop['cases']):
 assert row['jsonBase64']==original['jsonBase64'],'Native device input differs from current corpus'
 assert row['decoded']==original['decoded'],'Native device decoding differs from current corpus'
 row['input']=original['input']
device['sources']=desktop['sources'];device['jsonCases']=desktop['jsonCases'];device['parserCorpusProvenance']='Desktop JVM unchanged native sources; body compressed bytes captured on OWW242.'
(app/'artifacts/reference-sync-body-device.json').write_bytes(raw)
(app/'tests/fixtures/sync-body-android.json').write_text(json.dumps(device,ensure_ascii=True,indent=2)+'\n')
framework=Path(json.loads((app/'framework.lock.json').read_text())['path'])
asset=framework/'platforms/android/runtime/src/androidTest/assets/gzip-native-reference.json'
asset.parent.mkdir(exist_ok=True,parents=True)
asset.write_text(json.dumps({'sources':desktop['sources'],'sdk':device['sdk'],'device':device['device'],'cases':[{key:r[key] for key in ['encodedBase64','jsonBase64']} for r in device['cases']]}))
print(f'Collected {len(device["cases"])} native Android body encodings from {device["device"]}; no test or install was repeated.')
