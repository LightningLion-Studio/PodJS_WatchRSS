#!/usr/bin/env python3
"""Emulator-only phase exits using the production MainActivity and host factory.

Owns only the freshly installed rehearsal package. Never reads a formal package.
The fixture is synthetic; repeated cases reset only that owned emulator sandbox.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tarfile
import time
import xml.etree.ElementTree as ET
from takeover_rehearsal import activated, command, manifest, properties, unpack, REHEARSAL, PHASES

TEST = 'dev.podjs.runtime.PodTakeoverMigrationTest'
RUNNER = REHEARSAL + '.test/androidx.test.runner.AndroidJUnitRunner'
ACTIVITY = REHEARSAL + '/dev.podjs.androidwatch.MainActivity'


def start(adb, recreate=False):
    command(adb + ['shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER',
                   '-f', '0x14000000' if recreate else '0x10200000', '-n', ACTIVITY])


def checked_emulator(serial):
    if not re.fullmatch(r'emulator-[0-9]+', serial):
        raise ValueError('emulator_required')
    adb = ['adb', '-s', serial]
    if command(adb + ['shell', 'getprop', 'ro.kernel.qemu']).strip() != b'1':
        raise ValueError('emulator_required')
    return adb


def instrument(adb, method, output, phase='', work=''):
    args = adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', TEST + '#' + method,
                  '-e', 'productionSandbox', 'true']
    if method == 'migrate':
        args += ['-e', 'keepAlive', 'true']
    if phase:
        args += ['-e', 'stopPhase', phase]
    if work:
        args += ['-e', 'stopWork', work]
    return subprocess.Popen(args + [RUNNER], stdout=output, stderr=subprocess.STDOUT)


def read(adb, path):
    p = subprocess.run(adb + ['exec-out', 'run-as', REHEARSAL, 'cat', path], capture_output=True, timeout=15)
    if p.returncode:
        return {}
    return dict(line.split('=', 1) for line in p.stdout.decode('iso-8859-1').splitlines()
                if '=' in line and not line.startswith(('#', '!')))


def wait(adb, predicate, timeout=240, began=None, process=None):
    began = time.monotonic() if began is None else began
    until = time.monotonic() + timeout
    samples = []
    while time.monotonic() < until:
        p = read(adb, 'files/package-takeover/journal')
        progress = read(adb, 'files/package-takeover/progress')
        percent = int(progress.get('percent', '0'))
        sample = {'phase': p.get('phase', ''), 'percent': percent, 'reason': p.get('reason', '')}
        if not samples or any(sample[k] != samples[-1][k] for k in sample):
            sample['elapsedMs'] = round((time.monotonic()-began)*1000)
            samples.append(sample)
        if predicate(p):
            return p, samples
        if process is not None and process.poll() is not None:
            raise ValueError('instrumentation_ended_before_phase')
        if p.get('phase') in ('PAUSED', 'BLOCKED'):
            raise ValueError('migration_halted_' + p.get('reason', 'unknown'))
        time.sleep(.15)
    raise ValueError('migration_observation_timeout')


def upload(adb, fixture):
    command(adb + ['shell', 'am', 'force-stop', REHEARSAL])
    # The runner refuses any pre-existing installation before it owns this UID.
    # These exact roots contain only this run's synthetic data and derived stores.
    command(adb + ['shell', 'run-as', REHEARSAL, 'rm', '-rf', 'files', 'databases', 'shared_prefs', 'no_backup', 'cache', 'stopped', 'work-checkpoint', 'instrumentation-complete'])
    command(adb + ['shell', 'run-as', REHEARSAL, 'mkdir', '-p', 'files', 'databases', 'shared_prefs'])
    proc = subprocess.Popen(adb + ['exec-in', 'run-as', REHEARSAL, 'tar', '-xf', '-'], stdin=subprocess.PIPE)
    with tarfile.open(fileobj=proc.stdin, mode='w|') as archive:
        for path in sorted(fixture.iterdir()):
            archive.add(path, arcname=path.name)
    proc.stdin.close()
    if proc.wait(timeout=60):
        raise ValueError('fixture_upload_failed')


def capture(adb, destination):
    destination.mkdir()
    proc = subprocess.Popen(adb + ['exec-out', 'run-as', REHEARSAL, 'tar', '-cf', '-', 'files'], stdout=subprocess.PIPE)
    try:
        unpack(proc.stdout, destination)
        if proc.wait(timeout=60):
            raise ValueError('capture_failed')
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def probe(adb, method, folder):
    with (folder / (method + '.txt')).open('wb') as output:
        proc = instrument(adb, method, output)
        proc.wait(timeout=60)
    if 'OK (1 test)' not in (folder / (method + '.txt')).read_text():
        raise ValueError('post_active_edit_probe_failed')


def first_frame(adb, folder):
    until = time.monotonic() + 30
    while time.monotonic() < until:
        pid = subprocess.run(adb + ['shell', 'pidof', REHEARSAL], capture_output=True, timeout=15).stdout.decode().strip()
        if pid.isdigit():
            log = command(adb + ['logcat', '-d', '--pid', pid, '-v', 'brief', 'PodJSPerf:I', 'AndroidRuntime:E', 'PodJS:E', '*:S'])
            (folder / 'first-frame.log').write_bytes(log)
            if b'firstMainFrameMs=' in log:
                (folder / 'active.png').write_bytes(command(adb + ['exec-out', 'screencap', '-p']))
                return pid
        time.sleep(.2)
    raise ValueError('guest_first_frame_timeout')


def run(args):
    adb = checked_emulator(args.serial)
    if not 0 <= args.settle_seconds <= 30:
        raise ValueError('settle_duration_invalid')
    if args.work_step and args.phases != ['COPYING']:
        raise ValueError('work_gate_requires_copying_phase')
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    for apk, package in ((args.apk, REHEARSAL), (args.test_apk, REHEARSAL + '.test')):
        if command(['apkanalyzer', 'manifest', 'application-id', str(apk)]).decode().strip() != package:
            raise ValueError('apk_identity_mismatch')
        lookup = subprocess.run(adb + ['shell', 'pm', 'path', package], capture_output=True, timeout=15)
        if lookup.stdout.strip():
            raise ValueError('existing_rehearsal_refused')
    if command(['apkanalyzer', 'manifest', 'debuggable', str(args.apk)]).strip() != b'true':
        raise ValueError('debug_apk_required')
    app_manifest = ET.fromstring(command(['apkanalyzer', 'manifest', 'print', str(args.apk)]))
    if any(node.get('{http://schemas.android.com/apk/res/android}name') == 'android.permission.INTERNET' for node in app_manifest.findall('uses-permission') + app_manifest.findall('uses-permission-sdk-23')):
        raise ValueError('offline_apk_required')
    xml = ET.fromstring(command(['apkanalyzer', 'manifest', 'print', str(args.test_apk)]))
    runner = xml.find('instrumentation')
    if runner is None or runner.get('{http://schemas.android.com/apk/res/android}targetPackage') != REHEARSAL:
        raise ValueError('test_target_mismatch')
    result = {'cases': [], 'formalPackageTouched': False, 'source': manifest(args.fixture)}
    owned = False
    try:
        command(adb + ['install', str(args.apk)]); owned = True
        command(adb + ['install', str(args.test_apk)])
        # The manifest gate blocks sockets without changing emulator network settings.
        for phase in args.phases:
            for mode in args.modes:
                label = phase + '-' + mode
                folder = args.output / label; folder.mkdir()
                upload(adb, args.fixture)
                command(adb + ['shell', 'input', 'keyevent', '224'])
                began = time.monotonic()
                with (folder / 'instrument.txt').open('wb') as output:
                    proc = instrument(adb, 'migrate', output, '' if args.work_step else phase, args.work_step)
                    try:
                        stopped, samples = wait(adb, lambda p: p.get('phase') == phase, began=began, process=proc)
                        # The checkpoint gate follows the phase journal and progress checkpoint.
                        until = time.monotonic() + 10
                        while time.monotonic() < until:
                            gate = subprocess.run(adb + ['exec-out', 'run-as', REHEARSAL, 'cat', 'stopped'], capture_output=True, timeout=15)
                            if gate.returncode == 0 and gate.stdout.decode() == phase:
                                break
                            time.sleep(.05)
                        else:
                            raise ValueError('phase_gate_missing')
                        work = read(adb, 'work-checkpoint') if args.work_step else {}
                        if args.work_step and not (0 < int(work.get('done', '0')) < int(work.get('total', '0'))):
                            raise ValueError('partial_work_checkpoint_missing')
                        old_pid = command(adb + ['shell', 'pidof', REHEARSAL]).decode().strip()
                        start(adb); time.sleep(1.5)
                        (folder / 'held.png').write_bytes(command(adb + ['exec-out', 'screencap', '-p']))
                        if mode == 'home':
                            command(adb + ['shell', 'input', 'keyevent', '3'])
                            start(adb); time.sleep(1.5)
                            (folder / 'returned.png').write_bytes(command(adb + ['exec-out', 'screencap', '-p']))
                            command(adb + ['shell', 'run-as', REHEARSAL, 'rm', 'stopped'])
                        elif mode == 'recreate':
                            start(adb, recreate=True); time.sleep(1.5)
                            (folder / 'returned.png').write_bytes(command(adb + ['exec-out', 'screencap', '-p']))
                            command(adb + ['shell', 'run-as', REHEARSAL, 'rm', 'stopped'])
                        elif mode == 'force-stop':
                            command(adb + ['shell', 'am', 'force-stop', REHEARSAL])
                        else:
                            if not old_pid.isdigit() or int(old_pid) <= 1:
                                raise ValueError('ambiguous_process')
                            command(adb + ['shell', 'run-as', REHEARSAL, 'kill', '-TERM', old_pid])
                        if mode not in ('home', 'recreate'):
                            proc.wait(timeout=30)
                            start(adb)
                        active, resumed = wait(adb, lambda p: p.get('phase') == 'ACTIVE', began=began)
                        samples += resumed
                        if mode in ('home', 'recreate'):
                            until = time.monotonic() + 60
                            while read(adb, 'instrumentation-complete').get('phase') != 'ACTIVE':
                                if proc.poll() is not None or time.monotonic() >= until:
                                    raise ValueError('home_instrumentation_failed')
                                time.sleep(.1)
                        if active.get('generation') != stopped.get('generation'):
                            raise ValueError('resume_generation_changed')
                        new_pid = first_frame(adb, folder)
                        if (mode in ('home', 'recreate')) != (old_pid == new_pid):
                            raise ValueError('exit_mode_process_identity_mismatch')
                        if any(a['percent'] > b['percent'] for a, b in zip(samples, samples[1:])):
                            raise ValueError('progress_moved_backwards')
                        if args.settle_seconds:
                            time.sleep(args.settle_seconds)
                        command(adb + ['shell', 'am', 'force-stop', REHEARSAL])
                        proc.wait(timeout=30)
                        capture(adb, folder / 'snapshot')
                        candidate, identity = activated(folder / 'snapshot')
                        backup = folder / 'snapshot/files/.podjs-takeover-backup' / identity['generation'] / 'data'
                        actual = manifest(backup)
                        unchanged = all(actual.get(k) == v for k, v in result['source'].items())
                        if not unchanged:
                            raise ValueError('source_backup_changed')
                        kv = json.loads((candidate / 'podjs/podjs-kv.json').read_text())
                        if kv.get('watchrss.settings', {}).get('fontSizeSp') != 16 or kv.get('watchrss.onboarding') != {'oobeSeenVersion': 3, 'privacyPolicyAgreedVersion': 1}:
                            raise ValueError('settings_readback_mismatch')
                        import sys
                        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'migration'))
                        from takeover_oracle import compare
                        oracle = compare(args.fixture, candidate)
                        if not oracle['pass']:
                            raise ValueError('core_oracle_failed')
                        with sqlite3.connect(candidate / 'podjs.sqlite') as db:
                            schema = db.execute('PRAGMA user_version').fetchone()[0]
                            if args.settle_seconds and schema != 9:
                                raise ValueError('guest_schema_incomplete')
                            if db.execute('SELECT count(*) FROM memo_notes').fetchone()[0] != 400 or db.execute('SELECT count(*) FROM offline_media').fetchone()[0] != 200:
                                raise ValueError('notes_or_media_count_mismatch')
                            with sqlite3.connect(args.fixture / 'databases/watchrss.db') as source:
                                notes = source.execute('SELECT noteId,folderId,title,markdown,plainText,contentHash,baseContentHash,baseMarkdown,pinned,createdAt,updatedAt,modifiedBy,deleted,deletedAt FROM watch_notes ORDER BY noteId').fetchall()
                                actual_notes = db.execute('SELECT note_id,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at FROM memo_notes ORDER BY note_id').fetchall()
                                if notes != actual_notes:
                                    raise ValueError('note_readback_mismatch')
                                media = [r[:4]+(r[4].split('/files/',1)[1],r[5]) for r in source.execute('SELECT id,itemId,mediaType,originUrl,localPath,createdAt FROM offline_media ORDER BY id')]
                                if media != db.execute('SELECT id,item_id,media_type,origin_url,relative_path,created_at FROM offline_media ORDER BY id').fetchall():
                                    raise ValueError('media_readback_mismatch')
                        probe(adb, 'writePostActiveEdit', folder)
                        start(adb)
                        again, restarted = wait(adb, lambda p: p.get('phase') == 'ACTIVE', began=began)
                        if (again.get('generation'), again.get('receipt')) != (active.get('generation'), active.get('receipt')):
                            raise ValueError('active_reimported')
                        probe(adb, 'verifyPostActiveEdit', folder)
                        case = {'phase': phase, 'mode': mode, 'pass': True, 'elapsedMs': round((time.monotonic()-began)*1000),
                                'sourceBackupUnchanged': unchanged, 'sameGeneration': True, 'restartNoReimport': True, 'postActiveEditRetained': True, 'noteAndMediaReadback': True, 'settingsReadback': True, 'oracle': oracle, 'samples': samples,
                                'workStep': args.work_step, 'workCheckpoint': work, 'oldPid': int(old_pid), 'newPid': int(new_pid), 'guestFirstFrame': True}
                        case['guestSchemaVersion'] = schema
                        result['cases'].append(case)
                        (folder / 'result.json').write_text(json.dumps(case, indent=2))
                        shutil.rmtree(folder / 'snapshot')
                        print(label + ' PASS', flush=True)
                    except BaseException as error:
                        result['pass'] = False
                        result['error'] = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z0-9_]+', str(error)) else type(error).__name__
                        try:
                            command(adb + ['shell', 'am', 'force-stop', REHEARSAL])
                            state = read(adb, 'files/package-takeover/journal')
                            (folder / 'failure-state.json').write_text(json.dumps({k: state[k] for k in ('phase', 'resumePhase', 'reason', 'generation', 'requiredBytes', 'availableBytes') if k in state}, indent=2))
                            capture(adb, folder / 'failed-snapshot')
                        except Exception:
                            result['failureSnapshot'] = 'unavailable'
                        raise
                    finally:
                        if proc.poll() is None:
                            command(adb + ['shell', 'am', 'force-stop', REHEARSAL]);proc.wait(timeout=30)
                        (folder / 'host.log').write_bytes(command(adb + ['logcat', '-d', '-v', 'epoch', 'PodTakeover:I', 'PodTakeoverPhase:I', 'PodJSPerf:I', '*:S']))
        result['pass'] = len(result['cases']) == len(args.phases)*len(args.modes)
    finally:
        if owned:
            for package in (REHEARSAL + '.test', REHEARSAL):
                subprocess.run(adb + ['uninstall', package], capture_output=True, timeout=30)
            result['cleanup'] = all(not subprocess.run(adb + ['shell', 'pm', 'path', package], capture_output=True, timeout=15).stdout.strip() for package in (REHEARSAL + '.test', REHEARSAL))
        (args.output / 'result.json').write_text(json.dumps(result, indent=2))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--serial', required=True)
    p.add_argument('--apk', type=Path, required=True)
    p.add_argument('--test-apk', type=Path, required=True)
    p.add_argument('--fixture', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--phases', nargs='+', choices=PHASES, default=PHASES)
    p.add_argument('--modes', nargs='+', choices=['exit', 'home', 'force-stop', 'recreate'], default=['exit', 'home', 'force-stop', 'recreate'])
    p.add_argument('--work-step', choices=['room', 'roomVerify'], default='')
    p.add_argument('--settle-seconds', type=float, default=0, help='After first frame, wait at most 30s and require guest schema 9')
    run(p.parse_args())
