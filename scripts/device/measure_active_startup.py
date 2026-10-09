#!/usr/bin/env python3
"""Measure isolated non-debug ACTIVE cold launches with numeric-only diagnostics.

The caller owns DEVICE_OWNER and seeds/installs the rehearsal APK separately.
No formal-package install, data clear, private-file read or uninstallation occurs.
"""
import argparse,json,re,statistics,struct,subprocess,time
from pathlib import Path
from PIL import Image,ImageChops,ImageStat
PACKAGE='com.lightningstudio.watchrss.podjs.rehearsal'
ADB=['adb','-s','e3aca8af']

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--owner-file',required=True,type=Path);p.add_argument('--reference',required=True,type=Path)
 p.add_argument('--out',required=True,type=Path);p.add_argument('--rounds',default=5,type=int)
 a=p.parse_args();assert 1<=a.rounds<=10
 def owned():
  if a.owner_file.read_text().strip()!='wrss-impl':raise RuntimeError('device_owner_not_wrss_impl')
 def adb(args):
  owned();r=subprocess.run(ADB+args,capture_output=True,timeout=30);owned()
  if r.returncode:raise RuntimeError('adb_command_failed_'+args[0])
  return r.stdout
 def save(name,v):a.out.joinpath(name).write_text(json.dumps(v,indent=2)+'\n')
 def numeric_logs(pid,epoch):
  raw=adb(['logcat','-d','-v','epoch','--pid',str(pid),'-t','10000','-s','PodTakeover:I','PodJSPerf:I','AndroidRuntime:E','libc:F','*:S']).decode(errors='replace');rows=[];fatal=[]
  for line in raw.splitlines():
   m=re.match(r'\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+([VDIWEF])\s+([^:]+):\s?(.*)',line)
   if not m or int(m[2])!=pid or float(m[1])<epoch:continue
   tag,msg=m[4].strip(),m[5]
   if (tag=='AndroidRuntime' and 'FATAL EXCEPTION' in msg) or (tag=='libc' and 'Fatal signal' in msg) or (tag=='PodTakeover' and 'phase=' in msg):fatal.append({'epoch':float(m[1]),'tag':tag})
   s=re.fullmatch(r'step=([A-Za-z]{1,48}) elapsedMs=([0-9.eE+\-]+)',msg) if tag=='PodTakeover' else None
   if s:rows.append({'epoch':float(m[1]),'kind':'takeover','step':s[1],'elapsedMs':float(s[2])})
   if tag=='PodJSPerf':
    s=re.search(r'\bstartup stage=([A-Za-z0-9]+)\b',msg)
    vals={k:float(v) for k,v in re.findall(r'([A-Za-z0-9]+Ms)=([0-9.]+)',msg)}
    if s and vals:rows.append({'epoch':float(m[1]),'kind':'startup','step':s[1],**vals})
    if msg.startswith('firstFrame '):rows.append({'epoch':float(m[1]),'kind':'firstTexture',**vals})
  return {'pid':pid,'epochStart':epoch,'rows':rows,'fatalOrAdmissionFailures':fatal,'rawLogsPersisted':False}
 a.out.mkdir(parents=True,exist_ok=True);ref=Image.open(a.reference).convert('RGB');assert ref.size==(466,466)
 d=adb(['shell','dumpsys','package',PACKAGE]).decode();uid=int(re.search(r'userId=(\d+)',d)[1]);version=int(re.search(r'versionCode=(\d+)',d)[1]);flags=re.search(r'pkgFlags=\[([^\]]*)\]',d)[1]
 if 'DEBUGGABLE' in flags:raise RuntimeError('rehearsal_must_be_nondebug')
 apkpath=adb(['shell','pm','path',PACKAGE]).decode().strip().removeprefix('package:');apksha=adb(['shell','sha256sum',apkpath]).decode().split()[0]
 save('identity.json',{'package':PACKAGE,'uid':uid,'versionCode':version,'debuggable':False,'installedApkSha256':apksha})
 records=[]
 for n in range(1,a.rounds+1):
  adb(['shell','input','keyevent','3']);epoch=float(adb(['shell','date','+%s.%N']))
  fs=time.monotonic();adb(['shell','am','force-stop',PACKAGE]);fsend=time.monotonic();launch=time.monotonic()
  proc=subprocess.Popen(ADB+['shell','am','start','-W','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER','-n',PACKAGE+'/dev.podjs.androidwatch.MainActivity'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  frames=[]
  try:
   while time.monotonic()-launch<6:
    begin=time.monotonic();data=adb(['exec-out','screencap']);end=time.monotonic();w,h,fmt=struct.unpack('<III',data[:12]);header=len(data)-w*h*4
    assert (w,h,fmt,header) in [(466,466,1,12),(466,466,1,16)]
    im=Image.frombytes('RGBA',(w,h),data[header:]).convert('RGB');name=f'cold{n}-{len(frames):02}.png';im.save(a.out/name)
    mae=sum(ImageStat.Stat(ImageChops.difference(im,ref)).mean)/3
    frames.append({'file':name,'beginFromLaunchSeconds':begin-launch,'endFromLaunchSeconds':end-launch,'beginFromForceStopSeconds':begin-fs,'endFromForceStopSeconds':end-fs,'mae':mae})
   stdout,stderr=proc.communicate(timeout=30);assert proc.returncode==0
  finally:
   if proc.poll() is None:proc.terminate();proc.wait(timeout=5)
  pid=int(adb(['shell','pidof',PACKAGE]));logs=numeric_logs(pid,epoch);save(f'cold{n}-diagnostics.json',logs)
  exact=[f for f in frames if f['mae']==0]
  record={'round':n,'pid':pid,'forceStopCommandSeconds':fsend-fs,'frames':frames,'firstExactHome':exact[0] if exact else None,'samplingMeaning':'screenshot completion is conservative visible upper bound; screencap perturbs launch'}
  records.append(record);save('cold-visual-summary.json',records)
  if logs['fatalOrAdmissionFailures']:raise RuntimeError('rehearsal_admission_or_runtime_failure')
  if not exact:raise RuntimeError('exact_reference_home_not_reached')
  print(json.dumps({'round':n,'firstExactHome':exact[0]}),flush=True)
 summary={k:{'values':[r['firstExactHome'][k] for r in records],'median':statistics.median(r['firstExactHome'][k] for r in records),'max':max(r['firstExactHome'][k] for r in records)} for k in ['endFromForceStopSeconds','endFromLaunchSeconds']}
 admission=[row['elapsedMs'] for n in range(1,a.rounds+1) for row in json.loads(a.out.joinpath(f'cold{n}-diagnostics.json').read_text())['rows'] if row['kind']=='startup' and row['step']=='admissionWorker']
 summary['activeAdmissionMs']={'values':admission,'median':statistics.median(admission),'max':max(admission)} if admission else None
 save('cold-summary.json',summary);print(json.dumps(summary),flush=True)
if __name__=='__main__':main()
