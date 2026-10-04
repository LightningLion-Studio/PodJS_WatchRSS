#!/usr/bin/env python3
"""Run one paired fixture; an ADB relay is explicitly not wireless acceptance."""
import subprocess,json,time,argparse,tarfile,tempfile,sqlite3,base64
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--mode',choices=['lan','adb-relay'],required=True);parser.add_argument('--phone-address');parser.add_argument('--output-prefix',default='ip-main');parser.add_argument('--before-archive');parser.add_argument('--drop-first-route',action='store_true');parser.add_argument('--token-usage',action='store_true');parser.add_argument('--reader-sync',action='store_true');parser.add_argument('--reader-preview',action='store_true');args=parser.parse_args();out=Path(__file__).resolve().parents[2]/'artifacts'
assert args.output_prefix.replace('-','').replace('_','').isalnum();prefix=args.output_prefix
before_archive=Path(args.before_archive) if args.before_archive else out/'ip-main-before.tar'
def adb(serial,*a):return subprocess.check_output(['adb','-s',serial,*a],text=True).strip()
def state():return json.loads(adb('e3aca8af','shell','run-as','dev.podjs.tests.syncstate','cat','files/podjs/podjs-kv.json'))
assert adb('e3aca8af','shell','pidof','com.lightningstudio.watchrss.podjs')
relay=None
if args.mode=='adb-relay':
 reverse_before=adb('e3aca8af','reverse','--list');assert 'tcp:45078' not in reverse_before
 forward_before=adb('RFCX70EGH6K','forward','--list');host_port=adb('RFCX70EGH6K','forward','tcp:0','tcp:45077');assert host_port.isdecimal();adb('e3aca8af','reverse','--no-rebind','tcp:45078','tcp:'+host_port)
 relay={'hostPort':int(host_port),'watchPort':45078,'phonePort':45077,'reverseBefore':reverse_before,'forwardBefore':forward_before,'active':True};(out/(prefix+'-relay.json')).write_text(json.dumps(relay)+'\n');address='127.0.0.1';port='45078';route='unknownLocal'
else:assert args.phone_address;address=args.phone_address;port='45077';route='wifiLan'
with tarfile.open(before_archive) as archive,tempfile.TemporaryDirectory() as temp:
 for m in archive.getmembers():
  if m.isfile() and m.name.startswith('databases/'):Path(temp,Path(m.name).name).write_bytes(archive.extractfile(m).read())
 reader_expected={}
 if args.reader_sync:
  state=json.load(archive.extractfile('files/podjs/podjs-kv.json')).get('watchrss.reader-presets',{})
  for kind,rows in [('presets',state.get('records',[])),*[(kind,state.get('assets',{}).get(kind,[])) for kind in ['fonts','backgrounds','deletions']]]:
   parsed=[json.loads(r) if isinstance(r,str) else r for r in rows];reader_expected[kind]=[r['kind']+'/'+r['entityId'] if kind=='deletions' else r['id'] for r in parsed]
 token_ids=[row[0] for row in sqlite3.connect(str(Path(temp)/'podjs.sqlite')).execute('SELECT id FROM llm_token_usage ORDER BY created_at DESC,id ASC')]
 expected=sqlite3.connect(str(Path(temp)/'podjs.sqlite')).execute('SELECT device_id FROM sync_local_identity WHERE id=1').fetchone()[0]
watch_address=adb('e3aca8af','shell','settings','get','secure','bluetooth_address');assert watch_address not in ['', 'null']
with (out/(prefix+'-probe-phone.log')).open('w') as log:
 client=subprocess.Popen(['adb','-s','RFCX70EGH6K','shell','am','instrument','-w','-e','class','dev.podjs.runtime.WatchRssIpMainProbeTest','-e','watchAddress',watch_address,'-e','expectedWatchId',expected,'-e','endpointAddress',address,'-e','endpointPort',port,'-e','listenPort','45077','-e','routeKind',route,'-e','adbRelay',str(args.mode=='adb-relay').lower(),'-e','dropFirstRoute',str(args.drop_first_route).lower(),'-e','readerPreviewProbe',str(args.reader_preview).lower(),'-e','readerManifestProbe',str(args.reader_sync).lower(),'-e','expectedReaderBase64',base64.b64encode(json.dumps(reader_expected).encode()).decode(),'-e','tokenUsageProbe',str(args.token_usage).lower(),'-e','expectedTokenIds',json.dumps(token_ids,separators=(',',':')),'dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner'],stdout=log,stderr=subprocess.STDOUT)
 print('Phone IP fixture running',client.pid,'mode',args.mode,flush=True);client.wait(timeout=180)
# Do not remove a relay solely because observing a live client timed out.
if relay:
 adb('e3aca8af','reverse','--remove','tcp:45078');adb('RFCX70EGH6K','forward','--remove','tcp:'+str(relay['hostPort']));relay['active']=False;relay['removed']=True;relay['reverseAfter']=adb('e3aca8af','reverse','--list');relay['forwardAfter']=adb('RFCX70EGH6K','forward','--list');assert relay['reverseAfter']==relay['reverseBefore'] and relay['forwardAfter']==relay['forwardBefore'];(out/(prefix+'-relay.json')).write_text(json.dumps(relay)+'\n')
assert client.returncode==0 and 'OK (1 test)' in (out/(prefix+'-probe-phone.log')).read_text(),(out/(prefix+'-probe-phone.log')).read_text()[-3000:]
print('Read-only main IP probe passed',flush=True)
