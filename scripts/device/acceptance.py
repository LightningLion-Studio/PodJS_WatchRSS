#!/usr/bin/env python3
"""OWW242 acceptance commands. All device commands support --dry-run (no I/O)."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FORMAL = 'com.lightningstudio.watchrss.podjs'
ISOLATED = FORMAL + '.acceptance'
FRAMEWORK = Path('/home/wilf/data/PodJS/podjs-watch')
TESTS = ['PodWebViewServicesTest', 'PodSpeechSpectrumTest', 'PodInAppBrowserTest',
         'PodBrowserAuthStatusTest', 'PodVideoSessionServicesTest']


def run(cmd, dry=False, output=None, cwd=None):
    print(('[cwd=' + str(cwd) + '] ' if cwd else '') + shlex.join(map(str, cmd)) +
          (' > ' + shlex.quote(str(output)) if output else ''), flush=True)
    if dry:
        return ''
    if output:
        with Path(output).open('xb') as stream:
            subprocess.run(cmd, cwd=cwd, stdout=stream, check=True, timeout=900)
        return ''
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                          check=True, timeout=900).stdout


def table_digest(path):
    with sqlite3.connect(path) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('SQLite integrity_check failed')
        tables = {}
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
            q = '"' + table.replace('"', '""') + '"'
            columns = [r[1] for r in db.execute('PRAGMA table_info(' + q + ')')]
            encoded = sorted(json.dumps(row, ensure_ascii=True, separators=(',', ':'),
                default=lambda v: {'base64': base64.b64encode(v).decode()})
                for row in db.execute('SELECT * FROM ' + q))
            tables[table] = {'columns': columns, 'rows': len(encoded),
                'sha256': hashlib.sha256('\n'.join(encoded).encode()).hexdigest()}
        return tables


def stream_digest(stream, temp):
    # Same row serialization as verification/library-data-digest.py. No tar on disk;
    # retain only SQLite + sidecars temporarily for transaction-consistent row hashes.
    files = {}
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            if not member.isfile():
                continue
            name = member.name.removeprefix('./')
            h = hashlib.sha256()
            target = None
            if name in {'databases/podjs.sqlite' + suffix for suffix in ('', '-wal', '-shm', '-journal')}:
                target = (Path(temp) / Path(name).name).open('wb')
            try:
                with archive.extractfile(member) as source:
                    while chunk := source.read(1024 * 1024):
                        h.update(chunk)
                        if target:
                            target.write(chunk)
            finally:
                if target:
                    target.close()
            files[name] = h.hexdigest()
    db = Path(temp) / 'podjs.sqlite'
    if not db.exists():
        raise ValueError('No databases/podjs.sqlite: receipt refused (run-as/package/data unavailable)')
    return {'files': files, 'tables': table_digest(db), 'integrity': 'ok',
            'format': 'stream-digest-v1', 'archiveStored': False}


def snapshot(a, label):
    output = a.out / (label + '-digest.json')
    if output.exists():
        raise ValueError('Refusing to overwrite receipt: ' + str(output))
    run(a.adb + ['shell', 'am', 'force-stop', a.package], a.dry_run)
    cmd = a.adb + ['exec-out', 'run-as', a.package, 'tar', '-cf', '-', 'databases', 'files', 'shared_prefs']
    print(shlex.join(cmd) + ' | streaming SHA256/SQLite digest -> ' + str(output), flush=True)
    if a.dry_run:
        return None
    with tempfile.TemporaryDirectory(prefix='wrss-digest-') as temp, tempfile.TemporaryFile() as errors:
        with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors) as proc:
            try:
                receipt = stream_digest(proc.stdout, temp)
            except BaseException:
                proc.kill()
                raise
            finally:
                proc.stdout.close()
            if proc.wait(timeout=30):
                raise ValueError('ADB tar failed; incomplete receipt discarded (check run-as and all data directories)')
    receipt.update(package=a.package, serial=a.serial)
    output.write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def compare_receipts(before, after):
    # Strict, fail closed. Migration/startup differences require explicit human review.
    changed = {}
    for section in ('files', 'tables'):
        left, right = before[section], after[section]
        changed[section] = [k for k in sorted(left.keys() | right.keys()) if left.get(k) != right.get(k)]
    return {'equal': not any(changed.values()), 'changed': changed,
            'policy': 'strict; no automatic allowance for cache/schema/startup changes'}


def android_tool(name):
    # SDK tools are host-only; never consult signing properties or key material.
    import shutil
    found = shutil.which(name)
    if found:
        return found
    sdk = os.environ.get('ANDROID_SDK_ROOT') or os.environ.get('ANDROID_HOME')
    if sdk:
        if name == 'apkanalyzer':
            found = Path(sdk) / 'cmdline-tools/latest/bin' / name
            if found.is_file():
                return str(found)
        else:
            for version in sorted((Path(sdk) / 'build-tools').glob('*'),
                                  key=lambda p: tuple(int(x) for x in p.name.split('.') if x.isdigit()), reverse=True):
                if (version / name).is_file():
                    return str(version / name)
    raise ValueError('Missing Android SDK tool: ' + name)


def apk_certificates(a, apk, sdk=None):
    import re
    cmd = [a.apksigner, 'verify', '--print-certs']
    if sdk is not None:
        cmd += ['--min-sdk-version', str(sdk), '--max-sdk-version', str(sdk)]
    text = run(cmd + [str(apk)], a.dry_run)
    certs = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$', text, re.M)
    if not a.dry_run and not certs:
        raise ValueError('No verified APK signing certificate; chain refused')
    return sorted(c.lower() for c in certs)


def apk_metadata(a, apk, sdk):
    fields = {}
    for key, verb in [('package', 'application-id'), ('versionCode', 'version-code'), ('debuggable', 'debuggable')]:
        fields[key] = run([a.apkanalyzer, 'manifest', verb, str(apk)], a.dry_run).strip()
    if not a.dry_run:
        if fields['package'] != a.package:
            raise ValueError('APK application-id mismatch; chain refused before installation')
        if not fields['versionCode'].isdigit() or int(fields['versionCode']) < 1:
            raise ValueError('Invalid APK versionCode')
        if fields['debuggable'] not in ('true', 'false'):
            raise ValueError('Unknown APK debuggable flag')
        fields['versionCode'] = int(fields['versionCode'])
        fields['debuggable'] = fields['debuggable'] == 'true'
        with Path(apk).open('rb') as stream:
            fields['sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
    fields['certificatesSha256'] = apk_certificates(a, apk, sdk)
    return fields


def installed_metadata(a):
    import re
    text = run(a.adb + ['shell', 'dumpsys', 'package', a.package], a.dry_run)
    if a.dry_run:
        return {'versionCode': None, 'debuggable': None}
    # versionCode/flags from the active package entry, not historical signatures.
    versions = re.findall(r'^\s*versionCode=(\d+)\b', text, re.M)
    flags = re.findall(r'^\s*(?:pkgFlags|flags)=\[([^\]]*)\]', text, re.M)
    if len(versions) != 1 or not flags:
        raise ValueError('Cannot read installed package version/flags; chain stopped')
    return {'versionCode': int(versions[0]), 'debuggable': any('DEBUGGABLE' in f.split() for f in flags)}


def installed_certificates(a, sdk):
    paths = run(a.adb + ['shell', 'pm', 'path', a.package], a.dry_run)
    if a.dry_run:
        print('Dry run: pull installed base.apk to a temporary directory and verify signer SHA256')
        return []
    bases = [line.removeprefix('package:') for line in paths.splitlines()
             if line.startswith('package:') and line.endswith('/base.apk')]
    if len(bases) != 1:
        raise ValueError('Cannot identify installed base APK; chain stopped')
    with tempfile.TemporaryDirectory(prefix='wrss-installed-cert-') as temp:
        apk = Path(temp) / 'base.apk'
        run(a.adb + ['pull', bases[0], str(apk)])
        return apk_certificates(a, apk, sdk)


def upgrade_chain(a):
    for name in ('before-digest.json', 'after-digest.json', 'data-compare.json', 'chain-install.json'):
        if (a.out / name).exists():
            raise ValueError('Use a fresh upgrade output directory; existing ' + name)
    a.apkanalyzer = 'apkanalyzer' if a.dry_run else android_tool('apkanalyzer')
    a.apksigner = 'apksigner' if a.dry_run else android_tool('apksigner')
    paths = [*a.apk, a.verify_apk]
    if not a.dry_run:
        if any(not path.is_file() for path in paths):
            raise ValueError('All chain APKs must exist before installation')
        if len({path.resolve() for path in paths}) != len(paths):
            raise ValueError('Chain APK paths must be distinct')
    run(a.adb + ['shell', 'am', 'force-stop', a.package], a.dry_run)
    initial = installed_metadata(a)
    if not a.dry_run and not initial['debuggable']:
        raise ValueError('Current package must be debuggable/run-as accessible; no installation attempted')
    sdk_text = run(a.adb + ['shell', 'getprop', 'ro.build.version.sdk'], a.dry_run).strip()
    if not a.dry_run and not sdk_text.isdigit():
        raise ValueError('Cannot read device SDK; chain refused')
    sdk = int(sdk_text) if not a.dry_run else None
    metadata = [apk_metadata(a, path, sdk) for path in paths]
    if not a.dry_run:
        if not metadata[-1]['debuggable']:
            raise ValueError('Verification APK must be debuggable; no installation attempted')
        previous = initial['versionCode']
        for info in metadata:
            if info['versionCode'] <= previous:
                raise ValueError('Chain versionCodes must strictly increase above installed version')
            previous = info['versionCode']
            if info['certificatesSha256'] != metadata[0]['certificatesSha256']:
                raise ValueError('Chain APK signing certificates differ; no installation attempted')
    # This must actually succeed (not just FLAG_DEBUGGABLE) before any installation.
    before = snapshot(a, 'before')
    log = {'initial': initial, 'steps': [], 'applicationLaunchRequested': False, 'complete': False}
    def save_log():
        if not a.dry_run:
            (a.out / 'chain-install.json').write_text(json.dumps(log, indent=2) + '\n')
    save_log()
    for path, info in zip(paths, metadata):
        step = {'apk': str(path), 'expected': info, 'verified': False}
        log['steps'].append(step)
        save_log()
        try:
            if not a.dry_run:
                with path.open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != info['sha256']:
                        raise ValueError('APK changed after preflight; chain stopped')
            output = run(a.adb + ['install', '-r', str(path)], a.dry_run)
            # Some adb versions can return exit0 even when the package manager refuses.
            if not a.dry_run and (not any(line.strip() == 'Success' for line in output.splitlines()) or 'Failure' in output):
                raise ValueError('APK installation rejected; chain stopped without uninstall')
            run(a.adb + ['shell', 'am', 'force-stop', a.package], a.dry_run)
            actual = installed_metadata(a)
            actual['certificatesSha256'] = installed_certificates(a, sdk)
            step['actual'] = actual
            if not a.dry_run and any(actual[k] != info[k] for k in ('versionCode', 'debuggable', 'certificatesSha256')):
                raise ValueError('Installed version/debuggable/certificate mismatch; chain stopped')
            step['verified'] = not a.dry_run
            save_log()
        except (ValueError, OSError, subprocess.SubprocessError):
            step['error'] = 'Install/readback refused or failed; no subsequent APK installed, no uninstall attempted'
            save_log()
            raise
    after = snapshot(a, 'after')
    if not a.dry_run:
        result = compare_receipts(before, after)
        # Identical JSON structure/policy to the ordinary upgrade receipts.
        (a.out / 'data-compare.json').write_text(json.dumps(result, indent=2) + '\n')
        log['complete'] = True
        save_log()
        if not result['equal']:
            raise ValueError('Data changed; inspect data-compare.json. Do not mark preservation PASS')


def main():
    os.umask(0o077)  # Local receipts/logs can contain private metadata.
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['rehearse-takeover', 'digest', 'upgrade', 'upgrade-chain', 'cold-start', 'routes', 'capture', 'compare', 'framework-tests', 'logs', 'reset-isolated'])
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--serial', default=os.environ.get('ANDROID_SERIAL', 'e3aca8af'))
    p.add_argument('--package', default=FORMAL)
    p.add_argument('--out', type=Path, default=ROOT / 'artifacts/device-acceptance')
    p.add_argument('--label', default='before')
    p.add_argument('--apk', type=Path, action='append', help='Repeat in installation order for upgrade-chain')
    p.add_argument('--verify-apk', type=Path, help='Final debuggable data verification APK')
    p.add_argument('--test-apk', type=Path)
    p.add_argument('--cleanup-private', action='store_true')
    p.add_argument('--takeover-timeout', type=int, default=300)
    p.add_argument('--reference', type=Path)
    p.add_argument('--actual', type=Path)
    p.add_argument('--framework', type=Path, default=FRAMEWORK)
    p.add_argument('--allow-destructive', action='store_true')
    a = p.parse_args()
    import re
    if not re.fullmatch(r'[A-Za-z0-9_.]+', a.package) or not re.fullmatch(r'[A-Za-z0-9_-]+', a.label):
        p.error('Unsafe package or label')
    if a.action == 'upgrade-chain' and (not a.apk or not a.verify_apk):
        p.error('upgrade-chain requires one or more --apk and --verify-apk')
    if a.action != 'upgrade-chain':
        if a.apk and len(a.apk) != 1:
            p.error('Multiple --apk are supported only by upgrade-chain')
        a.apk = a.apk[0] if a.apk else None
    if a.action == 'upgrade' and not a.apk:
        p.error('upgrade requires --apk')
    if a.action == 'compare' and (not a.reference or not a.actual):
        p.error('compare requires --reference and --actual')
    if a.action == 'routes' and not a.allow_destructive:
        p.error('routes fixture writes isolated test data; requires --allow-destructive')
    if a.action == 'reset-isolated' and (not a.allow_destructive or a.package != ISOLATED):
        p.error('reset requires --allow-destructive AND --package ' + ISOLATED)
    a.adb = ['adb', '-s', a.serial]
    if a.action == 'rehearse-takeover':
        from takeover_rehearsal import rehearse, REHEARSAL
        if a.package != REHEARSAL or not a.apk or not a.test_apk:
            p.error('rehearse-takeover requires --package ' + REHEARSAL + ' --apk and --test-apk')
        if not 1 <= a.takeover_timeout <= 3600:
            p.error('takeover timeout must be 1..3600 seconds')
        rehearse(a)
        return
    if not a.dry_run:
        # Even compare is gated: a live acceptance run must identify its target.
        try:
            state = subprocess.run(a.adb + ['get-state'], capture_output=True, text=True, timeout=10)
        except FileNotFoundError:
            p.error('adb not installed; use --dry-run for offline planning')
        if state.returncode or state.stdout.strip() != 'device':
            p.error('Device ' + a.serial + ' not online/authorized; connect OWW242 or use --dry-run')
        a.out.mkdir(parents=True, exist_ok=True)
    if a.action == 'digest':
        snapshot(a, a.label)
    elif a.action == 'upgrade-chain':
        upgrade_chain(a)
    elif a.action == 'upgrade':
        for name in ('before-digest.json', 'after-digest.json', 'data-compare.json'):
            if (a.out / name).exists():
                raise ValueError('Use a fresh upgrade output directory; existing ' + name)
        # Inspect identity BEFORE any adb install. Never trust filename/appId supplied by caller.
        identity = run(['apkanalyzer', 'manifest', 'application-id', str(a.apk)], a.dry_run).strip()
        if not a.dry_run and identity != a.package:
            raise ValueError('APK application-id mismatch; installation refused')
        before = snapshot(a, 'before')
        print(run(a.adb + ['install', '-r', str(a.apk)], a.dry_run))
        after = snapshot(a, 'after')
        if not a.dry_run:
            result = compare_receipts(before, after)
            (a.out / 'data-compare.json').write_text(json.dumps(result, indent=2) + '\n')
            if not result['equal']:
                raise ValueError('Data changed; inspect data-compare.json. Do not mark preservation PASS')
    elif a.action == 'cold-start':
        run(a.adb + ['shell', 'am', 'force-stop', a.package], a.dry_run)
        result = run(a.adb + ['shell', 'am', 'start', '-W', '-n', a.package + '/dev.podjs.androidwatch.MainActivity'], a.dry_run)
        print(result)
        if not a.dry_run and ('Status: ok' not in result or 'Error:' in result):
            raise ValueError('Activity launch failed')
        print('Launch command only; verify rendered UI, then capture. No route/gesture PASS implied.')
    elif a.action == 'routes':
        # Existing fixture seeds/writes state; NEVER point it at the formal package.
        android = a.framework / 'platforms/android'
        run(['./gradlew', ':androidApp:assembleDebug', ':androidApp:assembleDebugAndroidTest',
             '-PpodAppId=' + ISOLATED, '-PpodAppName=WatchRSSAcceptance',
             '-PpodDistDir=' + str(a.framework / 'dist/projects' / FORMAL / 'android-watch'),
             '-PpodTestAssetsDir=' + str(ROOT / 'tests/android/assets'),
             '-PpodTestSourceDir=' + str(ROOT / 'tests/android/java')], a.dry_run, cwd=android)
        for path in ['app/build/outputs/apk/debug/androidApp-debug.apk', 'app/build/outputs/apk/androidTest/debug/androidApp-debug-androidTest.apk']:
            run(a.adb + ['install', '-r', str(android / path)], a.dry_run)
        classes = ','.join('dev.podjs.androidwatch.WatchRssSmokeTest#' + name for name in
            ['launchesRendersAndInitializesChannelsDatabase', 'migratedRoutesReturnToHomeRoot'])
        instrument(a, ISOLATED + '.test', classes, 'routes.txt')
    elif a.action == 'framework-tests':
        android = a.framework / 'platforms/android'
        run(['./gradlew', ':runtime:assembleDebugAndroidTest'], a.dry_run, cwd=android)
        run(a.adb + ['install', '-r', str(android / 'runtime/build/outputs/apk/androidTest/debug/runtime-debug-androidTest.apk')], a.dry_run)
        instrument(a, 'dev.podjs.runtime.test', ','.join('dev.podjs.runtime.' + n for n in TESTS), 'framework-tests.txt')
    elif a.action == 'capture':
        run(a.adb + ['exec-out', 'screencap', '-p'], a.dry_run, a.out / (a.label + '.png'))
        run(a.adb + ['shell', 'dumpsys', 'window'], a.dry_run, a.out / (a.label + '-window.txt'))
        run(a.adb + ['shell', 'wm', 'size'], a.dry_run, a.out / (a.label + '-size.txt'))
        run(a.adb + ['shell', 'wm', 'density'], a.dry_run, a.out / (a.label + '-density.txt'))
    elif a.action == 'compare':
        run([sys.executable, str(ROOT / 'scripts/compare-ui.py'), str(a.reference), str(a.actual)], a.dry_run, a.out / (a.label + '-rgb-mae.json'))
    elif a.action == 'logs':
        for name, cmd in [('logcat', ['logcat', '-d', '-t', '2000', '-v', 'threadtime']),
                          ('package', ['shell', 'dumpsys', 'package', a.package]),
                          ('window', ['shell', 'dumpsys', 'window']),
                          ('gfxinfo', ['shell', 'dumpsys', 'gfxinfo', a.package]),
                          ('device', ['shell', 'getprop'])]:
            run(a.adb + cmd, a.dry_run, a.out / (a.label + '-' + name + '.txt'))
        print('Raw local diagnostics may contain secrets: review/redact before any sharing; no upload performed.')
    elif a.action == 'reset-isolated':
        print(run(a.adb + ['shell', 'pm', 'clear', ISOLATED], a.dry_run))


def instrument(a, package, classes, name):
    result = run(a.adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', classes,
                         package + '/androidx.test.runner.AndroidJUnitRunner'], a.dry_run)
    if not a.dry_run:
        (a.out / name).write_text(result)
        import re
        if not re.search(r'OK \([1-9][0-9]* tests?\)', result) or any(s in result for s in ['FAILURES!!!', 'INSTRUMENTATION_FAILED', 'Process crashed']):
            raise ValueError('Instrumentation did not PASS; inspect ' + str(a.out / name))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError, sqlite3.Error) as exc:
        print('ERROR: ' + str(exc), file=sys.stderr)
        if isinstance(exc, subprocess.CalledProcessError):
            print((exc.stderr or exc.stdout or '')[-4000:], file=sys.stderr)
        sys.exit(1)
