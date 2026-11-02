#!/usr/bin/env python3
import subprocess,struct,json,hashlib,sys
from pathlib import Path
out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
base=out/'tail.mp4'
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x480:rate=24','-f','lavfi','-i','sine=frequency=660:sample_rate=44100','-t','20','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-b:v','2500k','-minrate','2500k','-maxrate','2500k','-bufsize','1000k','-x264-params','nal-hrd=cbr:force-cfr=1','-g','24','-c:a','aac','-b:a','64k',str(base)],check=True)
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(base),'-c','copy','-movflags','+faststart',str(out/'head.mp4')],check=True)
data=base.read_bytes();position=0
while position<len(data):
 size,kind=struct.unpack_from('>I4s',data,position)
 if kind==b'moov':
  assert position+size==len(data),'fixture expects tail moov'
  free=struct.pack('>I4s',800*1024,b'free')+bytes(800*1024-8)
  large=data[:position]+struct.pack('>I4s',size+len(free),b'moov')+data[position+8:]+free
  (out/'large-moov.mp4').write_bytes(large);break
 assert size>=8;position+=size
else:raise RuntimeError('moov missing')
records=[]
for name in ['head.mp4','tail.mp4','large-moov.mp4']:
 path=out/name;raw=path.read_bytes();boxes=[];offset=0
 while offset<len(raw):
  size,kind=struct.unpack_from('>I4s',raw,offset);assert size>=8;boxes.append({'type':kind.decode(),'offset':offset,'bytes':size});offset+=size
 probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(path)],text=True))
 records.append({'name':name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'boxes':boxes,'duration':float(probe['format']['duration'])})
(out/'manifest.json').write_text(json.dumps(records,indent=2)+'\n')
print(json.dumps([{'name':r['name'],'bytes':r['bytes'],'moov':[b for b in r['boxes'] if b['type']=='moov'][0]} for r in records]))
