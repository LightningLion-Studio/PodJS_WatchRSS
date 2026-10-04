#!/usr/bin/env python3
"""Exercise the development package for ten minutes without changing library data."""
import json, subprocess, time
from pathlib import Path
P=Path(__file__).resolve().parents[1]/'artifacts'
DEVICE='e3aca8af'; PACKAGE='com.lightningstudio.watchrss.podjs'
def adb(*args):
    return subprocess.check_output(['adb','-s',DEVICE,*args],text=True,timeout=30)
adb('shell','am','start','-W','-n',PACKAGE+'/dev.podjs.androidwatch.MainActivity')
pid=adb('shell','pidof',PACKAGE).strip()
start=time.monotonic(); records=[]
log=(P/'gpu-soak-logcat.txt').open('w')
process=subprocess.Popen(['adb','-s',DEVICE,'logcat','--pid='+pid,'-T','1','-v','brief','-s','PodJSPerf:I','PodJS:E','AndroidRuntime:E','*:S'],stdout=log)
try:
    for minute in range(10):
        until=start+(minute+1)*60
        count=0
        while time.monotonic()<until:
            coords=['233','365','233','110'] if count%2==0 else ['233','110','233','365']
            adb('shell','input','swipe',*coords,'500'); count+=1
            if adb('shell','pidof',PACKAGE).strip()!=pid: raise RuntimeError('App process changed during soak')
            time.sleep(1)
        adb('shell','input','keyevent','KEYCODE_HOME'); time.sleep(1)
        resumed=adb('shell','am','start','-W','-n',PACKAGE+'/dev.podjs.androidwatch.MainActivity')
        mem=adb('shell','dumpsys','meminfo',PACKAGE)
        (P/f'gpu-soak-mem-{minute+1:02}.txt').write_text(mem)
        records.append({'minute':minute+1,'elapsedSeconds':round(time.monotonic()-start,2),'swipes':count,'pid':pid,'resume':resumed})
        (P/'gpu-soak.json').write_text(json.dumps({'complete':False,'records':records},indent=2))
        print(f'minute={minute+1} pid={pid} swipes={count}',flush=True)
    (P/'gpu-soak.json').write_text(json.dumps({'complete':True,'elapsedSeconds':round(time.monotonic()-start,2),'records':records},indent=2))
finally:
    process.terminate(); process.wait(timeout=10); log.close()
