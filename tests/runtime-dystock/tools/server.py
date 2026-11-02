#!/usr/bin/env python3
"""Loopback-only paired fixture server. No remote URL or auth value is logged."""
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path
import threading,time,json,secrets,re,urllib.parse,sys,os
ROOT=Path(sys.argv[1]).resolve();APP=Path(sys.argv[2]).resolve();ROOT.mkdir(parents=True,exist_ok=True)
resume='--resume' in sys.argv
config=APP/'tests/runtime-dystock/runtime-config.generated.ts'
if resume:
 match=re.search(r'export const cookie=("[^"\n]+");',config.read_text());secret=json.loads(match[1])
else:secret='fixture_pair='+secrets.token_hex(32)
lock=threading.Lock();page=0;sequence=0
if resume:
 rows=[json.loads(line) for line in (ROOT/'requests.jsonl').read_text().splitlines()]
 page=max((r.get('page',-1) for r in rows),default=-1)+1
 sequence=max((r.get('request',0) for r in rows),default=0)
names=['head','tail','large-moov','ignore200']
class Server(ThreadingHTTPServer):daemon_threads=True
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def do_GET(self):self.dispatch()
 def do_POST(self):self.dispatch()
 def dispatch(self):
  global page,sequence
  if self.headers.get('Cookie')!=secret:
   self.close_connection=True;return
  path=urllib.parse.urlsplit(self.path).path
  try:phase=json.loads((ROOT/'phase.json').read_text())
  except (FileNotFoundError,json.JSONDecodeError):phase={'run':0,'phase':'unknown','online':False}
  category='feed' if path=='/aweme/v2/web/module/feed/' else 'detail' if 'detail' in path else 'media' if path.startswith('/media/') else 'other'
  row={'epoch':time.time(),'category':category,'run':phase.get('run',0),'phase':phase.get('phase','setup'),'online':phase.get('online',False),'range_present':bool(self.headers.get('Range'))}
  if not phase.get('online',False):
   row.update(status=0,sent=0,denied_offline=True);self.record(row);self.close_connection=True;return
  if category=='feed':
   with lock:p=page;page+=1
   items=[]
   for index in range(3):
    case=names[(p*3+index)%len(names)];identity=str(7000000000000000000+p*3+index)
    url=f'http://127.0.0.1:{self.server.server_port}/media/{case}.mp4?x-expires=4102444800'
    addr={'url_list':[url],'width':320,'height':480}
    items.append({'aweme_id':identity,'desc':'Local fixture '+case,'author':{'uid':'fixture','nickname':'fixture'},'video':{'duration':20000,'play_addr':addr,'play_addr_h264':addr,'bit_rate':[{'bit_rate':2500000,'gear_name':'fixture_h264','play_addr':addr}]}})
   data=json.dumps({'status_code':0,'aweme_list':items,'has_more':0,'max_cursor':0}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);row.update(status=200,sent=len(data),page=p);self.record(row);return
  if category!='media':
   row.update(status=0,sent=0,forbidden_category=True);self.record(row);self.close_connection=True;return
  case=path.removeprefix('/media/').removesuffix('.mp4')
  if case not in names:self.close_connection=True;return
  file=ROOT/'media'/('head.mp4' if case=='ignore200' else case+'.mp4');length=file.stat().st_size;start=0;end=length-1;status=200
  request=self.headers.get('Range','')
  if request and case!='ignore200':
   match=re.fullmatch(r'bytes=(\d+)-(\d*)',request)
   if not match:self.close_connection=True;return
   start=int(match[1]);end=min(length-1,int(match[2]) if match[2] else length-1);status=206
   if start> end:self.send_error(416);return
  self.send_response(status);self.send_header('Content-Type','video/mp4');self.send_header('Content-Length',str(end-start+1));self.send_header('Accept-Ranges','bytes')
  if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{length}')
  self.end_headers();sent=0
  try:
   with file.open('rb') as stream:
    stream.seek(start)
    while sent<end-start+1:
     data=stream.read(min(65536,end-start+1-sent))
     if not data:break
     self.wfile.write(data);sent+=len(data)
  except (ConnectionResetError,BrokenPipeError):pass
  row.update(status=status,sent=sent,case=case,position=start,total=length,ignored_range=bool(request and case=='ignore200'));self.record(row)
 def record(self,row):
  global sequence
  with lock:
   sequence+=1;row['request']=sequence
   with (ROOT/'requests.jsonl').open('a') as output:output.write(json.dumps(row,separators=(',',':'))+'\n')
server=Server(('127.0.0.1',json.loads((ROOT/'server.json').read_text())['port'] if resume else 0),Handler)
config=APP/'tests/runtime-dystock/runtime-config.generated.ts'
config.write_text('export const origin='+json.dumps(f'http://127.0.0.1:{server.server_port}')+';\nexport const cookie='+json.dumps(secret)+';\n');config.chmod(0o600)
(ROOT/'server.json').write_text(json.dumps({'pid':os.getpid(),'port':server.server_port,'bound':'127.0.0.1','pair_key_bytes':32})+'\n')
print(json.dumps({'server_ready':True,'port':server.server_port,'bound':'127.0.0.1','pair_key_bytes':32}),flush=True)
server.serve_forever()
