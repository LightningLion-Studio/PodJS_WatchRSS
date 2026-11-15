"""Loopback-only mock MP4 server with bounded HTTP ranges; no upstream."""
import argparse
import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--media', type=Path, required=True)
parser.add_argument('--log', type=Path, required=True)
args = parser.parse_args()
media = args.media.read_bytes()

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path != '/fixture.mp4':
            self.send_error(404)
            return
        start, end = 0, len(media) - 1
        raw = self.headers.get('Range')
        match = re.fullmatch(r'bytes=(\d+)-(\d*)', raw or '')
        if raw and not match:
            self.send_error(416)
            return
        if match:
            start = int(match[1])
            end = min(int(match[2]) if match[2] else end, end)
        if start > end:
            self.send_error(416)
            return
        status = 206 if match else 200
        with args.log.open('a') as out:
            out.write(json.dumps(dict(at=time.time(), path=self.path, status=status, start=start, end=end)) + '\n')
        self.send_response(status)
        self.send_header('Content-Type', 'video/mp4')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        if match:
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(media)}')
        self.end_headers()
        try:
            self.wfile.write(media[start:end + 1])
        except (BrokenPipeError, ConnectionResetError):
            pass

ThreadingHTTPServer(('127.0.0.1', 18788), Handler).serve_forever()
