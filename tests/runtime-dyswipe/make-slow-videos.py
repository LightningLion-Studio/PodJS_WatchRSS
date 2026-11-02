#!/usr/bin/env python3
"""Generate identical 12s AVC/AAC media with tail/front moov atoms."""
import argparse,subprocess,json,struct,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('out',type=Path);a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=s=240x240:r=24:d=12','-f','lavfi','-i','sine=frequency=440:duration=12','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-b:v','2500k','-minrate','2500k','-maxrate','2500k','-bufsize','2500k','-x264-params','nal-hrd=cbr:force-cfr=1','-g','24','-c:a','aac','-shortest',str(a.out/'tail.mp4')],check=True)
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(a.out/'tail.mp4'),'-c','copy','-movflags','+faststart',str(a.out/'front.mp4')],check=True)
rows=[]
for name in ('front','tail'):
 data=(a.out/(name+'.mp4')).read_bytes();atoms=[];offset=0
 while offset+8<=len(data):
  n,kind=struct.unpack('>I4s',data[offset:offset+8]);atoms.append(dict(type=kind.decode(),offset=offset,size=n));offset+=n
 rows.append(dict(layout=name,size=len(data),sha256=hashlib.sha256(data).hexdigest(),atoms=atoms))
(a.out/'manifest.json').write_text(json.dumps(rows,indent=2)+'\n')
