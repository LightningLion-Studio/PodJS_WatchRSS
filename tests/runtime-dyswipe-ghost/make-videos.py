#!/usr/bin/env python3
"""Offline AVC clips with square fiducials for detecting anisotropic scaling."""
import argparse,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('out',type=Path);a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
for i,(w,h,color) in enumerate([(320,180,'0x2050c0'),(180,320,'0xc04020'),(240,240,'0x208040')]):
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i',f'color=c={color}:s={w}x{h}:r=30:d=8','-vf',f'drawbox=x=(iw-48)/2:y=(ih-48)/2:w=48:h=48:color=white:t=fill','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-an',str(a.out/f'ghost-{i}.mp4')],check=True)
