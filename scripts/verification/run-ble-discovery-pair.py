#!/usr/bin/env python3
"""One private BLE advertisement/GATT read between the existing bonded devices."""
from pathlib import Path
import subprocess,time,json,re
out=Path(__file__).resolve().parents[2]/'artifacts'
peer=subprocess.check_output(['adb','-s','e3aca8af','shell','settings','get','secure','bluetooth_address'],text=True).strip();assert peer and peer!='null'
phone_address=subprocess.check_output(['adb','-s','RFCX70EGH6K','shell','settings','get','secure','bluetooth_address'],text=True).strip();assert phone_address and phone_address!='null'
base=['shell','am','instrument','-w','-r','-e','class']
with (out/'ip-ble-pair-phone.log').open('w') as phone_log,(out/'ip-ble-pair-watch.log').open('w') as watch_log:
 phone=subprocess.Popen(['adb','-s','RFCX70EGH6K',*base,'dev.podjs.runtime.WatchRssBleDiscoveryPairTest#phoneAdvertisesForSelectedBondedWatch','-e','watchAddress',peer,'dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner'],stdout=phone_log,stderr=subprocess.STDOUT)
 (out/'ip-ble-pair-running.json').write_text(json.dumps({'phonePid':phone.pid,'watchPid':None})+'\n');print('Phone BLE peripheral running',phone.pid,flush=True)
 deadline=time.monotonic()+20
 while 'bleDiscoveryReady=' not in (out/'ip-ble-pair-phone.log').read_text() and phone.poll() is None and time.monotonic()<deadline:time.sleep(.2)
 if 'bleDiscoveryReady=' not in (out/'ip-ble-pair-phone.log').read_text():
  # Do not restart a live instrumentation run just because readiness is slow.
  phone.wait(timeout=60);raise RuntimeError((out/'ip-ble-pair-phone.log').read_text()[-3000:])
 watch=subprocess.Popen(['adb','-s','e3aca8af',*base,'dev.podjs.runtime.WatchRssBleDiscoveryPairTest#watchReadsBondedPhoneCharacteristic','-e','phoneAddress',phone_address,'dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner'],stdout=watch_log,stderr=subprocess.STDOUT)
 (out/'ip-ble-pair-running.json').write_text(json.dumps({'phonePid':phone.pid,'watchPid':watch.pid})+'\n');print('Watch BLE discovery running',watch.pid,flush=True)
 ready_deadline=time.monotonic()+10
 while 'bleDiscoveryWatchForegroundReady=' not in (out/'ip-ble-pair-watch.log').read_text() and watch.poll() is None and time.monotonic()<ready_deadline:time.sleep(.1)
 if 'bleDiscoveryWatchForegroundReady=' in (out/'ip-ble-pair-watch.log').read_text():
  for permission in ['android.permission.ACCESS_COARSE_LOCATION','android.permission.ACCESS_FINE_LOCATION']:subprocess.run(['adb','-s','e3aca8af','shell','pm','grant','dev.podjs.runtime.test',permission],check=True)
 watch.wait(timeout=45);phone.wait(timeout=65)
assert watch.returncode==phone.returncode==0
for name in ['ip-ble-pair-phone.log','ip-ble-pair-watch.log']:assert 'OK (1 test)' in (out/name).read_text(),(out/name).read_text()[-3500:]
def proof(file,key):return json.loads(re.search(key+r'=(\{[^\n]+\})',(out/file).read_text())[1])
phone_proof=proof('ip-ble-pair-phone.log','bleDiscoveryPhoneProof');watch_proof=proof('ip-ble-pair-watch.log','bleDiscoveryWatchProof');ready=proof('ip-ble-pair-phone.log','bleDiscoveryReady');assert ready['sha256']==phone_proof['sha256']==watch_proof['sha256'];assert ready['bytes']==watch_proof['bytes'];assert phone_proof['selectedBondedWatch'] and phone_proof['gattDisconnected'] and watch_proof['bonded'] and watch_proof['actualBleRadio'];assert not watch_proof['wirelessIpVerified']
(out/'ip-ble-pair-proof.json').write_text(json.dumps({'ready':ready,'phone':phone_proof,'watch':watch_proof,'privateFixture':True,'actualBleRadio':True,'wirelessIpVerified':False},indent=2)+'\n');print('Paired BLE characteristic read passed',watch_proof['bytes'],'bytes',flush=True)
