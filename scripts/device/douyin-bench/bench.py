#!/usr/bin/env python3
"""DYBENCH. Default commands are offline. Only `run --execute` can contact ADB."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from analyzers import METRICS, parse_log, meminfo, audio_state, evaluate

HERE = Path(__file__).resolve().parent
DEFAULT_OWNER = Path('/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/device/DEVICE_OWNER')
PACKAGES = {'com.lightningstudio.watchrss','com.lightningstudio.watchrss.podjs'}
SCREEN_KEYS = ('screen_brightness','screen_brightness_mode','screen_off_timeout')
GESTURES = {'next': (233,330,233,130,260), 'prev': (233,130,233,330,260),
            'cancel': (233,280,233,260,400), 'soak': (233,330,233,130,260)}


def write_json(path, value):
    path = Path(path)
    temp = path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    os.replace(temp,path)


def read_jsonl(path):
    path = Path(path)
    return [json.loads(s) for s in path.read_text().splitlines() if s.strip()] if path.exists() else []


def now():
    return time.time()*1000


class Device:
    """Fixed serial, runtime owner check before EVERY device command, no phone/install API."""
    def __init__(self, owner, owner_file=DEFAULT_OWNER, package='com.lightningstudio.watchrss'):
        if package not in PACKAGES or not re.fullmatch(r'wrss-[a-z0-9-]+', owner):
            raise ValueError('explicit wrss owner and known package required')
        self.owner, self.owner_file, self.package = owner, Path(owner_file), package

    def guard(self):
        if self.owner_file.read_text().strip() != self.owner:
            raise PermissionError('DEVICE_OWNER does not name this operator; stop, do not claim/release ownership')

    def call(self, args, timeout=20):
        self.guard()
        return subprocess.run(['adb','-s','e3aca8af',*args],check=True,capture_output=True,text=True,timeout=timeout).stdout

    def setting(self,key,value=None):
        if key not in SCREEN_KEYS:
            raise ValueError('screen settings only')
        if value is None:
            return self.call(['shell','settings','get','system',key]).strip()
        if value == 'null':
            return self.call(['shell','settings','delete','system',key])
        if not re.fullmatch(r'\d+',str(value)):
            raise ValueError('numeric setting required')
        return self.call(['shell','settings','put','system',key,str(value)])

    def key(self,code):
        if code not in (223,224):
            raise ValueError('sleep/wake only')
        self.call(['shell','input','keyevent',str(code)])

    def swipe(self,kind):
        if kind not in GESTURES:
            raise ValueError('only calibrated center swipe gestures')
        self.call(['shell','input','swipe',*[str(n) for n in GESTURES[kind]]])

    def dumps(self,service,*args):
        allowed = {'audio':(), 'media.audio_flinger':(), 'power':(),
                   'gfxinfo':(self.package,'framestats')}
        if service=='meminfo' and len(args)==1 and str(args[0]).isdigit():
            pass
        elif service not in allowed or args != allowed[service]:
            raise ValueError('unsupported read-only dump')
        return self.call(['shell','dumpsys',service,*map(str,args)])

    def processes(self):
        return self.call(['shell','ps','-A','-o','PID,PPID,NAME'])

    def logcat(self):
        self.guard()
        return subprocess.Popen(['adb','-s','e3aca8af','logcat','-v','epoch','-T','1',
                                 'PodBrowserAuth:I','DYBENCH:I','PodJSCloudWorker:I','*:S'],stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL,text=True,bufsize=1)

    def recording(self,remote):
        if not re.fullmatch(r'/sdcard/dybench-[a-f0-9]+\.mp4',remote):
            raise ValueError('only harness-created video path')
        self.guard()
        return subprocess.Popen(['adb','-s','e3aca8af','shell','screenrecord','--time-limit','7',
                                 '--bit-rate','500000',remote],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

    def remove_video(self,remote):
        if not re.fullmatch(r'/sdcard/dybench-[a-f0-9]+\.mp4',remote):
            raise ValueError('only own video')
        self.call(['shell','rm','-f',remote])

    def fetch_video(self,remote,path):
        if not re.fullmatch(r'/sdcard/dybench-[a-f0-9]+\.mp4',remote):
            raise ValueError('only own video')
        try:
            self.call(['pull',remote,str(path)])
        finally:
            self.remove_video(remote)


class Screen:
    """Persist original values before changes. Restore even after SIGINT/failed collection."""
    def __init__(self,device,out):
        self.device,self.out = device,Path(out)
        self.original = {}
        self.journal = {'restored':False,'original':{},'restore_errors':[]}

    def __enter__(self):
        self.original = {key:self.device.setting(key) for key in SCREEN_KEYS}
        self.journal['original'] = self.original
        write_json(self.out/'screen.json',self.journal)
        try:
            self.device.setting('screen_brightness_mode','0')
            self.device.setting('screen_brightness','10')
            timeout = self.original['screen_off_timeout']
            if timeout == 'null' or int(timeout)>120000:
                self.device.setting('screen_off_timeout','30000')
            return self
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def __exit__(self,*exc):
        expected = dict(self.original)
        if expected.get('screen_off_timeout') != 'null' and int(expected.get('screen_off_timeout','0'))>120000:
            expected['screen_off_timeout']='30000'
            self.journal['long_timeout_normalized']=True
        for key,value in expected.items():
            try:
                self.device.setting(key,value)
            except Exception as error:
                self.journal['restore_errors'].append(type(error).__name__+':'+key)
        try:
            self.device.key(223)
            actual = {key:self.device.setting(key) for key in SCREEN_KEYS}
            self.journal['actual'] = actual
            self.journal['restored'] = actual == expected and not self.journal['restore_errors']
        except Exception as error:
            self.journal['restore_errors'].append(type(error).__name__)
        write_json(self.out/'screen.json',self.journal)


class Collector:
    def __init__(self,device,out):
        self.device,self.out=device,Path(out)
        self.stop=threading.Event()
        self.events=[]
        self.log_ok=False
        self.failures=[]

    def __enter__(self):
        self.proc=self.device.logcat()
        self.log_thread=threading.Thread(target=self.logs,daemon=True)
        self.sample_thread=threading.Thread(target=self.samples,daemon=True)
        self.log_thread.start()
        self.sample_thread.start()
        return self

    def logs(self):
        try:
            with (self.out/'events.jsonl').open('w') as f:
                for line in self.proc.stdout:
                    event=parse_log(line)
                    if event:
                        self.events.append(event)
                        f.write(json.dumps(event)+'\n')
                        f.flush()
        except Exception as error:
            self.failures.append('log:'+type(error).__name__)

    def samples(self):
        with (self.out/'memory.jsonl').open('w') as mem, (self.out/'audio.jsonl').open('w') as aud:
            while not self.stop.is_set():
                try:
                    for line in self.device.processes().splitlines()[1:]:
                        if self.stop.is_set():
                            break
                        cols=line.split()
                        if len(cols)<3 or not cols[0].isdigit():
                            continue
                        pid,ppid,name=cols[:3]
                        if not (name==self.device.package or name.startswith(self.device.package+':') or
                                'sandboxed_process' in name or 'webview' in name.lower()):
                            continue
                        role='app' if name==self.device.package else 'app_child' if name.startswith(self.device.package+':') else 'renderer_candidate'
                        start=now()
                        value=meminfo(self.device.dumps('meminfo',pid))
                        mem.write(json.dumps({'t_ms':start,'pid':int(pid),'role':role,'pss_kib':value})+'\n')
                        mem.flush()
                    started=now()
                    raw=self.device.dumps('audio')
                    flinger=self.device.dumps('media.audio_flinger')
                    aud.write(json.dumps({'t_ms':started,'end_ms':now(),'audio':audio_state(raw),
                                          'flinger_bytes':len(flinger),'flinger':audio_state(flinger),'actual_output':'PENDING'})+'\n')
                    aud.flush()
                except Exception as error:
                    self.failures.append('sample:'+type(error).__name__)
                self.stop.wait(5)

    def __exit__(self,*exc):
        self.stop.set()
        self.log_ok=self.proc.poll() is None and self.log_thread.is_alive()
        self.proc.terminate()  # own HOST adb client only; no signal sent to the app
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.log_thread.join(timeout=5)
        self.sample_thread.join(timeout=45)
        self.proc.stdout.close()
        if self.sample_thread.is_alive():
            self.failures.append('sample thread did not stop')
        write_json(self.out/'collector.json',{'log_complete':self.log_ok and not self.failures,
                                            'failures':self.failures,'events':len(self.events)})


def prompt(device,text,*,awake=False):
    if not awake:
        device.key(223)
    value=input(text+'\n> ').strip()
    device.guard()
    if not awake:
        device.key(224)
    return value


def require_player(events,stamp):
    visible=[e for e in events if e.get('tag')=='DYBENCH' and e.get('code')=='player_visible']
    if not visible or visible[-1].get('state')!='present' or not 0 <= stamp-visible[-1]['t_ms'] <= 2000:
        raise RuntimeError('fresh player_visible heartbeat required before swipe/record; stop on unknown UI')
    if any(e.get('tag')=='PodBrowserAuth' and e.get('code')=='requested' and e['t_ms']>=visible[-1]['t_ms'] for e in events):
        raise RuntimeError('auth dialog active; no swipe or video capture')


def run(args):
    if not args.execute:
        raise ValueError('live run requires --execute; use plan or dry-run offline')
    if args.record and args.scenario not in GESTURES and args.scenario!='fling':
        raise ValueError('recording allowed only for swipe scenarios; never record login/QR')
    if args.scenario=='logout' and not args.allow_logout:
        raise ValueError('logout requires runtime --allow-logout AND typed approval')
    thresholds=json.loads((HERE/'thresholds.json').read_text())
    n=thresholds['scenarios'][args.scenario]['n']
    if args.count is not None:
        n=args.count
    if n<1 or n>200:
        raise ValueError('count must be 1..200; undersized runs remain PENDING')
    out=Path(args.out).resolve()
    out.mkdir(parents=True,exist_ok=False,mode=0o700)
    device=Device(args.owner,package=args.package)
    device.guard()
    import fcntl
    lock=(Path('/tmp')/'dybench-e3aca8af.lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    manifest={'scenario':args.scenario,'restore':args.restore,'package':args.package,'n_planned':n,
              'start_ms':now(),'end_ms':now(),'synthetic':False,'log_complete':False,
              'screen_restored':False,'device_acceptance':'PENDING','renderer_attribution':False,
              'network':'SKIPPED: no verified safe watch-only throttling control; no network mutation',
              'recording':args.record,'operator':args.owner,'trials':[]}
    write_json(out/'thresholds.json',thresholds)
    write_json(out/'manifest.json',manifest)
    screen=Screen(device,out)
    try:
        with screen, Collector(device,out) as collector:
            answer=prompt(device,'Owner: compare current home against s4-k8-home-after-cold.png.\n'
                          'Confirm physical 466x466 layout and center-swipe region free of action buttons.\n'
                          'Prepare scenario manually; never like/follow/comment/favorite/share.\n'
                          'Type layout-ok after visual AND pixel-stat comparison; otherwise Ctrl-C.')
            if answer!='layout-ok':
                raise ValueError('layout preflight not confirmed')
            if args.scenario=='logout':
                if prompt(device,'User approval for THIS logout only: type APPROVE LOGOUT',awake=True)!='APPROVE LOGOUT':
                    raise PermissionError('logout not approved')
            if args.scenario=='login':
                if prompt(device,'User performs scan; harness never touches phone/accounts.\n'
                          'Type WAIT FOR USER SCAN when user is present; no login screen recording.',awake=True)!='WAIT FOR USER SCAN':
                    raise PermissionError('user scan step not acknowledged')
            manifest['start_ms']=now()
            for i in range(n):
                device.guard()
                trial={'index':i,'start_ms':now()}
                remote='/sdcard/dybench-'+uuid.uuid4().hex+'.mp4'
                rec=None
                if args.scenario not in GESTURES or args.step:
                    action=prompt(device,f'Trial {i+1}/{n}: type ready; perform {args.scenario} after ENTER.\n'
                                  'For mute: toggle ON then OFF (20 pairs total); restore original state.\n'
                                  'For cold_open: owner manually closes/reopens app (harness never force-stops restore).',awake=False)
                    if action!='ready':
                        raise ValueError('trial not confirmed')
                device.key(224)
                if args.scenario in GESTURES or args.record:
                    require_player(collector.events,now())
                try:
                    if args.record:
                        trial['record_launch_before_ms']=now()
                        rec=device.recording(remote)
                        # Startup bracket is not a video clock synchronization.
                        time.sleep(1)
                        trial['record_launch_after_ms']=now()
                    trial['command_before_ms']=now()
                    if args.scenario in GESTURES:
                        device.swipe(args.scenario)
                    # For login this is the explicit wait-for-user-scan step.
                    # Completion is measured by host scan_accepted -> auth_persisted, not ENTER.
                    deadline=time.monotonic()+(120 if args.scenario=='login' else 15 if args.scenario in ('mute','logout') else 5)
                    last_wake=time.monotonic()
                    while time.monotonic()<deadline:
                        device.guard()
                        if args.scenario=='login' and time.monotonic()-last_wake>=15:
                            device.key(224)
                            last_wake=time.monotonic()
                        if args.scenario=='login' and any(e['code']=='auth_persisted' and e['t_ms']>=trial['start_ms'] for e in collector.events):
                            break
                        time.sleep(.25)
                    trial['command_after_ms']=now()
                    if rec:
                        if rec.wait(timeout=10)!=0:
                            raise RuntimeError('screenrecord failed')
                        if any(e.get('tag')=='PodBrowserAuth' and e.get('code')=='requested' and e['t_ms']>=trial['record_launch_before_ms'] for e in collector.events):
                            raise RuntimeError('auth request during video; discard own recording without pulling')
                        device.fetch_video(remote,out/f'clip-{i:03}.mp4')
                        trial['video']=f'clip-{i:03}.mp4'
                finally:
                    if rec and rec.poll() is None:
                        # screenrecord expires by itself within 7 s; do not kill arbitrary device processes.
                        rec.wait(timeout=10)
                    if rec:
                        device.remove_video(remote)
                trial['end_ms']=now()
                manifest['trials'].append(trial)
                with (out/'gfx.txt').open('a') as f:
                    f.write(device.dumps('gfxinfo',args.package,'framestats'))
                write_json(out/'manifest.json',manifest)
            if args.scenario=='mute':
                if prompt(device,'Restore original system mute state on WATCH. Type restored.',awake=True)!='restored':
                    raise ValueError('mute restoration not confirmed')
                manifest['mute_restored_by_operator']=True
            manifest['end_ms']=now()
    finally:
        manifest['end_ms']=now()
        manifest['screen_restored']=screen.journal['restored']
        if (out/'collector.json').exists():
            manifest['log_complete']=json.loads((out/'collector.json').read_text())['log_complete']
        write_json(out/'manifest.json',manifest)
        lock.close()
        if (out/'events.jsonl').exists():
            analyze(out)


def analyze(out):
    out=Path(out)
    manifest=json.loads((out/'manifest.json').read_text())
    events=[e for e in read_jsonl(out/'events.jsonl') if manifest['start_ms']-2000 <= e['t_ms'] <= manifest['end_ms']]
    threshold_path=out/'thresholds.json'
    if not threshold_path.exists():
        threshold_path=HERE/'thresholds.json'
    thresholds=json.loads(threshold_path.read_text())
    videos=[]
    for path in sorted(out.glob('clip-*.analysis.json')):
        videos.append(json.loads(path.read_text()))
    result=evaluate(events,manifest,thresholds,(out/'gfx.txt').read_text() if (out/'gfx.txt').exists() else '',
                    read_jsonl(out/'memory.jsonl'),videos)
    result['threshold_sha256']=hashlib.sha256(threshold_path.read_bytes()).hexdigest()
    result['source_manifest']=str(out/'manifest.json')
    write_json(out/'summary.json',result)
    print(json.dumps({'status':result['status'],'scenario':result['scenario'],'report':str(out/'summary.json')}))
    return result


def main():
    def interrupted(signum,frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,interrupted)
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    subs=parser.add_subparsers(dest='command',required=True)
    subs.add_parser('plan')
    recovery=subs.add_parser('restore-screen',help='recover screen.json after host kill/disconnect; owner must still approve ownership')
    recovery.add_argument('--execute',action='store_true')
    recovery.add_argument('--owner',required=True)
    recovery.add_argument('--journal',required=True)
    dry=subs.add_parser('dry-run')
    dry.add_argument('--out',required=True)
    ana=subs.add_parser('analyze')
    ana.add_argument('out')
    vid=subs.add_parser('video')
    vid.add_argument('clip')
    vid.add_argument('--calibration',required=True)
    live=subs.add_parser('run')
    live.add_argument('--execute',action='store_true')
    live.add_argument('--owner',required=True)
    live.add_argument('--package',choices=sorted(PACKAGES),required=True)
    live.add_argument('--scenario',choices=list(METRICS),required=True)
    live.add_argument('--restore',choices=['idle','running'],required=True)
    live.add_argument('--out',required=True)
    live.add_argument('--count',type=int)
    live.add_argument('--allow-logout',action='store_true')
    live.add_argument('--record',action='store_true')
    live.add_argument('--step',action='store_true',help='operator preflight before every automatic swipe')
    args=parser.parse_args()
    if args.command=='plan':
        cfg=json.loads((HERE/'thresholds.json').read_text())
        print(json.dumps({'thresholds':cfg,'matrix':[{'scenario':s,'restore':m,'n':c['n'],
                     'minimum_minutes':round(c['n']*c['seconds_per_trial']/60,1)}
                     for s,c in cfg['scenarios'].items() for m in ['idle','running']],
                     'network':'SKIPPED: no verified safe watch-only throttling control'},indent=2))
    elif args.command=='restore-screen':
        if not args.execute:
            raise ValueError('screen restoration requires --execute')
        journal=Path(args.journal).resolve()
        value=json.loads(journal.read_text())
        if set(value['original'])!=set(SCREEN_KEYS):
            raise ValueError('screen-only journal required')
        screen=Screen(Device(args.owner),journal.parent)
        screen.original=value['original']
        screen.journal=value
        screen.__exit__()
        print(json.dumps({'screen_restored':screen.journal['restored']}))
    elif args.command=='run':
        run(args)
    elif args.command=='analyze':
        analyze(args.out)
    elif args.command=='video':
        from video import analyze_clip
        value=analyze_clip(args.clip,args.calibration)
        path=Path(args.clip).with_suffix('.analysis.json')
        write_json(path,value)
        print(path)
    else:
        from fixtures import generate
        generate(Path(args.out))
        analyze(args.out)


if __name__=='__main__':
    try:
        main()
    except (ValueError,PermissionError,RuntimeError,subprocess.SubprocessError,KeyboardInterrupt) as error:
        print(type(error).__name__+': '+str(error),file=sys.stderr)
        sys.exit(2)
