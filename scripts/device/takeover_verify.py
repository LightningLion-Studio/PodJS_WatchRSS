#!/usr/bin/env python3
"""Private-content-free takeover receipts. pre reads debug source; post reads release logs.
No install, launch, extraction, content file, or raw log file is produced.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import struct
import subprocess
import sys
import tarfile
import threading
import time

ROOTS = ('databases', 'files', 'shared_prefs', 'no_backup')
FORMAT = 'pod-takeover-digest-v2'
LEGACY_FORMAT = 'pod-takeover-digest-v1'
FILES_WITHOUT_PLATFORM_METADATA = 'files_without_platform_metadata'
DIGEST_ROOTS = (*ROOTS, 'manifest', FILES_WITHOUT_PLATFORM_METADATA)
PLATFORM_METADATA = {'files/profileinstaller_profileWrittenFor_lastUpdateTime.dat', 'files/profileInstalled'}
FIELDS = {'phase', 'generation', 'root', 'files', 'bytes', 'sha256'}


def owned(path):
    root, _, child = path.partition('/')
    name = child.partition('/')[0]
    return ((root == 'files' and (name in ('podjs', 'package-takeover') or name.startswith('.podjs-')))
            or (root == 'databases' and (name == 'podjs.sqlite' or name.startswith('podjs.sqlite-')))
            or (root == 'no_backup' and name.startswith('podjs-')))


def summarize(entries):
    """Entries exist only in memory. Output is counts and aggregate hashes only."""
    if any(path.partition('/')[0] not in ROOTS for path in entries):
        raise ValueError('Unsupported digest root')
    result = {}
    for root in DIGEST_ROOTS:
        rows = {path if root == 'manifest' else path.partition('/')[2]: value
                for path, value in entries.items()
                if root == 'manifest' or path.partition('/')[0] == root
                or (root == FILES_WITHOUT_PLATFORM_METADATA and path.startswith('files/') and path not in PLATFORM_METADATA)}
        digest = hashlib.sha256()
        total = 0
        for path in sorted(rows, key=lambda p: p.encode('utf-8')):
            size, sha = rows[path]
            raw = path.encode('utf-8')
            if not 0 <= size <= (1 << 63) - 1 or not re.fullmatch('[a-f0-9]{64}', sha):
                raise ValueError('Invalid digest entry')
            total += size
            if total > (1 << 63) - 1:
                raise ValueError('Digest size overflow')
            digest.update(struct.pack('>I', len(raw)))
            digest.update(raw)
            digest.update(struct.pack('>Q', size))
            digest.update(bytes.fromhex(sha))
        result[root] = {'files': len(rows), 'bytes': total, 'sha256': digest.hexdigest()}
    return result


def stream_digest(stream, require_native=False):
    entries, seen = {}, set()
    with tarfile.open(fileobj=stream, mode='r|', encoding='utf-8', errors='strict') as archive:
        for member in archive:
            path = member.name
            if path.startswith('./'):
                path = path[2:]
            path = path.removesuffix('/') if member.isdir() else path
            if (not path or '\\' in path or any(p in ('', '.', '..') for p in path.split('/'))
                    or path.partition('/')[0] not in ROOTS or path in seen):
                raise ValueError('Invalid or duplicate archive entry')
            seen.add(path)
            if member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
                raise ValueError('Unsupported archive entry')
            if member.isdir() or owned(path):
                continue
            if '/' not in path:
                raise ValueError('Archive root must be a directory')
            digest = hashlib.sha256()
            size = 0
            with archive.extractfile(member) as content:
                while chunk := content.read(65536):
                    size += len(chunk)
                    digest.update(chunk)
            if size != member.size:
                raise ValueError('Incomplete archive entry')
            entries[path] = (size, digest.hexdigest())
    if require_native and 'databases/watchrss.db' not in entries:
        raise ValueError('Native source database unavailable')
    return summarize(entries)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path, 'x', encoding='utf-8', opener=lambda name, flags: os.open(name, flags, 0o600)) as out:
        json.dump(value, out, indent=2, ensure_ascii=True)
        out.write('\n')


def command(a, args):
    return subprocess.run(['adb', '-s', a.serial, *args], capture_output=True, text=True,
                          check=True, timeout=60).stdout


def package_metadata(a):
    text = command(a, ['shell', 'dumpsys', 'package', a.package])
    versions = re.findall(r'^\s*versionCode=(\d+)\b', text, re.M)
    flags = re.findall(r'^\s*(?:pkgFlags|flags)=\[([^\]]*)\]', text, re.M)
    uids = re.findall(r'^\s*userId=(\d+)\b', text, re.M)
    if len(versions) != 1 or len(uids) != 1 or not flags:
        raise ValueError('Installed package metadata unavailable')
    return {'versionCode': int(versions[0]), 'uid': int(uids[0]),
            'debuggable': any('DEBUGGABLE' in f.split() for f in flags)}


def pre(a):
    if a.out.exists():
        raise ValueError('Refusing to overwrite receipt')
    if a.dry_run:
        print('DRY RUN: verify DEBUGGABLE; force-stop source; run-as tar -> in-memory hashes -> pre JSON')
        return None
    metadata = package_metadata(a)
    if not metadata['debuggable']:
        raise ValueError('pre requires installed DEBUGGABLE source; no tar attempted')
    command(a, ['shell', 'am', 'force-stop', a.package])
    # An existing takeover means this is not a clean native baseline. Do not hide
    # old journal/backups inside the owned-path exclusion below.
    script = ('set --; for r in files/package-takeover files/.podjs-takeover-backup; do '
              'if [ -e "$r" ]; then exit 42; fi; done; '
              'for r in ' + ' '.join(ROOTS) + '; do '
              'if [ -d "$r" ]; then set -- "$@" "$r"; '
              'elif [ -e "$r" ]; then exit 43; fi; done; tar -cf - "$@"')
    cmd = ['adb', '-s', a.serial, 'exec-out',
           'run-as ' + shlex.quote(a.package) + ' sh -c ' + shlex.quote(script)]
    # Stderr is drained and discarded in memory: no tar, contents, paths, or
    # subprocess errors are ever written to disk or echoed to the terminal.
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        drain = threading.Thread(target=lambda: _discard(proc.stderr), daemon=True)
        drain.start()
        timer = threading.Timer(900, proc.kill)
        timer.start()
        try:
            roots = stream_digest(proc.stdout, require_native=True)
            if proc.wait(timeout=30):
                raise ValueError('Source tar failed; receipt discarded')
        except BaseException as error:
            proc.kill()
            proc.wait()
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            raise ValueError('Source tar failed; receipt discarded') from None
        finally:
            timer.cancel()
            proc.stdout.close()
            drain.join(timeout=5)
    receipt = {'format': FORMAT, 'package': a.package, 'serial': a.serial,
               'capturedAt': time.time(), 'source': metadata, 'roots': roots,
               'archiveStored': False, 'contentStored': False}
    write_json(a.out, receipt)
    print('PRE SAVED: aggregate JSON only; preservation remains PENDING')
    return receipt


def _discard(stream):
    while stream.read(65536):
        pass


def validate_summary(value):
    if (set(value) != {'files', 'bytes', 'sha256'}
            or type(value['files']) is not int or value['files'] < 0
            or type(value['bytes']) is not int or value['bytes'] < 0
            or not isinstance(value['sha256'], str)
            or not re.fullmatch('[a-f0-9]{64}', value['sha256'])):
        raise ValueError('Invalid aggregate receipt')


def validate_pre(before):
    if not isinstance(before, dict):
        raise ValueError('Invalid pre receipt')
    if (set(before) != {'format', 'package', 'serial', 'source', 'capturedAt', 'roots', 'archiveStored', 'contentStored'}
            or before.get('format') not in (FORMAT, LEGACY_FORMAT) or before.get('archiveStored') is not False
            or before.get('contentStored') is not False
            or before.get('source', {}).get('debuggable') is not True
            or type(before.get('capturedAt')) not in (int, float)
            or set(before.get('roots', {})) != set(DIGEST_ROOTS if before.get('format') == FORMAT else (*ROOTS, 'manifest'))):
        raise ValueError('Invalid pre receipt')
    if (not math.isfinite(before['capturedAt']) or before['capturedAt'] <= 0
            or set(before['source']) != {'versionCode', 'uid', 'debuggable'}
            or type(before['source']['versionCode']) is not int or before['source']['versionCode'] <= 0
            or type(before['source']['uid']) is not int or before['source']['uid'] <= 0):
        raise ValueError('Invalid source metadata')
    for summary in before['roots'].values():
        validate_summary(summary)

def compare_logs(before, log_lines, generation=None, pid=None):
    validate_pre(before)
    groups = {}
    # epoch output contains timestamp, pid, tid, priority, tag, and JSON. Require
    # timestamps newer than pre and the current package PID to reject stale logs.
    pattern = re.compile(r'^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+I\s+PodTakeoverDigest\s*:\s*(\{.*\})\s*$')
    for line in log_lines:
        match = pattern.fullmatch(line.rstrip('\n'))
        if not match:
            if 'PodTakeoverDigest' in line:
                raise ValueError('Malformed digest log')
            continue
        if float(match[1]) < before['capturedAt'] or (pid is not None and int(match[2]) != pid):
            continue
        row = json.loads(match[3])
        if (set(row) != FIELDS or row['phase'] not in ('SNAPSHOTTED', 'ACTIVE')
                or row['root'] not in DIGEST_ROOTS
                or not re.fullmatch('g-[a-zA-Z0-9-]+', row['generation'])):
            raise ValueError('Invalid digest log schema')
        summary = {key: row[key] for key in ('files', 'bytes', 'sha256')}
        validate_summary(summary)
        if generation is not None and row['generation'] != generation:
            continue
        phases = groups.setdefault(row['generation'], {'SNAPSHOTTED': {}, 'ACTIVE': {}})
        if row['phase'] == 'ACTIVE' and not set(before['roots']).issubset(phases['SNAPSHOTTED']):
            return {'status': 'FAIL', 'equal': False, 'reason': 'active_without_complete_snapshot'}
        phase = phases[row['phase']]
        if row['root'] in phase and phase[row['root']] != summary:
            raise ValueError('Conflicting digest log')
        phase[row['root']] = summary
    if len(groups) != 1:
        return {'status': 'FAIL', 'equal': False, 'reason': 'missing_or_ambiguous_generation'}
    g, phases = next(iter(groups.items()))
    changed = {phase: [root for root in before['roots']
                      if phases[phase].get(root) != before['roots'][root]]
               for phase in ('SNAPSHOTTED', 'ACTIVE')}
    equal = not any(changed.values())
    result = {'status': 'PASS' if equal else 'FAIL', 'equal': equal, 'generation': g,
              'changedRoots': changed,
              'policy': 'Full roots remain original-byte evidence; metadata exclusions are separate aggregates'}
    strict = ('databases', 'shared_prefs', 'no_backup')
    strict_equal = all(phases[phase].get(root) == before['roots'][root]
                       for phase in phases for root in strict)
    complete = all(set(before['roots']).issubset(phases[phase]) for phase in phases)
    result['strictRootsVerified'] = strict_equal and complete
    result['nonPlatformFilesVerified'] = (before['format'] == FORMAT and complete
        and all(phases[phase].get(FILES_WITHOUT_PLATFORM_METADATA) == before['roots'][FILES_WITHOUT_PLATFORM_METADATA]
                for phase in phases))
    if not equal and strict_equal and complete and all(
            set(roots) == {'files', 'manifest'} or not roots for roots in changed.values()):
        result['knownDifference'] = 'platform-metadata'
        if result['nonPlatformFilesVerified']:
            result['status'] = 'PASS_WITH_KNOWN_DIFFERENCES'
            result['attribution'] = 'Only exact platform metadata excluded by the strict files subset'
        elif before['format'] == LEGACY_FORMAT:
            result['status'] = 'PARTIAL'
            result['attribution'] = 'Expected platform metadata difference; legacy aggregates cannot prove which files changed'
            result['reason'] = 'legacy_files_subset_unavailable'
    return result


def post(a):
    if a.out.exists():
        raise ValueError('Refusing to overwrite report')
    if a.dry_run:
        print('DRY RUN: package UID/current PID + filtered epoch logcat -> compare pre JSON -> PASS/FAIL JSON')
        return None
    try:
        before = json.loads(a.pre.read_text())
        validate_pre(before)
        if before.get('package') != a.package or before.get('serial') != a.serial:
            raise ValueError('Receipt target mismatch')
        metadata = package_metadata(a)
        if metadata['uid'] != before['source']['uid'] or metadata['versionCode'] <= before['source']['versionCode']:
            raise ValueError('Installed UID/version does not match an in-place upgrade')
        pid_text = command(a, ['shell', 'pidof', a.package]).strip()
        if not re.fullmatch('[1-9][0-9]*', pid_text):
            raise ValueError('Current package process unavailable or ambiguous')
        pid = int(pid_text)
        result = compare_logs(before, command(a, ['logcat', '-d', '-v', 'epoch', '--pid=' + str(pid),
                                                '-s', 'PodTakeoverDigest:I', '*:S']).splitlines(), a.generation, pid)
    except Exception:
        write_json(a.out, {'status': 'FAIL', 'equal': False, 'package': a.package,
                          'serial': a.serial, 'reason': 'verification_unavailable_or_invalid'})
        raise ValueError('Verification unavailable; inspect aggregate FAIL report') from None
    result.update(package=a.package, serial=a.serial, source=before['source'], installed=metadata)
    write_json(a.out, result)
    print(result['status'] + ': original-byte protection ' + ('verified' if result['equal'] else 'unproven'))
    if result['status'] not in ('PASS', 'PASS_WITH_KNOWN_DIFFERENCES'):
        raise ValueError('Digest mismatch or incomplete logs; inspect aggregate report')
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('pre', 'post'))
    parser.add_argument('--serial', default='e3aca8af')
    parser.add_argument('--package', default='com.lightningstudio.watchrss')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--pre', type=Path)
    parser.add_argument('--generation')
    parser.add_argument('--dry-run', action='store_true')
    a = parser.parse_args()
    if not re.fullmatch('[A-Za-z0-9_.]+', a.package) or not re.fullmatch('[A-Za-z0-9_-]+', a.serial):
        parser.error('Unsafe target')
    if a.generation and not re.fullmatch('g-[a-zA-Z0-9-]+', a.generation):
        parser.error('Unsafe generation')
    if a.action == 'post' and not a.pre:
        parser.error('post requires --pre')
    (pre if a.action == 'pre' else post)(a)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('FAIL: verification unavailable; no preservation PASS. Check target, baseline, and aggregate report.', file=sys.stderr)
        sys.exit(1)
