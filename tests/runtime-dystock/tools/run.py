from pathlib import Path
import subprocess,json,time,re,sys
R=Path(sys.argv[1]).resolve();TOOLS=Path(__file__).resolve().parent;PKG='com.lightningstudio.watchrss.podjs'
def adb(*a):return subprocess.run(['adb','-s','emulator-5560',*a],capture_output=True,text=True,timeout=15).stdout.strip()
def phase(n,p,a,online):
 tmp=R/'phase.pending';tmp.write_text(json.dumps(dict(run=n,phase=p,action=a,online=online)));tmp.replace(R/'phase.json')
def events(n,pid=None):
 return [x for l in (R/'events.jsonl').read_text().splitlines() if (x:=json.loads(l)).get('run')==n and (pid is None or x['pid']==pid)]
def wait(fn,timeout=30):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  if (R/'ABORT.json').exists():raise RuntimeError('guard_abort')
  x=fn()
  if x:return x
  time.sleep(.15)
 raise TimeoutError('condition_timeout')
def shot(name):
 with (R/name).open('wb') as f:subprocess.run(['adb','-s','emulator-5560','exec-out','screencap','-p'],stdout=f,check=True)
def sample():
 p=subprocess.run([sys.executable,str(TOOLS/'sample-playback.py'),str(R)],capture_output=True,text=True,timeout=15)
 return json.loads(p.stdout)
def start(n):
 old=adb('shell','pidof',PKG);adb('shell','am','force-stop',PKG)
 phase(n,'cold','airplane_enable',False);adb('shell','cmd','connectivity','airplane-mode','enable');adb('shell','svc','data','disable')
 def net():
  w=adb('shell','cmd','wifi','status').splitlines()[0];c=adb('shell','dumpsys','connectivity');return dict(wifi=w,default_network='none') if w=='Wifi is disabled' and 'Active default network: none' in c else None
 state=wait(net,20);phase(n,'cold','open_douyin_offline',False)
 subprocess.run(['/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/tools/emu-douyin.sh','open-douyin','5560'],check=True,stdout=subprocess.DEVNULL)
 pid=int(wait(lambda:adb('shell','pidof',PKG)))
 if str(pid)==old:raise RuntimeError('not_fresh_process')
 wait(lambda:any('startup_stage=entry_mounted' in x['message'] for x in events(n,pid)),30)
 wait(lambda:any('startup_stage=stock_saved' in x['message'] and 'slots=3' in x['message'] for x in events(n,pid)),30)
 phase(n,'cold','tap_enter_stock_playback',False);tap=time.time();clock_offset=time.time()-time.monotonic();adb('shell','input','tap','233','360')
 first=wait(lambda:next((x for x in events(n,pid) if 'cache_first_card' in x['message']),None),30)
 shot(f'run-{n:02}-first.png');samples=[sample()];shot(f'run-{n:02}-progress.png')
 (R/f'run-{n:02}-start.json').write_text(json.dumps(dict(run=n,pid=pid,previous_pid=old,network=state,tap_epoch=tap,host_clock_offset=clock_offset,cache_first_card=first,samples=samples),indent=2)+'\n')
 print(json.dumps(dict(run=n,pid=pid,network=state,cache_first_card=first['message'],sample=samples[0])),flush=True)
 end=time.monotonic()+26
 while time.monotonic()<end:
  samples.append(sample());time.sleep(.6)
 shot(f'run-{n:02}-end.png')
 (R/f'run-{n:02}-samples.json').write_text(json.dumps(samples,indent=2)+'\n')
 print(json.dumps(dict(run=n,observed_end=True,sample=samples[-1])),flush=True)


def refill(n):
 adb('shell','am','force-stop',PKG);phase(n,'refill','home_idle_online',True)
 adb('shell','cmd','connectivity','airplane-mode','disable');adb('shell','cmd','wifi','set-wifi-enabled','enabled')
 def net():
  w=adb('shell','cmd','wifi','status').splitlines()[0];c=adb('shell','dumpsys','connectivity');return dict(wifi=w,default_network='active') if w=='Wifi is enabled' and re.search(r'Active default network: \d+',c) else None
 state=wait(net,30);adb('shell','am','start','-n',PKG+'/dev.podjs.androidwatch.MainActivity');pid=int(wait(lambda:adb('shell','pidof',PKG)))
 wait(lambda:any(x.get('phase')=='refill' and 'startup_stage=stock_saved' in x['message'] and 'slots=3' in x['message'] for x in events(n,pid)),60)
 shot(f'run-{n:02}-refill.png');row=dict(run=n,pid=pid,network=state,stock=3);(R/f'run-{n:02}-refill.json').write_text(json.dumps(row,indent=2)+'\n');print(json.dumps(row),flush=True)

if __name__=='__main__':
 action=sys.argv[2]
 if action=='cold':start(int(sys.argv[3]))
 elif action=='refill':refill(int(sys.argv[3]))
 elif action=='suite':
  for n in range(1,11):refill(n-1);start(n)
  refill(10)
 else:raise ValueError('expected cold, refill or suite')
