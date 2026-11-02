#!/usr/bin/env python3
"""Bounded host check of the paired fixture, using the generated real MP4 files."""
from pathlib import Path
import subprocess,tempfile,json,re,urllib.request,http.client,sys,time,os
media=Path(sys.argv[1]).resolve();output=Path(sys.argv[2]).resolve()
with tempfile.TemporaryDirectory(prefix='dystock-server-check-') as tmp:
 root=Path(tmp);app=root/'app';(app/'tests/runtime-dystock').mkdir(parents=True)
 (root/'media').symlink_to(media,target_is_directory=True)
 proc=subprocess.Popen([sys.executable,str(Path(__file__).with_name('server.py')),str(root),str(app)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  ready=json.loads(proc.stdout.readline());port=ready['port'];config=app/'tests/runtime-dystock/runtime-config.generated.ts';cookie=json.loads(re.search(r'export const cookie=("[^"\n]+");',config.read_text())[1]);assert config.stat().st_mode&0o777==0o600
  def request(path,range_=None,credential=None):
   conn=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
   try:
    headers={'Cookie':cookie if credential is None else credential}
    if range_:headers['Range']=range_
    conn.request('GET',path,headers=headers);r=conn.getresponse();return r.status,dict(r.getheaders()),r.read()
   finally:conn.close()
  def deny(path,credential=None):
   try:request(path,credential=credential)
   except http.client.RemoteDisconnected:return True
   raise AssertionError('server sent a response where no data was allowed')
  (root/'phase.json').write_text(json.dumps(dict(run=0,phase='check',online=True)))
  rows=[]
  for case in ['head','tail','large-moov','ignore200']:
   status,headers,data=request('/media/'+case+'.mp4','bytes=128-255');source=(media/('head.mp4' if case=='ignore200' else case+'.mp4')).read_bytes();expected=source if case=='ignore200' else source[128:256]
   assert status==(200 if case=='ignore200' else 206) and data==expected
   if status==206:assert headers['Content-Range']==f'bytes 128-255/{len(source)}'
   rows.append(dict(case=case,status=status,bytes=len(data),exact_match=True))
  status,_,body=request('/aweme/v2/web/module/feed/');assert status==200 and len(json.loads(body)['aweme_list'])==3
  assert deny('/other')
  (root/'phase.json').write_text(json.dumps(dict(run=0,phase='check',online=False)));assert deny('/media/head.mp4')
  (root/'phase.json').unlink();assert deny('/media/head.mp4')
  time.sleep(.1);before=(root/'requests.jsonl').read_bytes();assert deny('/media/head.mp4','invalid-pair');time.sleep(.1);assert before==(root/'requests.jsonl').read_bytes()
  result=dict(media=rows,feed_items=3,offline_denied=True,missing_phase_denied=True,non_feed_denied=True,wrong_pair_denied_without_log=True,config_mode_0600=True)
  output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
 finally:
  proc.terminate();proc.wait(timeout=5)
