"""Loopback-only synthetic CDN. No platform credentials or platform requests."""
import argparse
import json
import re
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

parser = argparse.ArgumentParser()
parser.add_argument('--media', required=True)
parser.add_argument('--log', required=True)
parser.add_argument('--port', type=int, default=18764)
parser.add_argument('--emulator-host', default='127.0.0.1')
args = parser.parse_args()
media = Path(args.media).read_bytes()
lock = threading.Lock()
counts = {}
expires = {}
def record(**row):
    with lock:
        with open(args.log, 'a') as out:
            out.write(json.dumps(dict(at=time.time(), **row))+'\n')
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, status, body, mime='application/json', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        for key, value in (extra or {}).items(): self.send_header(key, value)
        self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass
    def do_GET(self):
        url=urlparse(self.path); q=parse_qs(url.query); scene=q.get('scene', ['manual'])[0]
        if url.path == '/control':
            record(event='control',action=q.get('action', ['expire'])[0])
            if q.get('action') == ['reset']:
                counts.clear(); expires.clear()
            else:
                for token in list(expires): expires[token]=0
            self.reply(200,b'{}'); return
        if url.path == '/resolve':
            counts[scene]=counts.get(scene,0)+1
            count=counts[scene]; token=f'{scene}-{count}'
            expiry=time.time()+(8 if scene in ('resume','sessions') and count==1 else 300)
            expires[token]=expiry
            rejected=scene=='manual' and count<=3
            path=f'/video/{token}'+('-rejected' if rejected else '')
            record(event='resolve',scene=scene,count=count,token=token)
            time.sleep(3.5 if scene in ('manual','slow') else 1.5)
            self.reply(200,json.dumps(dict(url=f'http://{args.emulator_host}:{args.port}{path}',expiresAtMs=int(expiry*1000))).encode());return
        if url.path.startswith('/video/'):
            token=url.path.split('/')[-1]
            if token.endswith('-rejected') or expires.get(token,0)<time.time():
                record(event='media',token=token,status=403);self.reply(403,b'expired');return
            start,end=0,len(media)-1
            match=re.match(r'bytes=(\d+)-(\d*)',self.headers.get('Range',''))
            if match:
                start=int(match[1]);end=min(int(match[2]) if match[2] else end,end)
            if start> end:
                self.reply(416,b'');return
            status=206 if match else 200
            record(event='media',token=token,status=status,start=start,end=end)
            if token.startswith('slow-'):time.sleep(6)
            extra={'Accept-Ranges':'bytes'}
            if match:extra['Content-Range']=f'bytes {start}-{end}/{len(media)}'
            self.reply(status,media[start:end+1],'video/mp4',extra);return
        self.reply(404,b'{}')
ThreadingHTTPServer(('127.0.0.1', args.port),Handler).serve_forever()
