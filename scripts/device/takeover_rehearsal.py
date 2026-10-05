#!/usr/bin/env python3
"""Isolated P3 runner. No device operation at import time. Invoked by acceptance.py."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time

NATIVE = 'com.lightningstudio.watchrss'
REHEARSAL = 'com.lightningstudio.watchrss.podjs.rehearsal'
PHASES = ['DETECTED', 'SNAPSHOTTED', 'COPYING', 'VERIFYING', 'READY', 'ACTIVATING', 'ACTIVE']
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/migration'))
from takeover_oracle import compare as oracle


def command(cmd, *, data=None):
    if cmd[0] == 'apkanalyzer' and not shutil.which('apkanalyzer'):
        sdk = os.environ.get('ANDROID_SDK_ROOT') or os.environ.get('ANDROID_HOME')
        if not sdk:
            raise ValueError('android_sdk_not_configured')
        analyzer = Path(sdk) / 'cmdline-tools/latest/bin/apkanalyzer'
        if not analyzer.is_file():
            raise ValueError('apkanalyzer_missing')
        cmd = [str(analyzer), *cmd[1:]]
    result = subprocess.run(cmd, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)
    if result.returncode:
        # stderr may contain user filenames, tokens or SQLite content. Do not echo it.
        raise ValueError('device_command_failed')
    return result.stdout


def manifest(root):
    result = {}
    for p in sorted(root.rglob('*')):
        if p.is_file():
            with p.open('rb') as data:
                result[p.relative_to(root).as_posix()] = hashlib.file_digest(data, 'sha256').hexdigest()
    return result


def unpack(stream, root, *, native=False):
    seen = set()
    total = 0
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            name = member.name.removeprefix('./').rstrip('/')
            path = PurePosixPath(name)
            if not name or path.is_absolute() or '..' in path.parts or '\\' in name or str(path) != name:
                raise ValueError('unsafe_archive_path')
            if path.parts[0] not in ('databases', 'files', 'shared_prefs'):
                raise ValueError('unexpected_archive_root')
            if name in seen or not (member.isdir() or member.isfile()):
                raise ValueError('duplicate_or_nonregular_archive_entry')
            seen.add(name)
            if native and (name.startswith('files/package-takeover') or name.startswith('files/podjs') or name.startswith('databases/podjs.sqlite')):
                raise ValueError('source_contains_podjs_state')
            total += member.size
            if len(seen) > 1000000 or total > 32 * 1024**3:
                raise ValueError('archive_limit_exceeded')
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
            else:
                with archive.extractfile(member) as source, target.open('xb') as dest:
                    shutil.copyfileobj(source, dest, 1024 * 1024)


def capture(adb, package, root, *, native=False):
    root.mkdir(mode=0o700)
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(adb + ['exec-out', 'run-as', package, 'tar', '-cf', '-', 'databases', 'files', 'shared_prefs'], stdout=subprocess.PIPE, stderr=errors)
        timer = threading.Timer(900, proc.kill)
        timer.start()
        try:
            unpack(proc.stdout, root, native=native)
            if proc.wait(timeout=30):
                raise ValueError('snapshot_failed')
        finally:
            timer.cancel()
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
            proc.wait()
    return manifest(root)


def upload(adb, root):
    with tempfile.TemporaryFile() as output:
        proc = subprocess.Popen(adb + ['exec-in', 'run-as', REHEARSAL, 'tar', '-xf', '-'], stdin=subprocess.PIPE, stdout=output, stderr=output)
        timer = threading.Timer(900, proc.kill)
        timer.start()
        try:
            with tarfile.open(fileobj=proc.stdin, mode='w|') as archive:
                for path in sorted(root.rglob('*')):
                    info = archive.gettarinfo(str(path), arcname=path.relative_to(root).as_posix())
                    info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    info.mode = 0o700 if path.is_dir() else 0o600
                    if path.is_file():
                        with path.open('rb') as data:
                            archive.addfile(info, data)
                    else:
                        archive.addfile(info)
            proc.stdin.close()
            if proc.wait(timeout=30):
                raise ValueError('isolated_import_failed')
        finally:
            timer.cancel()
            if proc.poll() is None:
                proc.kill()
            proc.wait()


def properties(path):
    # Only fixed ASCII protocol fields are consumed, never source inventory values.
    result = {}
    for line in path.read_text(encoding='iso-8859-1').splitlines():
        if '=' in line and not line.startswith(('#', '!')):
            key, value = line.split('=', 1)
            if key in ('phase', 'generation', 'receipt', 'reason'):
                result[key] = value
    return result


def activated(root):
    base = root / 'files/package-takeover'
    journal = properties(base / 'journal')
    if journal.get('phase') != 'ACTIVE':
        raise ValueError('takeover_not_active')
    generation, receipt = journal.get('generation', ''), journal.get('receipt', '')
    if not re.fullmatch(r'g-[a-zA-Z0-9-]+', generation) or not re.fullmatch(r'[a-f0-9]{64}', receipt):
        raise ValueError('invalid_activation_identity')
    candidate = base / 'generations' / generation
    expected = {'generation': generation, 'receipt': receipt}
    if properties(base / 'active') != expected or properties(candidate / 'activation-receipt') != expected:
        raise ValueError('activation_receipt_mismatch')
    return candidate, expected


def unchanged(source, actual):
    return all(actual.get(k) == v for k, v in source.items())


def write(root, name, value):
    (root / name).write_text(json.dumps(value, indent=2) + '\n')


def launch(adb, root, label, timeout):
    # Capture before launch; scoped tag holds fixed phase names only. Filter launch PID.
    log = root / (label + '-phases.log')
    with log.open('wb') as output:
        proc = subprocess.Popen(adb + ['logcat', '-T', '1', '-v', 'brief', 'PodTakeoverPhase:I', '*:S'], stdout=output, stderr=subprocess.DEVNULL)
        try:
            result = command(adb + ['shell', 'am', 'start', '-n', REHEARSAL + '/dev.podjs.androidwatch.MainActivity'])
            if b'Starting: Intent' not in result or b'Error:' in result:
                raise ValueError('launch_failed')
            pid = ''
            for _ in range(50):
                try:
                    pid = command(adb + ['shell', 'pidof', REHEARSAL]).decode().strip()
                except ValueError:
                    pass
                if pid.isdigit():
                    break
                time.sleep(0.1)
            if not pid.isdigit():
                raise ValueError('ambiguous_process')
            end = time.monotonic() + timeout
            state = {}
            while time.monotonic() < end:
                try:
                    raw = command(adb + ['exec-out', 'run-as', REHEARSAL, 'cat', 'files/package-takeover/journal']).decode('iso-8859-1')
                    state = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line and not line.startswith('#'))
                except ValueError:
                    pass
                if state.get('phase') in ('ACTIVE', 'BLOCKED', 'PAUSED'):
                    break
                time.sleep(0.25)
            time.sleep(0.3)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.wait()
    phases = re.findall(r'I/PodTakeoverPhase\(\s*' + pid + r'\): (\w+)', log.read_text())
    # Save only codes, not raw logcat (other processes can use the same tag).
    log.unlink()
    reason = state.get('reason', '')
    return {'phase': state.get('phase', 'TIMEOUT'), 'phases': phases,
            'reason': reason if re.fullmatch(r'[a-z0-9_]{0,96}', reason) else 'redacted'}


def dry_plan(a):
    print('DRY RUN: no subprocesses, local writes, or device I/O')
    print('Verify APK applicationId=' + REHEARSAL + ', debuggable=true; verify test APK target; refuse existing rehearsal installation.')
    print('mkdtemp /tmp/wrss-rehearsal-* mode 0700; never retain tar archives.')
    print('adb -s ' + a.serial + ' shell am force-stop ' + NATIVE)
    print('adb -s ' + a.serial + ' exec-out run-as ' + NATIVE + ' tar -cf - databases files shared_prefs -> private validated copy + SHA256')
    print('Install fresh rehearsal APK and its instrumentation APK only; import sanitized tar into rehearsal sandbox.')
    print('Check imported source SHA256; cold launch with debug phase trace; require ' + ' -> '.join(PHASES))
    print('Stop rehearsal; validate journal/pointer/receipt, unchanged source, SQLite/KV oracle.')
    print('Restart rehearsal; same ACTIVE generation/receipt, no conversion stages; run read/render instrumentation.')
    print('Finally re-read native SHA256; report counts/codes only. Cleanup: adb uninstall ' + REHEARSAL + '.test; adb uninstall ' + REHEARSAL)


def rehearse(a):
    if a.dry_run:
        dry_plan(a)
        return
    # Check both APKs before any device write, including native force-stop.
    if command(['apkanalyzer', 'manifest', 'application-id', str(a.apk)]).decode().strip() != REHEARSAL:
        raise ValueError('rehearsal_apk_identity_mismatch')
    if command(['apkanalyzer', 'manifest', 'debuggable', str(a.apk)]).decode().strip() != 'true':
        raise ValueError('rehearsal_apk_not_debuggable')
    if command(['apkanalyzer', 'manifest', 'application-id', str(a.test_apk)]).decode().strip() != REHEARSAL + '.test':
        raise ValueError('test_apk_identity_mismatch')
    import xml.etree.ElementTree as ET
    xml = ET.fromstring(command(['apkanalyzer', 'manifest', 'print', str(a.test_apk)]))
    runner = xml.find('instrumentation')
    if runner is None or runner.get('{http://schemas.android.com/apk/res/android}targetPackage') != REHEARSAL:
        raise ValueError('test_apk_target_mismatch')
    for package in (REHEARSAL, REHEARSAL + '.test'):
        check = subprocess.run(a.adb + ['shell', 'pm', 'path', package], capture_output=True, timeout=30)
        if check.returncode not in (0, 1) or check.stderr.strip():
            raise ValueError('package_lookup_failed')
        if check.stdout.strip():
            raise ValueError('existing_rehearsal_refused_uninstall_explicitly')
    root = Path(tempfile.mkdtemp(prefix='wrss-rehearsal-', dir='/tmp'))
    os.chmod(root, 0o700)
    result = {'outcome': 'FAIL', 'device': 'executed', 'formalPackageTouched': False}
    before = None
    print('Private evidence directory: ' + str(root), flush=True)
    try:
        command(a.adb + ['shell', 'am', 'force-stop', NATIVE])
        before = capture(a.adb, NATIVE, root / 'native', native=True)
        write(root, 'native-sha256.json', before)
        if 'databases/watchrss.db' not in before:
            raise ValueError('native_database_missing')
        command(a.adb + ['install', str(a.apk)])
        command(a.adb + ['install', str(a.test_apk)])
        command(a.adb + ['shell', 'am', 'force-stop', REHEARSAL])
        upload(a.adb, root / 'native')
        imported = capture(a.adb, REHEARSAL, root / 'imported')
        if not unchanged(before, imported):
            raise ValueError('import_digest_mismatch')
        shutil.rmtree(root / 'imported')
        result['firstLaunch'] = launch(a.adb, root, 'first', a.takeover_timeout)
        command(a.adb + ['shell', 'am', 'force-stop', REHEARSAL])
        first = capture(a.adb, REHEARSAL, root / 'first')
        result['sourceCopyUnchanged'] = unchanged(before, first)
        if not result['sourceCopyUnchanged']:
            raise ValueError('source_copy_changed')
        if result['firstLaunch']['phase'] != 'ACTIVE':
            result['outcome'] = 'BLOCKED'
            raise ValueError('takeover_blocked_or_incomplete')
        if result['firstLaunch']['phases'] != PHASES:
            raise ValueError('phase_sequence_incomplete')
        candidate, identity = activated(root / 'first')
        result['oracle'] = oracle(root / 'native', candidate)
        if not result['oracle']['pass']:
            raise ValueError('core_oracle_mismatch')
        result['secondLaunch'] = launch(a.adb, root, 'second', a.takeover_timeout)
        command(a.adb + ['shell', 'am', 'force-stop', REHEARSAL])
        second = capture(a.adb, REHEARSAL, root / 'second')
        candidate2, identity2 = activated(root / 'second')
        result['restartNoReimport'] = identity == identity2 and not result['secondLaunch']['phases'] and unchanged(before, second)
        # Candidate import artifacts must remain unchanged; live production stores may change legitimately.
        g1, g2 = manifest(candidate), manifest(candidate2)
        immutable = {k: v for k, v in g1.items() if k != 'podjs.sqlite' and not k.startswith(('podjs/', 'podjs.sqlite-'))}
        result['restartNoReimport'] &= unchanged(immutable, g2)
        if not result['restartNoReimport']:
            raise ValueError('restart_reimport_or_source_change')
        output = command(a.adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class',
                                 'dev.podjs.androidwatch.TakeoverRehearsalTest',
                                 REHEARSAL + '.test/androidx.test.runner.AndroidJUnitRunner'])
        result['hostReadAndRender'] = bool(re.search(rb'OK \([1-9][0-9]* tests?\)', output)) and not any(x in output for x in (b'FAILURES!!!', b'INSTRUMENTATION_FAILED', b'Process crashed'))
        if not result['hostReadAndRender']:
            raise ValueError('read_render_instrumentation_failed')
        result['outcome'] = 'PASS'
    except Exception as error:
        # Fixed allowlisted script errors only. Never echo external exception text.
        code = str(error)
        result['error'] = code if isinstance(error, ValueError) and re.fullmatch('[a-z_]+', code) else type(error).__name__
    finally:
        if before is not None:
            try:
                after = capture(a.adb, NATIVE, root / 'native-after', native=True)
                result['nativeUnchanged'] = before == after
                write(root, 'native-after-sha256.json', after)
                shutil.rmtree(root / 'native-after')
            except Exception:
                result['nativeUnchanged'] = False
            if not result['nativeUnchanged']:
                result['outcome'] = 'FAIL'
        write(root, 'result.json', result)
        print(json.dumps(result, indent=2))
        print('Recovery: adb -s ' + a.serial + ' uninstall ' + REHEARSAL + '.test; adb -s ' + a.serial + ' uninstall ' + REHEARSAL)
        if a.cleanup_private:
            shutil.rmtree(root)
            print('Private host copies removed; isolated package still requires explicit uninstall.')
    if result['outcome'] != 'PASS':
        raise ValueError('rehearsal_not_passed')
