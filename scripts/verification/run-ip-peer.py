#!/usr/bin/env python3
"""Run one paired fixture; an ADB relay is explicitly not wireless acceptance."""
import subprocess,json,time,argparse
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--mode',choices=['lan','adb-relay'],required=True);parser.add_argument('--phone-address');args=parser.parse_args();out=Path(__file__).resolve().parents[2]/'artifacts'
def adb(serial,*a):return subprocess.check_output(['adb','-s',serial,*a],text=True).strip()
def state():return json.loads(adb('e3aca8af','shell','run-as','dev.podjs.tests.syncstate','cat','files/podjs/podjs-kv.json'))
end=time.monotonic()+25
while time.monotonic()<end:
 if state().get('ip-peer-result',{}).get('phase')=='listening':break
 time.sleep(.25)
else:raise RuntimeError('Listener observation expired; inspect existing fixture')
relay=None
if args.mode=='adb-relay':
 reverse_before=adb('e3aca8af','reverse','--list');assert 'tcp:45078' not in reverse_before
 forward_before=adb('RFCX70EGH6K','forward','--list');host_port=adb('RFCX70EGH6K','forward','tcp:0','tcp:45077');assert host_port.isdecimal();adb('e3aca8af','reverse','--no-rebind','tcp:45078','tcp:'+host_port)
 relay={'hostPort':int(host_port),'watchPort':45078,'phonePort':45077,'reverseBefore':reverse_before,'forwardBefore':forward_before,'active':True};(out/'ip-relay.json').write_text(json.dumps(relay)+'\n');address='127.0.0.1';port='45078';route='unknownLocal'
else:assert args.phone_address;address=args.phone_address;port='45077';route='wifiLan'
watch_address=adb('e3aca8af','shell','settings','get','secure','bluetooth_address');assert watch_address not in ['', 'null']
with (out/'ip-peer-phone.log').open('w') as log:
 client=subprocess.Popen(['adb','-s','RFCX70EGH6K','shell','am','instrument','-w','-e','class','dev.podjs.runtime.WatchRssIpPeerTest','-e','watchAddress',watch_address,'-e','endpointAddress',address,'-e','endpointPort',port,'-e','listenPort','45077','-e','routeKind',route,'-e','adbRelay',str(args.mode=='adb-relay').lower(),'dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner'],stdout=log,stderr=subprocess.STDOUT)
 print('Phone IP fixture running',client.pid,'mode',args.mode,flush=True);client.wait(timeout=180)
# Do not remove a relay solely because observing a live client timed out.
if relay:
 adb('e3aca8af','reverse','--remove','tcp:45078');adb('RFCX70EGH6K','forward','--remove','tcp:'+str(relay['hostPort']));relay['active']=False;relay['removed']=True;relay['reverseAfter']=adb('e3aca8af','reverse','--list');relay['forwardAfter']=adb('RFCX70EGH6K','forward','--list');assert relay['reverseAfter']==relay['reverseBefore'] and relay['forwardAfter']==relay['forwardBefore'];(out/'ip-relay.json').write_text(json.dumps(relay)+'\n')
assert client.returncode==0 and 'OK (1 test)' in (out/'ip-peer-phone.log').read_text(),(out/'ip-peer-phone.log').read_text()[-3000:]
end=time.monotonic()+45
while time.monotonic()<end:
 v=state();r=v.get('ip-peer-result',{})
 if r.get('state') in ['passed','failed']:
  (out/'ip-peer-guest-kv.json').write_text(json.dumps(v,ensure_ascii=True)+'\n');print(r,flush=True);assert r['state']=='passed';break
 time.sleep(.25)
else:raise RuntimeError('Guest completion observation expired; inspect existing process')
