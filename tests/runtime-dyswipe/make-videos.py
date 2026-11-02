#!/usr/bin/env python3
"""Create eight local H.264/AAC fixtures; never contacts a service."""
import argparse,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('out',type=Path);args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True)
colors=['red','green','blue','yellow','cyan','magenta','orange','purple']
for i,color in enumerate(colors):
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i',f'color=c={color}:s=240x240:r=24:d=12','-f','lavfi','-i',f'sine=frequency={440+i*40}:duration=12','-vf',f'drawtext=text=FIXTURE {i}:x=(w-tw)/2:y=(h-th)/2:fontsize=24:fontcolor=white','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(args.out/f'swipe-{i}.mp4')],check=True)
