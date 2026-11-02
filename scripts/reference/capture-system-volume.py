#!/usr/bin/env python3
"""Capture the real Android AudioManager contract from the native Robolectric test XML."""
import argparse,hashlib,json,xml.etree.ElementTree as ET
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('xml',type=Path);p.add_argument('source',type=Path);a=p.parse_args()
root=ET.parse(a.xml).getroot();assert int(root.attrib['failures'])==0 and int(root.attrib['errors'])==0
lines=''.join(root.find('system-out').itertext()).splitlines();rows=[line.removeprefix('SYSTEM_VOLUME_FIXTURE=')for line in lines if line.startswith('SYSTEM_VOLUME_FIXTURE=')];assert len(rows)==1
out=Path(__file__).resolve().parents[2]/'tests/fixtures/system-volume-native.json'
out.write_text(json.dumps({'source':'PodVideoSystemAudioTest.java / Robolectric AudioManager','sourceSha256':hashlib.sha256(a.source.read_bytes()).hexdigest(),'method':'native AudioManager STREAM_MUSIC state; no physical audio proof','cases':json.loads(rows[0])},indent=2)+'\n')
print('Captured system volume cases:',len(json.loads(rows[0])))
