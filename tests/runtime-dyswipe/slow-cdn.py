#!/usr/bin/env python3
"""Loopback-only, bounded-range CDN fixture. No upstream or credentials."""
import argparse,json,re,time,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--port',type=int,default=18756);p.add_argument('--kbps',type=float,default=300);p.add_argument('--ttfb-ms',type=float,default=600);p.add_argument('--handshake-ms',type=float,default=0);p.add_argument('--alternate-port',type=int);p.add_argument('--alternate-ttfb-ms',type=float,default=120);p.add_argument('--log',type=Path,required=True);a=p.parse_args()
 assert a.kbps>0 and min(a.ttfb_ms,a.handshake_ms,a.alternate_ttfb_ms)>=0
 lock=threading.Lock();counter=0;connections=0
 class Handler(BaseHTTPRequestHandler):
  protocol_version='HTTP/1.1'
  def setup(self):
   nonlocal connections
   super().setup()
   with lock:connections+=1;self.connection_id=connections
   self.requests=0
  def log_message(self,*args):pass
  def do_GET(self):
   nonlocal counter
   match=re.fullmatch(r'/(front|tail)/(\d{1,3})\.mp4',self.path)
   if not match:self.send_error(404);return
   path=a.root/(match[1]+'.mp4');size=path.stat().st_size;lo=0;hi=size-1
   range_=self.headers.get('Range')
   if range_:
    r=re.fullmatch(r'bytes=(\d+)-(\d*)',range_)
    if not r:self.send_error(416);return
    lo=int(r[1]);hi=min(hi,int(r[2]) if r[2] else hi)
   if lo>hi:self.send_error(416);return
   with lock:counter+=1;request=counter
   start=time.monotonic();sent=0;status='closed';first=None
   cold=self.requests==0;self.requests+=1
   alternate=self.server.server_port==a.alternate_port
   try:
    # Deliberate TLS-like setup cost, not a claim to emulate TLS cryptography.
    time.sleep(((a.handshake_ms if cold else 0)+(a.alternate_ttfb_ms if alternate else a.ttfb_ms))/1000)
    self.send_response(206 if range_ else 200);self.send_header('Content-Type','video/mp4');self.send_header('Content-Length',str(hi-lo+1));self.send_header('Accept-Ranges','bytes');self.send_header('Cache-Control','no-store')
    if range_:self.send_header('Content-Range',f'bytes {lo}-{hi}/{size}')
    self.end_headers()
    with path.open('rb') as f:
     f.seek(lo);began=time.monotonic()
     while sent<hi-lo+1:
      chunk=f.read(min(4096,hi-lo+1-sent));self.wfile.write(chunk);self.wfile.flush()
      if first is None:first=round((time.monotonic()-start)*1000,2)
      sent+=len(chunk);time.sleep(max(0,sent/(a.kbps*1024)-(time.monotonic()-began)))
    status='complete'
   except (BrokenPipeError,ConnectionResetError):pass
   finally:
    row=dict(request=request,connection=self.connection_id,cold=cold,host=1 if alternate else 0,layout=match[1],index=int(match[2]),offset=lo,requested=hi-lo+1,bytes=sent,size=size,ttfb_ms=first,elapsed_ms=round((time.monotonic()-start)*1000,2),status=status)
    with lock:
     with a.log.open('a') as out:out.write(json.dumps(row)+'\n')
 a.log.parent.mkdir(parents=True,exist_ok=True)
 if a.alternate_port:
  alternate=ThreadingHTTPServer(('127.0.0.1',a.alternate_port),Handler)
  threading.Thread(target=alternate.serve_forever,daemon=True).start()
 ThreadingHTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
if __name__=='__main__':main()
