#!/usr/bin/env python3
"""Offline APK release checks. stdout is JSON; stderr is the human summary.

Uses Android SDK apkanalyzer and apksig (apksigner.jar), plus Java 17+.
No ADB, network, signing properties, keystores or passwords are accessed.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LEDGER = ROOT / 'docs/release-ledger.json'
NATIVE40_COMPONENTS = ROOT / 'docs/release-baselines/native40-components.json'
INSTALLED40_DEBUG_COMPONENTS = ROOT / 'docs/release-baselines/native-installed-v40-debug-components.json'
RECOVERY_DEBUG_COMPONENTS = frozenset({
    ('activity', 'com.lightningstudio.watchrss.LlmSummaryActivity'),
    ('provider', 'com.lightningstudio.watchrss.debug.DebugLogProvider'),
    ('activity', 'com.lightningstudio.watchrss.debug.PerfLargeArticleActivity'),
    ('activity', 'com.lightningstudio.watchrss.debug.PerfLargeListActivity'),
})
ANDROID = '{http://schemas.android.com/apk/res/android}'
COMPONENT_TYPES = {'activity', 'activity-alias', 'receiver', 'provider', 'service'}
# T2 (d3a778cb) / T4 (6bbf8e5e) restore through WatchRssApplication's
# attachBaseContext hook. Neither adds a manifest component; no wildcard allowed.
RECOVERY_ADDED_COMPONENTS = frozenset()
MAX_CODE = 2_100_000_000
HEX = re.compile(r'^[0-9a-f]{64}$')
DEBUG_COMPONENTS = {
    'com.lightningstudio.watchrss.DouyinDebugEntryActivity',
    'com.lightningstudio.watchrss.LlmSummaryActivity',
    'com.lightningstudio.watchrss.debug.DouyinPlaybackDebugReceiver',
    'com.lightningstudio.watchrss.debug.DebugLogProvider',
    'dev.podjs.runtime.PodDebugExternal',
}


def integer(value, minimum=0, maximum=MAX_CODE):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f'expected integer in {minimum}..{maximum}')
    return value


def load_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f'duplicate JSON key: {key}')
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=pairs)


def load_ledger(path):
    ledger = load_json(Path(path).read_text())
    if not isinstance(ledger, dict) or ledger.get('schemaVersion') != 1:
        raise ValueError('unsupported release ledger schema')
    policy = ledger['policy']
    if not isinstance(policy, dict) or not isinstance(ledger['releases'], list):
        raise ValueError('invalid ledger policy/releases')
    for name in ('nativeAppId', 'packages', 'channels', 'versionRanges'):
        if name not in policy:
            raise ValueError(f'missing ledger policy: {name}')
    integer(policy['watchSdk'], 1, 1000)
    if not isinstance(policy['packages'], dict) or not isinstance(policy['channels'], dict):
        raise ValueError('invalid package/channel policies')
    for package in policy['packages'].values():
        if (not isinstance(package, dict) or not HEX.fullmatch(package['certSha256'])
                or type(package['highestPublishedVerified']) is not bool
                or not isinstance(package['allowedLineages'], list)):
            raise ValueError('invalid package signing/inventory policy')
        for chain in package['allowedLineages']:
            if (not isinstance(chain, list) or not chain or len(set(chain)) != len(chain)
                    or not all(HEX.fullmatch(cert) for cert in chain)
                    or chain[-1] != package['certSha256']):
                raise ValueError('invalid approved lineage')
    for channel in policy['channels'].values():
        if (not isinstance(channel, dict) or channel['kind'] not in ('coexistence', 'takeover', 'recovery')
                or not isinstance(channel['packages'], list) or not channel['packages']
                or any(pkg not in policy['packages'] for pkg in channel['packages'])
                or type(channel['betaAccepted']) is not bool
                or not isinstance(channel['sourceVersionCodes'], list) or not channel['sourceVersionCodes']):
            raise ValueError('invalid channel policy')
        for code in channel['sourceVersionCodes']:
            integer(code)
        if channel['approvedPurgeBackupAfter'] is not None:
            integer(channel['approvedPurgeBackupAfter'], 1)
    ranges = policy['versionRanges']
    stride = integer(ranges['stride'], 1)
    for kind in ('takeover', 'recovery'):
        low, high = ranges[kind]
        integer(low, 1, stride - 1)
        integer(high, low, stride - 1)
    seen = set()
    for entry in ledger['releases']:
        if not isinstance(entry, dict):
            raise ValueError('invalid release entry')
        for name in ('package', 'channel', 'versionCode', 'versionName', 'sourceRevs',
                     'apkSha256', 'cert', 'date', 'notes', 'status'):
            if name not in entry:
                raise ValueError(f'missing release field: {name}')
        integer(entry['versionCode'], 1)
        identity = (entry['package'], entry['channel'], entry['versionCode'])
        if identity in seen:
            raise ValueError('duplicate package/channel/versionCode in ledger')
        seen.add(identity)
        if entry['package'] not in policy['packages'] or entry['status'] not in (
                'published', 'installed-local', 'observed', 'local-candidate', 'source-baseline'):
            raise ValueError('unknown historical package/status')
        for name in ('apkSha256', 'cert'):
            if entry[name] is not None and not HEX.fullmatch(entry[name]):
                raise ValueError(f'invalid release {name}')
        dt.date.fromisoformat(entry['date'])
    return ledger


def component_node(node):
    """Keep every AXML attribute and child; ignore only XML formatting whitespace."""
    return {'type': node.tag, 'attributes': dict(sorted(node.attrib.items())),
            'children': [component_node(child) for child in node]}


def parse_manifest(xml):
    root = ET.fromstring(xml)
    if root.tag != 'manifest':
        raise ValueError('missing manifest root')
    apps = root.findall('application')
    if len(apps) != 1:
        raise ValueError('expected one application')
    app = apps[0]
    debuggable = app.get(ANDROID + 'debuggable', 'false')
    if debuggable not in ('true', 'false'):
        raise ValueError('unresolved debuggable attribute')
    # Version codes are Android signed positive ints; versionCodeMajor is forbidden
    # here so a low 32-bit code cannot conceal an incompatible long version code.
    if root.get(ANDROID + 'versionCodeMajor', '0') != '0':
        raise ValueError('versionCodeMajor unsupported by this version ledger')
    code = root.get(ANDROID + 'versionCode', '')
    if not code.isdecimal():
        raise ValueError('missing/unresolved versionCode')
    package = root.get('package', '')
    metadata = {}
    for node in app.findall('meta-data'):
        name = node.get(ANDROID + 'name')
        if name in metadata:
            raise ValueError('duplicate application meta-data')
        metadata[name] = node.get(ANDROID + 'value')
    debug = []
    components = set()
    details = []
    for node in app.iter():
        if node.tag not in COMPONENT_TYPES:
            continue
        name = node.get(ANDROID + 'name', '')
        if not name or not re.fullmatch(r'[A-Za-z_$][A-Za-z0-9_.$]*', name.lstrip('.')):
            raise ValueError('missing/unresolved component name')
        qualified = package + name if name.startswith('.') else name
        if '.' not in qualified:
            qualified = package + '.' + qualified
        identity = (node.tag, qualified)
        if identity in components:
            raise ValueError('duplicate manifest component identity')
        components.add(identity)
        details.append({'type': node.tag, 'name': qualified, 'node': component_node(node)})
        values = ' '.join(node.attrib.values()) + ' ' + ' '.join(
            str(v) for child in node.iter() for v in child.attrib.values())
        if (qualified in DEBUG_COMPONENTS or re.search(
                r'(?:\.debug(?:\.|log\b)|debug\.action\.|PodDebugExternal|debug-external)', values, re.I)):
            debug.append(qualified)
    return {'appId': package, 'versionCode': integer(int(code), 1),
            'versionName': root.get(ANDROID + 'versionName', ''),
            'debuggable': debuggable == 'true', 'metadata': metadata,
            'components': [{'type': tag, 'name': name} for tag, name in sorted(components)],
            'componentDetails': sorted(details, key=lambda item: (item['type'], item['name'])),
            'debugExternalComponents': sorted(set(debug))}


def component_set(components):
    if not isinstance(components, list):
        raise ValueError('manifest components must be a list')
    result = set()
    for item in components:
        if (not isinstance(item, dict) or item.get('type') not in COMPONENT_TYPES
                or not isinstance(item.get('name'), str)
                or not re.fullmatch(r'(?:[A-Za-z_$][A-Za-z0-9_$]*\.)+[A-Za-z_$][A-Za-z0-9_$]*', item['name'])):
            raise ValueError('invalid manifest component identity')
        result.add((item['type'], item['name']))
    return result


def recovery_baseline(ledger):
    """Read the checked-in APK summary, tied to the ledger's local code40 APK.

    This evidence is deliberately independent of public version inventory and
    installed APK provenance; it does not approve either of those gates.
    """
    baseline = load_json(NATIVE40_COMPONENTS.read_text())
    if (not isinstance(baseline, dict) or baseline.get('schemaVersion') != 1
            or baseline.get('appId') != ledger['policy']['nativeAppId']
            or baseline.get('versionCode') != 40
            or not isinstance(baseline.get('apkSha256'), str)
            or not HEX.fullmatch(baseline['apkSha256'])):
        raise ValueError('invalid native40 component baseline')
    matches = [r for r in ledger['releases']
               if r['package'] == baseline['appId'] and r['versionCode'] == 40
               and r['channel'] == 'native-local-baseline' and r['status'] == 'local-candidate'
               and r['apkSha256'] == baseline['apkSha256']
               and r.get('manifestComponents') == 'docs/release-baselines/native40-components.json']
    if len(matches) != 1:
        raise ValueError('native40 component baseline does not match ledger APK record')
    components = component_set(baseline.get('components'))
    if not components:
        raise ValueError('empty native40 component baseline')
    return baseline, components


def recovery_debug_baseline(ledger):
    """Four exact exceptions from the installed v40 AXML, linked by ledger hashes."""
    path = 'docs/release-baselines/native-installed-v40-debug-components.json'
    raw = INSTALLED40_DEBUG_COMPONENTS.read_bytes()
    baseline = load_json(raw.decode('utf-8'))
    if (baseline.get('schemaVersion') != 1
            or baseline.get('appId') != ledger['policy']['nativeAppId']
            or baseline.get('versionCode') != 40
            or not HEX.fullmatch(baseline.get('apkSha256', ''))
            or not HEX.fullmatch(baseline.get('axmlSha256', ''))
            or baseline.get('certSha256') != ledger['policy']['packages'][baseline['appId']]['certSha256']):
        raise ValueError('invalid installed40 debug component baseline')
    matches = [r for r in ledger['releases']
               if r['package'] == baseline['appId'] and r['versionCode'] == 40
               and r['channel'] == 'native-observation' and r['status'] == 'observed'
               and r['apkSha256'] == baseline['apkSha256'] and r['cert'] == baseline['certSha256']
               and r.get('axmlSha256') == baseline['axmlSha256']
               and r.get('manifestDebugComponents') == path
               and r.get('manifestDebugComponentsSha256') == hashlib.sha256(raw).hexdigest()]
    if len(matches) != 1:
        raise ValueError('installed40 debug baseline does not match ledger APK/AXML/summary')
    components = baseline.get('components')
    if component_set(components) != RECOVERY_DEBUG_COMPONENTS or len(components) != 4:
        raise ValueError('installed40 debug baseline must contain exactly the four approved components')
    for item in components:
        node = item['node']
        if (node['type'] != item['type'] or node['attributes'].get(ANDROID + 'name') != item['name']
                or not isinstance(node['children'], list)):
            raise ValueError('invalid installed40 debug component node')
    return baseline, {(item['type'], item['name']): item['node'] for item in components}


def sdk_tools(sdk=None):
    sdk = Path(sdk or os.environ.get('ANDROID_SDK_ROOT') or
               os.environ.get('ANDROID_HOME') or Path.home() / 'Android/Sdk')
    analyzer = sdk / 'cmdline-tools/latest/bin/apkanalyzer'
    if not analyzer.is_file():
        raise ValueError('SDK apkanalyzer missing; pass --sdk')
    jars = list((sdk / 'build-tools').glob('*/lib/apksigner.jar'))
    jars.sort(key=lambda p: tuple(int(n) for n in re.findall(r'\d+', p.parents[1].name)))
    if not jars:
        raise ValueError('SDK apksigner.jar missing; pass --sdk')
    java = shutil.which('java')
    if not java:
        raise ValueError('Java 17+ required')
    return analyzer, jars[-1], java


def run(argv):
    result = subprocess.run([str(v) for v in argv], capture_output=True, text=True,
                            timeout=120, check=False)
    if result.returncode:
        # Only public APK/tool diagnostics; cap output and never accept partial reads.
        raise ValueError(f'{Path(argv[0]).name} failed: {result.stderr.strip()[:1500]}')
    return result.stdout


def sha256(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def inspect_apk(apk, sdk=None, watch_sdk=30):
    apk = Path(apk).resolve(strict=True)
    before = sha256(apk)
    analyzer, jar, java = sdk_tools(sdk)
    manifest = parse_manifest(run([analyzer, 'manifest', 'print', apk]))
    signature = load_json(run([java, '--class-path', jar,
                              Path(__file__).with_name('ApkPublicInfo.java'), apk, watch_sdk]))
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        for name in ('AndroidManifest.xml', 'assets/pod.manifest.json'):
            if names.count(name) > 1:
                raise ValueError(f'duplicate APK entry: {name}')
        if 'assets/pod.manifest.json' in names:
            info = archive.getinfo('assets/pod.manifest.json')
            if info.file_size > 1024 * 1024:
                raise ValueError('oversized pod.manifest.json')
            pod = load_json(archive.read(info).decode('utf-8'))
            if not isinstance(pod, dict):
                raise ValueError('pod.manifest.json must be an object')
        else:
            pod = None
    if sha256(apk) != before:
        raise ValueError('APK changed during inspection')
    return {**manifest, 'apkSha256': before, 'signature': signature, 'podManifest': pod}


def evaluate(facts, channel, ledger):
    checks = []

    def check(name, passed, detail):
        checks.append({'name': name, 'passed': bool(passed), 'detail': detail})

    policy = ledger['policy']
    app_id = facts['appId']
    package = policy['packages'].get(app_id)
    target = policy['channels'].get(channel)
    check('appId', bool(package and target and app_id in target['packages']),
          f'{app_id}, channel={channel}')
    if not package or not target or app_id not in target['packages']:
        return {'ok': False, 'channel': channel, 'apk': facts, 'checks': checks}

    history = [r['versionCode'] for r in ledger['releases'] if r['package'] == app_id]
    highest = max(history, default=0)
    code = facts['versionCode']
    check('versionCode', code > highest,
          f'{code} must be > {highest} (all channels; observations also reserve codes)')
    check('publicationInventory', package['highestPublishedVerified'] is True,
          'all-channel highest must be confirmed in ledger policy')
    kind = target['kind']
    if kind in ('takeover', 'recovery'):
        ranges = policy['versionRanges']
        stride = integer(ranges['stride'], 1)
        low, high = ranges[kind]
        check('reservedVersionRange', low <= code % stride <= high,
              f'{kind}: code modulo {stride} in {low}..{high}')
    check('nonDebuggable', facts['debuggable'] is False, 'release APK must be non-debuggable')
    signature = facts['signature']
    check('signatureVerified', signature.get('verified') is True,
          f'cryptographic verification across APK SDK range and SDK {policy["watchSdk"]}')
    expected = package['certSha256']
    check('certificate', signature.get('certificatesSha256') == [expected]
          and signature.get('watchCertificatesSha256') == [expected],
          f'expected single current signer {expected}')
    lineage = signature.get('lineage')
    chain = [c.get('sha256') for c in lineage] if isinstance(lineage, list) else None
    lineage_ok = chain == [] or (signature.get('v3') is True
        and chain in package['allowedLineages'] and chain[-1] == expected
        and all(c.get('installedData') is True for c in lineage))
    check('v3Lineage', lineage_ok, 'if embedded: verified, approved ordered chain, installed-data capability')
    if kind == 'recovery':
        try:
            baseline, allowed = recovery_baseline(ledger)
            unexpected = component_set(facts.get('components')) - (allowed | RECOVERY_ADDED_COMPONENTS)
            check('recoveryComponents', not unexpected, {
                'baselineApkSha256': baseline['apkSha256'],
                'approvedAdditions': [{'type': tag, 'name': name}
                                     for tag, name in sorted(RECOVERY_ADDED_COMPONENTS)],
                'unexpected': [{'type': tag, 'name': name} for tag, name in sorted(unexpected)]})
        except (ValueError, KeyError, TypeError, OSError) as error:
            check('recoveryComponents', False, str(error))
        try:
            baseline, exact = recovery_debug_baseline(ledger)
            details = facts['componentDetails']
            if component_set(details) != component_set(facts['components']):
                raise ValueError('component details do not match manifest identities')
            unexpected_debug = []
            for name in facts['debugExternalComponents']:
                nodes = [item for item in details if item['name'] == name]
                if len(nodes) != 1 or nodes[0]['node'] != exact.get((nodes[0]['type'], name)):
                    unexpected_debug.append(name)
            check('debugExternal', not unexpected_debug, {
                'baselineApkSha256': baseline['apkSha256'],
                'baselineAxmlSha256': baseline['axmlSha256'],
                'unexpectedOrChanged': unexpected_debug})
        except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
            check('debugExternal', False, str(error))
    else:
        check('debugExternal', not facts['debugExternalComponents'],
              facts['debugExternalComponents'])

    metadata = facts['metadata']
    source_key = 'dev.podjs.takeover.sourceVersionCode'
    purge_key = 'dev.podjs.takeover.purgeBackupAfter'
    try:
        source = integer(int(metadata.get(source_key, '0')))
        purge = integer(int(metadata.get(purge_key, '0')))
        valid_meta = True
    except (ValueError, TypeError):
        source, purge, valid_meta = None, None, False
    source_ok = valid_meta and source in target['sourceVersionCodes']
    if kind in ('takeover', 'coexistence'):
        source_ok = source_ok and source_key in metadata and purge_key in metadata
    check('takeoverSourceVersionCode', source_ok,
          f'{source}; expected {target["sourceVersionCodes"]}')
    approved = target['approvedPurgeBackupAfter']
    purge_ok = valid_meta and (purge == 0 or (
        target['betaAccepted'] is True and approved is not None and purge == approved and purge <= code))
    check('purgeBackupAfter', purge_ok,
          f'{purge}; nonzero requires betaAccepted and exact approved threshold <= candidate code')

    pod = facts['podManifest']
    check('podManifest', kind == 'recovery' or isinstance(pod, dict),
          'PodJS release requires packaged assets/pod.manifest.json')
    wm = pod.get('androidWorkManagerTakeover') if isinstance(pod, dict) else None
    has_wm = isinstance(pod, dict) and 'androidWorkManagerTakeover' in pod
    if kind == 'takeover':
        wm_ok = has_wm and isinstance(wm, dict) and wm == policy['workManagerTakeover']
    else:
        wm_ok = not has_wm
    wm_ok = wm_ok and (not has_wm or app_id == policy['nativeAppId'])
    check('workManagerTakeover', wm_ok,
          'only nativeAppId may package takeover config; takeover requires exact legacy identities')
    return {'ok': all(c['passed'] for c in checks), 'channel': channel,
            'apk': facts, 'checks': checks}


def record(apk, channel, ledger_path, source_revs, date, notes, sdk=None):
    """Reinspect the exact APK and append only after every gate passes.

    Serialize writers with a stable sidecar lock; atomic replace, no policy edits.
    A preflight receipt alone is deliberately insufficient for recording.
    """
    ledger_path = Path(ledger_path).resolve()
    dt.date.fromisoformat(date)
    if not notes.strip() or not source_revs or any(not v.strip() for v in source_revs.values()):
        raise ValueError('record requires source revisions and nonempty publication notes')
    with ledger_path.with_suffix(ledger_path.suffix + '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ledger = load_ledger(ledger_path)
        facts = inspect_apk(apk, sdk, ledger['policy']['watchSdk'])
        result = evaluate(facts, channel, ledger)
        if not result['ok']:
            return result
        entry = {'package': facts['appId'], 'channel': channel, 'versionCode': facts['versionCode'],
                 'versionName': facts['versionName'], 'sourceRevs': source_revs,
                 'apkSha256': facts['apkSha256'], 'cert': facts['signature']['certificatesSha256'][0],
                 'date': date, 'notes': notes, 'status': 'published'}
        ledger['releases'].append(entry)
        temp_name = None
        try:
            with tempfile.NamedTemporaryFile('w', dir=ledger_path.parent, prefix='.release-ledger-',
                                             delete=False) as temp:
                temp_name = temp.name
                json.dump(ledger, temp, ensure_ascii=False, indent=2)
                temp.write('\n')
                temp.flush()
                os.fsync(temp.fileno())
            os.chmod(temp_name, ledger_path.stat().st_mode & 0o777)
            os.replace(temp_name, ledger_path)
            directory = os.open(ledger_path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temp_name and Path(temp_name).exists():
                Path(temp_name).unlink()
        result['recorded'] = entry
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('check', 'record'):
        sub = commands.add_parser(command)
        sub.add_argument('apk', type=Path)
        sub.add_argument('--channel', required=True)
        sub.add_argument('--ledger', type=Path, default=DEFAULT_LEDGER)
        sub.add_argument('--sdk', type=Path)
        if command == 'record':
            sub.add_argument('--source-rev', action='append', required=True, metavar='REPO=REV')
            sub.add_argument('--date', required=True, help='publication date YYYY-MM-DD')
            sub.add_argument('--notes', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'check':
            ledger = load_ledger(args.ledger)
            facts = inspect_apk(args.apk, args.sdk, ledger['policy']['watchSdk'])
            result = evaluate(facts, args.channel, ledger)
        else:
            revisions = {}
            for item in args.source_rev:
                name, sep, rev = item.partition('=')
                if not sep or not name or not rev or name in revisions:
                    raise ValueError('--source-rev must be unique REPO=REV pairs')
                revisions[name] = rev
            result = record(args.apk, args.channel, args.ledger, revisions,
                            args.date, args.notes, args.sdk)
    except (ValueError, KeyError, TypeError, OSError, ET.ParseError, zipfile.BadZipFile,
            subprocess.TimeoutExpired) as error:
        result = {'ok': False, 'channel': args.channel, 'error': str(error)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print('PASS' if result['ok'] else 'FAIL', file=sys.stderr)
    if 'apk' in result:
        apk = result['apk']
        print(f'{apk["appId"]} code={apk["versionCode"]} name={apk["versionName"]}', file=sys.stderr)
    for check in result.get('checks', []):
        print(f'{"PASS" if check["passed"] else "FAIL"} {check["name"]}: {check["detail"]}', file=sys.stderr)
    if 'error' in result:
        print(result['error'], file=sys.stderr)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
