#!/usr/bin/env python3
import subprocess,time,json,datetime
from pathlib import Path
out=Path(__file__).resolve().parents[2]/'artifacts'
def watch(*args):return subprocess.check_output(['adb','-s','e3aca8af',*args],text=True)
def state():return json.loads(watch('shell','run-as','dev.podjs.tests.syncstate','cat','files/podjs/podjs-kv.json'))
end=time.monotonic()+20
while time.monotonic()<end:
 result=state().get('application-power-result',{})
 if result.get('phase')=='listening':break
 if result.get('state')=='failed':raise RuntimeError(result)
 time.sleep(.25)
else:raise RuntimeError('Listener readiness observation expired')
log=(out/'power-background-phone-probe.log').open('w')
client=subprocess.Popen(['adb','-s','RFCX70EGH6K','shell','am','instrument','-w','-e','class','dev.podjs.runtime.WatchRssPowerPeerTest','-e','watchAddress','A8:88:CE:CA:8F:A4','-e','serviceUuid','27f8a669-027b-4c49-8023-f899420c38a9','-e','ackHoldMs','15000','dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner'],stdout=log,stderr=subprocess.STDOUT)
print('Phone probe running',client.pid,flush=True);switched=False;end=time.monotonic()+25
while time.monotonic()<end and client.poll() is None:
 result=state().get('application-power-result',{})
 if result.get('phase')=='resources-active':
  assert client.poll() is None
  watch('shell','am','start','-n','com.lightningstudio.watchrss.podjs/dev.podjs.androidwatch.MainActivity');switched=True
  (out/'power-background-switch.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'phoneProcessLive':True,'guestPid':watch('shell','pidof','dev.podjs.tests.syncstate').strip(),'resumed':[l.strip() for l in watch('shell','dumpsys','activity','activities').splitlines() if 'mResumedActivity' in l]},indent=2)+'\n');print('Guest backgrounded during transfer',flush=True);break
 if result.get('state')=='failed':raise RuntimeError(result)
 time.sleep(.25)
client.wait(timeout=50);log.close();print('Phone probe finished',client.returncode,flush=True)
assert switched
assert 'OK (1 test)' in (out/'power-background-phone-probe.log').read_text()
end=time.monotonic()+20
while time.monotonic()<end:
 value=state();result=value.get('application-power-result',{})
 if result.get('state') in ['passed','failed']:
  (out/'power-background-guest-kv.json').write_text(json.dumps(value,ensure_ascii=False)+'\n');print(result,flush=True);assert result['state']=='passed' and result['appliedAckReceived'];break
 time.sleep(.25)
else:raise RuntimeError('Guest completion observation expired')
