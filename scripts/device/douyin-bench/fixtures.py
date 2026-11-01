"""Generate tiny synthetic recorded logcat and lossless MP4; no device access."""
import json
from pathlib import Path
import subprocess
from bench import write_json
from analyzers import parse_log


def generate(out):
    from PIL import Image, ImageDraw
    out=Path(out)
    out.mkdir(parents=True,exist_ok=False)
    epoch=1800000000000
    raw=[]
    # 30 correlated prewarmed next swipes, one deliberately slow tail.
    for i in range(30):
        base=1000+i*1000
        for code,offset,extra in [('gesture_down',0,''),('gesture_release',200,'direction=next prewarmed=true generation=2'),
                                  ('previous_audio_stopped',230,'backend=mixer'),
                                  ('incoming_first_frame',450 if i==29 else 250,'generation=2')]:
            raw.append(f'   {(epoch+base+offset)/1000:.3f} 101 102 I DYBENCH: code={code} seq={i} mono_ms={base+offset} {extra}')
    for offset in range(0,33000,1000):
        raw.append(f'   {(epoch+offset)/1000:.3f} 103 104 I DYBENCH: code=restore_state state=idle mono_ms={offset}')
    raw.extend([f'{epoch/1000:.3f} 101 102 I PodBrowserAuth: code=requested',
                f'{(epoch+100)/1000:.3f} 101 102 W PodBrowserAuth: code=browser_script_error',
                f'{(epoch+200)/1000:.3f} 101 102 I PodBrowserAuth: code=qr_ready',
                f'{(epoch+300)/1000:.3f} 101 102 I PodBrowserAuth: code=completed',
                f'{(epoch+400)/1000:.3f} 101 102 I PodBrowserAuth: code=service_closed'])
    raw.sort(key=lambda line:float(line.split()[0]))
    (out/'logcat.synthetic.txt').write_text('\n'.join(raw)+'\n')
    (out/'events.jsonl').write_text(''.join(json.dumps(e)+'\n' for line in raw if (e:=parse_log(line))))
    write_json(out/'manifest.json',{'scenario':'next','restore':'idle','start_ms':epoch+1000,'end_ms':epoch+32000,
                                     'log_complete':True,'screen_restored':True,'synthetic':True})
    gfx='---PROFILEDATA---\nFlags,IntendedVsync,Vsync,FrameCompleted,\n'
    gfx+=''.join(f'0,{i*20000000+1},{i*20000000+1},{i*20000000+10000001},\n' for i in range(30))
    gfx+='---PROFILEDATA---\n'
    (out/'gfx.txt').write_text(gfx)
    (out/'memory.jsonl').write_text(''.join(json.dumps({'pid':101,'role':'app','t_ms':epoch+i*60000,'pss_kib':102400+i*1024})+'\n' for i in range(6)))
    previous=Image.new('RGB',(64,64),(160,50,30))
    incoming=Image.new('RGB',(64,64),(30,60,180))
    previous.save(out/'previous.png')
    incoming.save(out/'incoming.png')
    template=Image.new('RGB',(32,32),(35,35,35))
    ImageDraw.Draw(template).arc((3,3,28,28),20,290,fill='white',width=3)
    template.save(out/'spinner.png')
    frames=[]
    offsets={}
    for i in range(12):
        image=previous.copy()
        if 2<=i<=5:
            shift=(i-1)*12
            image=Image.new('RGB',(64,64))
            image.paste(previous.crop((0,shift,64,64)),(0,0))
            image.paste(incoming.crop((0,0,64,shift)),(0,64-shift))
            offsets[str(i)]=shift/64
        elif i==6:
            image=Image.new('RGB',(64,64),'black')
        elif i>=7:
            image=incoming.copy()
            if i==8:
                image.paste(template,(16,16))
        frames.append(image)
    proc=subprocess.run(['ffmpeg','-v','error','-f','rawvideo','-pix_fmt','rgb24','-s','64x64',
                         '-r','30','-i','pipe:0','-an','-c:v','libx264rgb','-crf','0',
                         str(out/'clip-000.mp4')],input=b''.join(frame.tobytes() for frame in frames),capture_output=True)
    if proc.returncode:
        raise RuntimeError('synthetic screenrecord encoding failed: '+proc.stderr.decode())
    calibration={'content_roi':[0,0,1,1],'spinner_roi':[.25,.25,.75,.75],
                 'template':'spinner.png','previous':'previous.png','incoming':'incoming.png','offsets':offsets,
                 'human_reviewed':False,'sync_error_ms':0,'spinner_mae':8,'strip_mae':3}
    write_json(out/'calibration.json',calibration)
    from video import analyze_clip
    write_json(out/'clip-000.analysis.json',analyze_clip(out/'clip-000.mp4',out/'calibration.json'))
    (out/'SYNTHETIC.txt').write_text('Generated analyzer fixtures. No device, user account, actual audio or real performance evidence.\n')
