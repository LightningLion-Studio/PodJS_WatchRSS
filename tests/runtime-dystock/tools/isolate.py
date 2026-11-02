#!/usr/bin/env python3
"""Run after install and before first launch, only on the owned port 5560."""
from pathlib import Path
import subprocess,json,re,sys
root=Path(sys.argv[1]).resolve();pkg='com.lightningstudio.watchrss.podjs'
def adb(*a,check=True):return subprocess.run(['adb','-s','emulator-5560',*a],capture_output=True,text=True,check=check)
raw=adb('shell','cmd','package','list','packages','-U',pkg).stdout
uid=int(next(re.fullmatch('package:'+re.escape(pkg)+r' uid:(\d+)',x)[1] for x in raw.splitlines() if re.fullmatch('package:'+re.escape(pkg)+r' uid:(\d+)',x)))
for tool,destination in [('iptables','127.0.0.0/8'),('ip6tables','::1/128')]:
 args=['OUTPUT','-m','owner','--uid-owner',str(uid),'!','-d',destination,'-j','REJECT']
 if adb('shell','su','0',tool,'-C',*args,check=False).returncode:adb('shell','su','0',tool,'-I',*args)
 adb('shell','su','0',tool,'-C',*args)
port=str(json.loads((root/'server.json').read_text())['port']);adb('reverse','tcp:'+port,'tcp:'+port)
(root/'network-isolation.json').write_text(json.dumps(dict(serial='emulator-5560',app_uid=uid,non_loopback_egress_rejected=True,real_credentials_imported=False),indent=2)+'\n')
print(json.dumps(dict(isolated=True,app_uid=uid,port=int(port))))
