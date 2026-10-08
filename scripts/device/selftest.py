#!/usr/bin/env python3
"""Offline safety/receipt regression checks; never invokes real adb or Gradle."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile

SCRIPT = Path(__file__).with_name('acceptance.py')
spec = importlib.util.spec_from_file_location('acceptance', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.dry_run:
        print('Offline selftest plan: simulate adb unavailable; check all command plans and destructive guards; compare synthetic streamed SQLite receipt with canonical digest; simulate APK mismatch/upgrade.')
        return
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        fake = root / 'adb'
        fake.write_text('#!/bin/sh\necho "FAKE_ADB_CALLED" >&2\nexit 1\n')
        fake.chmod(0o755)
        env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'])
        cases = [ ['digest'], ['upgrade', '--apk', '/missing/app.apk'], ['cold-start'],
            ['routes', '--allow-destructive'], ['framework-tests'], ['capture'],
            ['compare', '--reference', '/missing/native.png', '--actual', '/missing/app.png'],
            ['logs'], ['reset-isolated', '--package', m.ISOLATED, '--allow-destructive'] ]
        for case in cases:
            cmd = [sys.executable, str(SCRIPT), *case, '--out', str(root / 'output')]
            result = subprocess.run(cmd + ['--dry-run'], capture_output=True, text=True, env=env)
            assert result.returncode == 0, (case, result.stderr)
            assert 'FAKE_ADB_CALLED' not in result.stderr
            assert 'adb -s e3aca8af' in result.stdout or case[0] == 'compare'
            assert not (root / 'output').exists(), 'dry-run wrote output'
            result = subprocess.run(cmd, capture_output=True, text=True, env=env)
            assert result.returncode != 0 and 'not online/authorized' in result.stderr, (case, result.stderr)
        for case in [['reset-isolated'], ['reset-isolated', '--allow-destructive'],
                     ['reset-isolated', '--package', m.ISOLATED], ['routes'],
                     ['reset-isolated', '--package', 'com.lightningstudio.watchrss', '--allow-destructive']]:
            result = subprocess.run([sys.executable, str(SCRIPT), *case, '--dry-run'], capture_output=True, text=True, env=env)
            assert result.returncode != 0, case
        db = root / 'podjs.sqlite'
        with sqlite3.connect(db) as conn:
            conn.execute('create table notes(id integer, body text, asset blob)')
            conn.execute('insert into notes values(1, ?, ?)', ('验收', b'\x00\xff'))
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as archive:
            archive.add(db, arcname='databases/podjs.sqlite')
            payload = b'{"theme":"dark"}'
            info = tarfile.TarInfo('files/podjs/podjs-kv.json')
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        archive_path = root / 'tiny-fixture.tar'
        archive_path.write_bytes(data.getvalue())
        # Tiny synthetic tar only: compare to existing canonical receipt implementation.
        subprocess.run([sys.executable, str(m.ROOT / 'scripts/verification/library-data-digest.py'),
            str(archive_path), str(root / 'legacy.json')], check=True, capture_output=True)
        legacy = json.loads((root / 'legacy.json').read_text())
        with tempfile.TemporaryDirectory() as sqltemp:
            actual = m.stream_digest(io.BytesIO(data.getvalue()), sqltemp)
        assert actual['files'] == legacy['files'] and actual['tables'] == legacy['tables']
        assert m.compare_receipts(actual, actual)['equal']
        changed = json.loads(json.dumps(actual))
        changed['tables']['notes']['sha256'] = 'changed'
        assert not m.compare_receipts(actual, changed)['equal']
        try:
            m.stream_digest(io.BytesIO(b'broken'), root)
        except tarfile.TarError:
            pass
        else:
            raise AssertionError('corrupt tar accepted')
        # An online fake exercises upgrade ordering without any device/network.
        trace = root / 'calls.txt'
        fake.write_text('#!' + sys.executable + '\n' +
            'import sys, pathlib\n' +
            'args=sys.argv[3:]\n' +
            'with open(' + repr(str(trace)) + ', "a") as f: f.write(" ".join(args)+"\\n")\n' +
            'if args == ["get-state"]: print("device")\n' +
            'elif args[:1] == ["exec-out"]: sys.stdout.buffer.write(pathlib.Path(' + repr(str(archive_path)) + ').read_bytes())\n' +
            'elif args[:1] == ["install"]: print("Success")\n')
        analyzer = root / 'apkanalyzer'
        analyzer.write_text('#!/bin/sh\necho wrong.package\n')
        analyzer.chmod(0o755)
        upgrade = [sys.executable, str(SCRIPT), 'upgrade', '--apk', str(root / 'fake.apk'), '--out', str(root / 'upgrade')]
        result = subprocess.run(upgrade, capture_output=True, text=True, env=env)
        assert result.returncode and 'application-id mismatch' in result.stderr
        assert 'install' not in trace.read_text(), 'mismatched APK installed'
        analyzer.write_text('#!/bin/sh\nif [ \"$2\" = debuggable ]; then echo true; else echo ' + m.FORMAL + '; fi\n')
        result = subprocess.run(upgrade, capture_output=True, text=True, env=env)
        assert result.returncode == 0, result.stderr
        assert json.loads((root / 'upgrade/data-compare.json').read_text())['equal']
        calls = trace.read_text()
        assert calls.index('exec-out') < calls.index('install -r') < calls.rindex('exec-out')
        assert not list((root / 'upgrade').glob('*.tar'))
        result = subprocess.run(upgrade, capture_output=True, text=True, env=env)
        assert result.returncode and 'fresh upgrade output directory' in result.stderr
        assert trace.read_text().count('install -r') == 1
        print('PASS: fake online upgrade ordering, APK mismatch guard, receipt overwrite guard')
        print('PASS: 9 dry-runs + 9 no-device exits + 5 destructive guards; canonical digest equivalence, diff and corrupt stream checks')


if __name__ == '__main__':
    main()
