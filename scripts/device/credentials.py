#!/usr/bin/env python3
"""Debug-only credential backup. No device files and no credential output."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile

SERIAL = 'e3aca8af'
MAX_BYTES = 12000
KEYS = ('watchrss.bili.session.v1', 'douyin.cookie', 'state_json')
RECEIVER = 'com.lightningstudio.watchrss.debug.DouyinPlaybackDebugReceiver'
ACTION = 'com.lightningstudio.watchrss.debug.action.'

class CredentialError(Exception):
    pass

def adb(*args):
    try:
        result = subprocess.run(['adb', '-s', SERIAL, *args], capture_output=True,
                                text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        raise CredentialError('ADB request failed') from None
    if result.returncode:
        raise CredentialError('ADB request rejected')
    return result.stdout

def validate(raw):
    if len(raw) > MAX_BYTES:
        raise CredentialError('Snapshot exceeds size limit')
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise CredentialError('Invalid snapshot JSON') from None
    if not isinstance(value, dict) or set(value) != {'version', 'values'} or type(value['version']) is not int or value['version'] != 1:
        raise CredentialError('Unsupported snapshot version or structure')
    entries = value['values']
    if not isinstance(entries, dict) or set(entries) != set(KEYS) or any(v is not None and not isinstance(v, str) for v in entries.values()):
        raise CredentialError('Invalid snapshot allowlist')
    return value

def backup_path(package):
    directory = Path.home() / '.local/share/watchrss'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or not directory.is_dir():
        raise CredentialError('Backup directory must be a private directory')
    repo = Path(__file__).resolve().parents[2]
    if directory.resolve().is_relative_to(repo):
        raise CredentialError('Backup directory must be outside the repository')
    directory.chmod(0o700)
    return directory / f'credentials-{package}.json'

def save(path, raw):
    fd, temporary = tempfile.mkstemp(prefix='.credentials-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def load(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise CredentialError('Backup must be an owned regular file with mode 0600')
        raw = source.read(MAX_BYTES + 1)
    validate(raw)
    return raw

def exchange(package, operation, raw=None):
    # The host refuses before an action/Activity can reach a release app.
    adb('shell', shlex.join(['run-as', package, 'true']))
    adb('shell', shlex.join(['am', 'start', '--activity-single-top', '-n', package + '/dev.podjs.androidwatch.MainActivity']))
    command = ['am', 'broadcast', '--user', '0', '-n', package + '/' + RECEIVER,
               '-a', ACTION + operation.upper() + '_CREDENTIALS']
    if raw is not None:
        command += ['--es', 'snapshot_base64', base64.b64encode(raw).decode('ascii')]
    output = adb('shell', shlex.join(command))
    match = re.search(r'Broadcast completed: result=(-?\d+)(?:, data="([\s\S]*)")?\s*$', output)
    if not match or int(match[1]) != 0:
        raise CredentialError('Debug credential action refused or timed out')
    return (match[2] or '').encode('utf-8')

def summary(snapshot):
    return ' '.join(f'{key}:count={int(value is not None)},sha256=' +
                    (hashlib.sha256(value.encode()).hexdigest()[:8] if value is not None else 'absent')
                    for key, value in snapshot['values'].items())

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('export', 'import'))
    parser.add_argument('--package', default='com.lightningstudio.watchrss')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+', args.package):
        parser.error('Invalid package name')
    try:
        path = backup_path(args.package)
        if args.operation == 'export':
            raw = exchange(args.package, 'export')
            snapshot = validate(raw)
            save(path, raw)
        else:
            raw = load(path)
            snapshot = validate(raw)
            if exchange(args.package, 'import', raw) != b'ok':
                raise CredentialError('Unexpected import acknowledgement')
        print(f'{args.operation} succeeded: {path}; {summary(snapshot)}')
        return 0
    except CredentialError as error:
        print(str(error), file=__import__('sys').stderr)
        return 1
    except (OSError, ValueError, UnicodeError):
        print('Credential backup failed', file=__import__('sys').stderr)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
