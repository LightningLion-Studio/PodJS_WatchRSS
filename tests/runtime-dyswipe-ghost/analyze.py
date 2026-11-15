#!/usr/bin/env python3
"""Inspect every recorded frame. White 48x48 fiducials must remain square.

Reject repeated source colours in three distinct page bands (stationary copy),
nonuniform fiducials, and missing moving samples. Partial/cropped squares are
reported but excluded from the aspect assertion. Uses only a local MP4.
"""
import argparse,json
from pathlib import Path
import cv2,numpy as np
cv2.setNumThreads(1)
p=argparse.ArgumentParser();p.add_argument('recording',type=Path);p.add_argument('output',type=Path);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
video=cv2.VideoCapture(str(a.recording));fps=video.get(cv2.CAP_PROP_FPS);rows=[];bad=[];full=0;moving=0;selected=[]
while True:
 ok,bgr=video.read()
 if not ok:break
 n=len(rows);rgb=cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB);h,w=rgb.shape[:2]
 # Colour centres are away from controls and exclude the white fiducial.
 labels=[]
 for colour in [(32,80,192),(192,64,32),(32,128,64)]:
  d=np.max(np.abs(rgb.astype(np.int16)-colour),axis=2);mask=(d<24).astype(np.uint8)
  count,cc,stats,centroids=cv2.connectedComponentsWithStats(mask,8)
  bands=[list(map(int,stats[i])) for i in range(1,count) if stats[i,cv2.CC_STAT_AREA]>w*h*.025]
  labels.append(bands)
  if len(bands)>2:bad.append({'frame':n,'reason':'three_source_regions','bands':bands})
 if sum(bool(b) for b in labels)>2:bad.append({'frame':n,'reason':'unselected_third_page'})
 # Black control gradients dim white without changing its channel neutrality.
 white=((np.min(rgb,axis=2)>45)&(np.max(rgb,axis=2)-np.min(rgb,axis=2)<20)).astype(np.uint8);count,cc,stats,centroids=cv2.connectedComponentsWithStats(white,8)
 squares=[]
 for x,y,bw,bh,area in stats[1:]:
  if min(bw,bh)<20 or area<350 or area/(bw*bh)<.86:continue
  # Ignore native watch corner icons and clipped fiducials at screen edges.
  if x<5 or y<5 or x+bw>w-5 or y+bh>h-5:continue
  def background_id(pixel):
   pixel=pixel.astype(float)
   if pixel.max()<12:return -1
   normalized=pixel/pixel.max()
   colours=np.array([(32,80,192),(192,64,32),(32,128,64)],dtype=float)
   colours/=colours.max(axis=1)[:,None]
   distances=np.max(np.abs(colours-normalized),axis=1)
   best=int(np.argmin(distances));return best if distances[best]<.22 else -1
  # Page occlusion clips a square at an internal edge, as does screen clipping.
  neighbours=[background_id(rgb[yy,xx]) for xx,yy in [(max(0,x-6),y+bh//2),(min(w-1,x+bw+6),y+bh//2),(x+bw//2,max(0,y-6)),(x+bw//2,min(h-1,y+bh+6))]]
  if len(set(neighbours))!=1 or neighbours[0]<0:continue
  ratio=bw/bh;squares.append([int(x),int(y),int(bw),int(bh),round(ratio,4)]);full+=1
  if abs(ratio-1)>.07:bad.append({'frame':n,'reason':'stretched_fiducial','box':squares[-1]})
  if abs((y+bh/2)-h/2)>12:moving+=1
 rows.append({'frame':n,'seconds':round(n/fps,4),'squares':squares,'colourBands':labels})
 if squares and len(selected)<12 and (not selected or n-selected[-1]>fps*.45):
  cv2.imwrite(str(a.output/f'frame-{n:04d}.png'),bgr);selected.append(n)
result={'frames':len(rows),'fps':fps,'fullFiducials':full,'movingFiducials':moving,'violations':bad,'samples':rows}
(a.output/'frames.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='samples'},indent=2))
assert len(rows)>60 and full>30 and moving>5 and not bad,'recording failed ghost/aspect checks'
