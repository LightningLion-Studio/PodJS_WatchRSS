#!/usr/bin/env python3
"""Acceptance driver. Use only the named task-owned emulator; fixture APK only."""
import json,os,re,shlex,subprocess,sys,time
from pathlib import Path
adb=str(Path(os.environ['ANDROID_SDK_ROOT'])/'platform-tools/adb')
serial=sys.argv[1];out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
if not re.fullmatch(r'emulator-[0-9]+',serial):raise SystemExit('emulator serial required')
def run(*args):return subprocess.check_output([adb,'-s',serial,*args],text=True,stderr=subprocess.STDOUT,timeout=45)
name=run('emu','avd','name').splitlines()[0]
if not name.startswith('ADBENTRY_'):raise SystemExit('task AVD required')
package='com.lightningstudio.watchrss.adbentry'
records=[]
def command(method,arg=None,error=None):
 args=['content','call','--uri','content://'+package+'.podjs.shell','--method',method]
 if arg is not None:args+=['--arg',json.dumps(arg,separators=(',',':')) if isinstance(arg,dict) else arg]
 started=time.monotonic();raw=run('shell',shlex.join(args));elapsed=time.monotonic()-started
 if error is None:
  assert 'ok=true' in raw,raw
  result=json.JSONDecoder().raw_decode(raw.split('json=',1)[1])[0]
 else:
  assert 'ok=false' in raw and 'error='+error in raw,raw
  result=None
 records.append({'method':method,'arg':arg,'error':error,'elapsedSec':round(elapsed,3),'result':result})
 (out/'commands.json').write_text(json.dumps(records,indent=2)+'\n')
 return result
assert run('shell','id','-u').strip()=='2000'
run('shell','dumpsys','battery','unplug')
run('shell','settings','put','system','screen_off_timeout','2147483647')
run('shell','input','keyevent','KEYCODE_WAKEUP')
run('shell','am','force-stop',package)
run('shell','am','start','-W','-n',package+'/dev.podjs.androidwatch.MainActivity')
command('douyin.nonexistent',error='unknown_command')
command('douyin.play',{},error='invalid_argument')
assert isinstance(command('douyin.state')['page'],str)
assert command('douyin.open')['page']=='douyin.entry'
state=command('douyin.play',{'index':0});assert state['page']=='video' and state['playbackState']=='playing'
time.sleep(2)
advanced=command('douyin.state');assert advanced['position']>state['position']+500,(state,advanced)
assert advanced['decoderInstances']>0 and advanced['pssKb']>0
(out/'player-playing.png').write_bytes(subprocess.check_output([adb,'-s',serial,'exec-out','screencap','-p'],timeout=30))
paused=command('douyin.pause');assert paused['playbackState']=='paused'
time.sleep(1)
assert abs(command('douyin.state')['position']-paused['position'])<300
assert command('douyin.resume')['playbackState']=='playing'
assert command('douyin.next')['playbackState']=='playing'
assert command('douyin.prev')['playbackState']=='playing'
command('douyin.prev',error='not_found')
assert command('douyin.play',{'awemeId':'900000000000000002'})['playbackState']=='playing'
dump=command('diag.dump');assert 'sql.gzipJson' in dump['sql'];assert dump['videoSessions']['created']>0
command('douyin.state',{'extra':True},error='invalid_argument')
command('douyin.play','{',error='invalid_argument')
for forbidden in ['douyin.like','douyin.follow','douyin.comment','douyin.favorite','douyin.share','douyin.login','douyin.logout','js.eval','sql.query','file.read','cookie.get']:
 command(forbidden,error='unknown_command')
run('logcat','-c')
run('shell','am','start','-n','dev.podjs.adbentry.denied/.MainActivity')
for n in range(30):
 log=run('logcat','-d','-s','ADBENTRY_CLIENT:I','*:S')
 if 'denied=3 unexpected=0' in log:break
 time.sleep(.2)
else:raise AssertionError(log)
(out/'third-party.txt').write_text(log)
(out/'manifest-state.txt').write_text(run('shell','dumpsys','package',package))
print('ADBENTRY acceptance PASS:',len(records),'calls; position advanced; pause held; third-party denied')
