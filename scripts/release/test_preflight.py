"""Offline policy, APK reader, CLI and append tests; never create/read signing keys."""
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import preflight as p

FIXTURE = Path(__file__).parent / 'fixtures/manifest.xml'
# Frozen ledger: real releases keep appending to docs/release-ledger.json, which must not move test expectations.
LEDGER_FIXTURE = Path(__file__).parent / 'fixtures/ledger.json'
RECOVERY_FIXTURE = FIXTURE.with_name('recovery-manifest.xml')
CERT = 'f06d28ffff88ed9ac41bbb3e0cd845a05773f8536cf1095dfe7cacfabedb831d'
OLD = 'a8d7d64efa7ed36af6a7e1a3850eb6d005a8a0c3800a5692a57f888e617205f9'
NATIVE = 'com.lightningstudio.watchrss'
COEXIST = NATIVE + '.podjs'


def signature():
    return {'verified': True, 'v3': True, 'certificatesSha256': [CERT],
            'watchCertificatesSha256': [CERT],
            'lineage': [{'sha256': OLD, 'installedData': True},
                        {'sha256': CERT, 'installedData': True}]}


def facts():
    return {**p.parse_manifest(FIXTURE.read_text()), 'signature': signature(),
            'podManifest': {'schema': 1}, 'apkSha256': 'a' * 64}


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.ledger = p.load_ledger(LEDGER_FIXTURE)
        self.facts = facts()
        self.channel = 'coexistence'

    def result(self):
        return p.evaluate(self.facts, self.channel, self.ledger)

    def failed(self, name):
        result = self.result()
        self.assertFalse(result['ok'])
        self.assertFalse(next(c for c in result['checks'] if c['name'] == name)['passed'])

    def native(self):
        self.channel = 'takeover-prebeta'
        self.facts['appId'] = NATIVE
        self.facts['versionCode'] = 1000
        self.facts['signature']['lineage'] = []
        self.facts['podManifest']['androidWorkManagerTakeover'] = copy.deepcopy(
            self.ledger['policy']['workManagerTakeover'])
        # Synthetic policy approval, NOT a change to the actual shipping ledger.
        self.ledger['policy']['packages'][NATIVE]['highestPublishedVerified'] = True

    def recovery(self):
        self.native()
        self.channel = 'recovery'
        self.facts.update(p.parse_manifest(RECOVERY_FIXTURE.read_text()), podManifest=None)

    def test_coexistence_pass_and_input_immutable(self):
        before = copy.deepcopy((self.facts, self.ledger))
        self.assertTrue(self.result()['ok'])
        self.assertEqual(before, (self.facts, self.ledger))

    def test_wrong_package_and_channel(self):
        for app, channel in [('dev.other', 'coexistence'), (COEXIST, 'unknown'),
                             (COEXIST, 'takeover-beta')]:
            with self.subTest(app=app, channel=channel):
                self.facts['appId'], self.channel = app, channel
                self.failed('appId')

    def test_code_equal_or_lower_fails(self):
        for code in (28, 29):
            self.facts['versionCode'] = code
            self.failed('versionCode')

    def test_highest_is_across_channels_and_observations(self):
        entry = copy.deepcopy(self.ledger['releases'][0])
        entry.update(channel='another-channel', versionCode=31, status='observed')
        self.ledger['releases'].append(entry)
        self.failed('versionCode')

    def installed_paused(self):
        self.native()
        self.ledger['policy']['packages'][NATIVE]['installedObservation'] = {
            'versionCode': 1000, 'apkSha256': 'b' * 64, 'certSha256': CERT,
            'debuggable': False, 'uid': 10132, 'serial': 'synthetic-device',
            'observedOn': '2026-10-08', 'migrationStatus': 'PAUSED',
            'evidence': 'synthetic-readback.json'}

    def test_paused_installed_version_forward_and_recovery(self):
        self.installed_paused()
        for code in (999, 1000):
            self.facts['versionCode'] = code
            self.failed('versionCode')
        self.facts['versionCode'] = 1001
        self.assertTrue(self.result()['ok'])
        self.recovery()
        self.assertTrue(self.result()['ok'])
        self.ledger['policy']['packages'][NATIVE]['installedObservation']['versionCode'] = 900000
        self.failed('versionCode')

    def test_v1001_paused_requires_strictly_higher_forward_code(self):
        self.installed_paused()
        self.channel = 'takeover-release'
        self.ledger['policy']['packages'][NATIVE]['installedObservation']['versionCode'] = 1001
        for code in (40, 999, 1000, 1001):
            with self.subTest(code=code):
                self.facts['versionCode'] = code
                self.failed('versionCode')
        self.facts['versionCode'] = 1002
        self.assertTrue(self.result()['ok'])
        self.facts['signature']['watchCertificatesSha256'] = [OLD]
        self.failed('certificate')
        self.facts['signature']['watchCertificatesSha256'] = [CERT]
        self.facts['versionCode'] = 900000
        self.failed('reservedVersionRange')
        self.recovery()
        self.assertTrue(self.result()['ok'])

    def test_v1002_blocked_requires_strictly_higher_forward_code(self):
        self.installed_paused()
        self.channel = 'takeover-release'
        self.ledger['policy']['packages'][NATIVE]['installedObservation'].update(
            versionCode=1002, migrationStatus='BLOCKED')
        for code in (40, 999, 1000, 1001, 1002):
            with self.subTest(code=code):
                self.facts['versionCode'] = code
                self.failed('versionCode')
        self.facts['versionCode'] = 1003
        self.assertTrue(self.result()['ok'])
        self.facts['signature']['watchCertificatesSha256'] = [OLD]
        self.failed('certificate')
        self.facts['signature']['watchCertificatesSha256'] = [CERT]
        self.facts['versionCode'] = 900000
        self.failed('reservedVersionRange')
        self.recovery()
        self.assertTrue(self.result()['ok'])

    def test_v1003_active_requires_strictly_higher_upgrade_code(self):
        self.installed_paused()
        self.channel = 'takeover-release'
        self.ledger['policy']['packages'][NATIVE]['installedObservation'].update(
            versionCode=1003, migrationStatus='ACTIVE')
        for code in (40, 999, 1000, 1001, 1002, 1003):
            with self.subTest(code=code):
                self.facts['versionCode'] = code
                self.failed('versionCode')
        self.facts['versionCode'] = 1004
        self.assertTrue(self.result()['ok'])
        self.facts['signature']['watchCertificatesSha256'] = [OLD]
        self.failed('certificate')
        self.facts['signature']['watchCertificatesSha256'] = [CERT]
        self.facts['versionCode'] = 900000
        self.failed('reservedVersionRange')
        self.recovery()
        self.assertTrue(self.result()['ok'])

    def test_paused_forward_keeps_signature_and_range_gates(self):
        self.installed_paused()
        self.facts['versionCode'] = 1001
        self.facts['signature']['watchCertificatesSha256'] = [OLD]
        self.failed('certificate')
        self.facts['signature']['watchCertificatesSha256'] = [CERT]
        self.facts['versionCode'] = 900000
        self.failed('reservedVersionRange')

    def test_installed_observation_validation(self):
        self.installed_paused()
        original = copy.deepcopy(self.ledger)
        for field, value in [('versionCode', True), ('uid', 0), ('certSha256', OLD),
                             ('apkSha256', 'bad'), ('debuggable', 'false'),
                             ('serial', ''), ('evidence', ''), ('migrationStatus', 'UNKNOWN'),
                             ('observedOn', 'bad')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
                ledger = copy.deepcopy(original)
                ledger['policy']['packages'][NATIVE]['installedObservation'][field] = value
                path = Path(temp) / 'ledger.json'
                path.write_text(json.dumps(ledger))
                with self.assertRaises(ValueError):
                    p.load_ledger(path)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'ledger.json'
            path.write_text(json.dumps(original))
            self.assertEqual(p.load_ledger(path), original)

    def test_unconfirmed_native_inventory_blocks_real_policy(self):
        self.native()
        self.ledger['policy']['packages'][NATIVE]['highestPublishedVerified'] = False
        self.failed('publicationInventory')

    def test_takeover_and_epoch_boundaries(self):
        self.native()
        for code, allowed in [(999, False), (1000, True), (899999, True),
                              (900000, False), (999999, False), (1000000, False),
                              (1000999, False), (1001000, True)]:
            with self.subTest(code=code):
                self.facts['versionCode'] = code
                if allowed:
                    self.assertTrue(self.result()['ok'])
                else:
                    self.failed('reservedVersionRange')

    def test_recovery_boundaries_and_no_pod_metadata(self):
        self.recovery()
        for code, allowed in [(899999, False), (900000, True), (999999, True),
                              (1000000, False), (1900000, True)]:
            self.facts['versionCode'] = code
            if allowed:
                self.assertTrue(self.result()['ok'])
            else:
                self.failed('reservedVersionRange')

    def test_recovery_baseline_debug_components_pass_without_mutation(self):
        self.recovery()
        self.assertEqual(len(self.facts['debugExternalComponents']), 4)
        before = copy.deepcopy((self.facts, self.ledger))
        result = self.result()
        self.assertTrue(result['ok'])
        debug = next(c for c in result['checks'] if c['name'] == 'debugExternal')
        self.assertTrue(debug['passed'])
        self.assertEqual(debug['detail']['unexpectedOrChanged'], [])
        check = next(c for c in result['checks'] if c['name'] == 'recoveryComponents')
        self.assertEqual(check['detail']['unexpected'], [])
        self.assertEqual(check['detail']['approvedAdditions'], [])
        self.assertEqual(before, (self.facts, self.ledger))

    def test_recovery_non_debug_native40_component_types_and_names_pass(self):
        self.recovery()
        baseline, components = p.recovery_baseline(self.ledger)
        self.assertEqual(len(components), 90)
        self.assertTrue(baseline['source']['debuggable'])  # local debug APK, not public release proof
        existing = p.component_set(self.facts['components'])
        # Extra debug aliases/receivers are NOT covered by the four exact exceptions.
        nodes = []
        for tag, name in sorted(components - existing):
            node = f'<{tag} android:name="{name}" />'
            parsed = p.parse_manifest(RECOVERY_FIXTURE.read_text().replace('</application>', node + '</application>'))
            if name not in parsed['debugExternalComponents']:
                nodes.append(node)
        nodes = ''.join(nodes)
        xml = RECOVERY_FIXTURE.read_text().replace('</application>', nodes + '</application>')
        self.facts.update(p.parse_manifest(xml))
        self.assertTrue(self.result()['ok'])

    def test_recovery_exact_nodes_reject_attribute_child_and_type_changes(self):
        self.recovery()
        original = RECOVERY_FIXTURE.read_text()
        for before, after in (
            ('android:authorities="com.lightningstudio.watchrss.debuglog"',
             'android:authorities="com.lightningstudio.watchrss.reference.debuglog"'),
            ('android:exported="false"', 'android:exported="true"'),
            ('android:exported="false"', 'android:exported="false" android:permission="app.permission.TEST"'),
            ('android:exported="false"', 'android:exported="false" android:enabled="false"'),
            ('android:theme="@ref/0x7f120141"', 'android:theme="@ref/0x7f120142"'),
            ('com.lightningstudio.watchrss.action.OPEN_PERF', 'com.lightningstudio.watchrss.action.OTHER'),
            ('android.intent.category.DEFAULT', 'android.intent.category.OTHER'),
            ('<intent-filter>', '<intent-filter android:priority="1">'),
            ('<provider', '<service'),
        ):
            with self.subTest(before=before, after=after):
                self.assertIn(before, original)
                self.facts.update(p.parse_manifest(original.replace(before, after, 1)))
                self.failed('debugExternal')
        self.facts.update(p.parse_manifest(original))
        self.facts.pop('componentDetails')
        self.failed('debugExternal')

    def test_recovery_rejects_other_native_baseline_debug_entries(self):
        self.recovery()
        for tag, name in (('activity-alias', '.DouyinDebugEntryActivity'),
                          ('receiver', '.debug.DouyinPlaybackDebugReceiver')):
            self.facts.update(p.parse_manifest(RECOVERY_FIXTURE.read_text().replace('</application>',
                f'<{tag} android:name="{name}" android:exported="false" /></application>')))
            self.failed('debugExternal')
            self.assertTrue(next(c for c in self.result()['checks']
                                 if c['name'] == 'recoveryComponents')['passed'])

    def test_recovery_debug_baseline_missing_tampered_and_unlinked_fail_closed(self):
        self.recovery()
        original = p.INSTALLED40_DEBUG_COMPONENTS.read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'baseline.json'
            path.write_bytes(original + b' ')
            with patch.object(p, 'INSTALLED40_DEBUG_COMPONENTS', path):
                self.failed('debugExternal')
            path.write_text('[]')
            with patch.object(p, 'INSTALLED40_DEBUG_COMPONENTS', path):
                self.failed('debugExternal')
        with patch.object(p, 'INSTALLED40_DEBUG_COMPONENTS', Path('/nonexistent/baseline.json')):
            self.failed('debugExternal')
        record = next(r for r in self.ledger['releases'] if r['channel'] == 'native-observation')
        for field in ('apkSha256', 'cert', 'axmlSha256', 'manifestDebugComponentsSha256'):
            saved = record[field]
            record[field] = 'b' * 64
            self.failed('debugExternal')
            record[field] = saved

    def test_duplicate_component_identity_rejected(self):
        xml = RECOVERY_FIXTURE.read_text().replace('</application>',
            '<activity android:name="com.lightningstudio.watchrss.LlmSummaryActivity" /></application>')
        with self.assertRaisesRegex(ValueError, 'duplicate manifest component'):
            p.parse_manifest(xml)

    def test_recovery_rejects_each_extra_component_kind_even_non_debug(self):
        self.recovery()
        for tag in sorted(p.COMPONENT_TYPES):
            for name in ('.UnexpectedComponent', '.debug.UnexpectedComponent'):
                with self.subTest(tag=tag, name=name):
                    xml = RECOVERY_FIXTURE.read_text().replace('</application>',
                        f'<{tag} android:name="{name}" android:exported="false" /></application>')
                    self.facts.update(p.parse_manifest(xml))
                    self.failed('recoveryComponents')
                    check = next(c for c in self.result()['checks'] if c['name'] == 'recoveryComponents')
                    self.assertEqual(check['detail']['unexpected'], [{'type': tag, 'name': NATIVE + name}])

    def test_recovery_rejects_baseline_name_with_changed_component_type(self):
        self.recovery()
        xml = RECOVERY_FIXTURE.read_text().replace('</application>',
            '<service android:name=".LlmSummaryActivity" /></application>')
        self.facts.update(p.parse_manifest(xml))
        self.failed('recoveryComponents')

    def test_podjs_channels_still_reject_native_baseline_debug_components(self):
        for channel in ('coexistence', 'takeover-prebeta', 'takeover-beta', 'takeover-release'):
            with self.subTest(channel=channel):
                self.setUp()
                if channel != 'coexistence':
                    self.native()
                self.channel = channel
                xml = FIXTURE.read_text().replace('</application>',
                    '<activity android:name="com.lightningstudio.watchrss.LlmSummaryActivity" />'
                    '<provider android:name="com.lightningstudio.watchrss.debug.DebugLogProvider" />'
                    '</application>')
                manifest = p.parse_manifest(xml)
                self.facts['debugExternalComponents'] = manifest['debugExternalComponents']
                self.facts['components'] = manifest['components']
                self.failed('debugExternal')
                self.assertNotIn('recoveryComponents', [c['name'] for c in self.result()['checks']])

    def test_recovery_still_requires_non_debuggable_and_confirmed_inventory(self):
        self.recovery()
        self.facts['debuggable'] = True
        self.failed('nonDebuggable')
        self.facts['debuggable'] = False
        self.ledger['policy']['packages'][NATIVE]['highestPublishedVerified'] = False
        self.failed('publicationInventory')
        self.assertTrue(next(c for c in self.result()['checks'] if c['name'] == 'recoveryComponents')['passed'])

    def test_recovery_missing_components_or_unlinked_baseline_fails_closed(self):
        self.recovery()
        components = self.facts.pop('components')
        self.failed('recoveryComponents')
        self.facts['components'] = components
        record = next(r for r in self.ledger['releases'] if r['channel'] == 'native-local-baseline')
        record['apkSha256'] = 'b' * 64
        self.failed('recoveryComponents')

    def test_recovery_missing_malformed_and_wrong_baseline_fails_closed(self):
        self.recovery()
        original = p.load_json(p.NATIVE40_COMPONENTS.read_text())
        changed = copy.deepcopy(original)
        changed['components'][0]['type'] = 'application'
        for data in ([], {**original, 'appId': COEXIST}, {**original, 'versionCode': 39},
                     {**original, 'apkSha256': 'b' * 64}, {**original, 'components': []}, changed):
            with tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / 'components.json'
                path.write_text(json.dumps(data))
                with patch.object(p, 'NATIVE40_COMPONENTS', path):
                    self.failed('recoveryComponents')
        with patch.object(p, 'NATIVE40_COMPONENTS', Path('/nonexistent/native40-components.json')):
            self.failed('recoveryComponents')

    def test_debuggable_fails(self):
        self.facts['debuggable'] = True
        self.failed('nonDebuggable')

    def test_signature_tamper_and_unsigned_fail(self):
        self.facts['signature']['verified'] = False
        self.failed('signatureVerified')

    def test_wrong_multiple_and_watch_sdk_signer_fail(self):
        for key, certs in [('certificatesSha256', [OLD]), ('certificatesSha256', [CERT, OLD]),
                           ('watchCertificatesSha256', [OLD])]:
            self.facts['signature'] = signature()
            self.facts['signature'][key] = certs
            self.failed('certificate')

    def test_optional_lineage_and_all_invalid_chain_cases(self):
        self.facts['signature']['lineage'] = []
        self.assertTrue(self.result()['ok'])
        for chain in [[CERT, OLD], [OLD, OLD, CERT], ['b' * 64, CERT]]:
            self.facts['signature']['lineage'] = [
                {'sha256': cert, 'installedData': True} for cert in chain]
            self.failed('v3Lineage')
        self.facts['signature'] = signature()
        self.facts['signature']['lineage'][0]['installedData'] = False
        self.failed('v3Lineage')
        self.facts['signature'] = signature()
        self.facts['signature']['v3'] = False
        self.failed('v3Lineage')

    def test_all_debug_external_component_kinds(self):
        for tag, name in [('activity', 'com.lightningstudio.watchrss.DouyinDebugEntryActivity'),
                          ('activity-alias', 'com.lightningstudio.watchrss.LlmSummaryActivity'),
                          ('receiver', '.debug.TestReceiver'), ('provider', '.debug.DebugLogProvider'),
                          ('service', '.debug.TestService')]:
            with self.subTest(tag=tag):
                xml = FIXTURE.read_text().replace('</application>',
                    f'<{tag} android:name="{name}" /></application>')
                self.facts.update(p.parse_manifest(xml))
                self.failed('debugExternal')

    def test_debug_action_and_authority_detected_even_with_ordinary_class(self):
        for node in ['<receiver android:name=".Receiver"><intent-filter><action '
                     'android:name="com.lightningstudio.watchrss.debug.action.TEST"/></intent-filter></receiver>',
                     '<provider android:name=".Provider" android:authorities="app.debuglog"/>']:
            self.facts.update(p.parse_manifest(FIXTURE.read_text().replace(
                '</application>', node + '</application>')))
            self.failed('debugExternal')

    def test_source_policy_missing_malformed_and_wrong(self):
        key = 'dev.podjs.takeover.sourceVersionCode'
        for value in ('39', '0', '@integer/source', '-1', None):
            self.facts['metadata'][key] = value
            self.failed('takeoverSourceVersionCode')
        del self.facts['metadata'][key]
        self.failed('takeoverSourceVersionCode')

    def test_purge_prebeta_beta_without_acceptance_and_future_threshold(self):
        self.native()
        key = 'dev.podjs.takeover.purgeBackupAfter'
        self.facts['metadata'][key] = '1000'
        self.failed('purgeBackupAfter')
        self.channel = 'takeover-release'
        target = self.ledger['policy']['channels'][self.channel]
        self.failed('purgeBackupAfter')
        target.update(betaAccepted=True, approvedPurgeBackupAfter=1000)
        self.assertTrue(self.result()['ok'])
        self.facts['metadata'][key] = '1001'
        target['approvedPurgeBackupAfter'] = 1001
        self.failed('purgeBackupAfter')
        self.facts['metadata'][key] = '@integer/purge'
        self.failed('purgeBackupAfter')
        del self.facts['metadata'][key]
        self.failed('takeoverSourceVersionCode')

    def test_coexistence_config_must_be_absent_even_null_or_disabled(self):
        for wm in (None, {}, self.ledger['policy']['workManagerTakeover']):
            self.facts['podManifest']['androidWorkManagerTakeover'] = wm
            self.failed('workManagerTakeover')

    def test_takeover_requires_exact_legacy_worker_config(self):
        self.native()
        self.assertTrue(self.result()['ok'])
        wm = self.facts['podManifest']['androidWorkManagerTakeover']
        wm['nativeAppId'] = COEXIST
        self.failed('workManagerTakeover')
        wm['nativeAppId'] = NATIVE
        wm['workerClasses'] = []
        self.failed('workManagerTakeover')
        del self.facts['podManifest']['androidWorkManagerTakeover']
        self.failed('workManagerTakeover')

    def test_pod_asset_required_for_podjs(self):
        self.facts['podManifest'] = None
        self.failed('podManifest')


class ReaderAndRecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.apk = self.dir / 'fixture.apk'
        with zipfile.ZipFile(self.apk, 'w') as archive:
            archive.writestr('AndroidManifest.xml', FIXTURE.read_text())
            archive.writestr('assets/pod.manifest.json', '{"schema":1}')
        self.ledger = self.dir / 'ledger.json'
        self.ledger.write_bytes(LEDGER_FIXTURE.read_bytes())

    def mock_tools(self):
        return patch.object(p, 'sdk_tools', return_value=('apkanalyzer', 'apksigner.jar', 'java'))

    def mock_run(self):
        return patch.object(p, 'run', side_effect=[FIXTURE.read_text(), json.dumps(signature())])

    def test_reader_from_apk_zip_and_synthetic_tool_outputs(self):
        with self.mock_tools(), self.mock_run() as run:
            result = p.inspect_apk(self.apk)
        self.assertEqual(result['apkSha256'], p.sha256(self.apk))
        self.assertEqual(result['podManifest'], {'schema': 1})
        self.assertEqual(result['appId'], COEXIST)
        self.assertEqual(len(run.call_args_list), 2)
        self.assertTrue(all('keystore' not in str(c) for c in run.call_args_list))

    def test_apk_changed_midinspection_fails(self):
        with self.mock_tools(), self.mock_run(), patch.object(p, 'sha256', side_effect=['a', 'b']):
            with self.assertRaisesRegex(ValueError, 'changed'):
                p.inspect_apk(self.apk)

    def test_duplicate_apk_entry_rejected(self):
        with zipfile.ZipFile(self.apk, 'a') as archive:
            archive.writestr('assets/pod.manifest.json', '{}')
        with self.mock_tools(), self.mock_run(), self.assertRaisesRegex(ValueError, 'duplicate APK'):
            p.inspect_apk(self.apk)

    def test_malformed_and_duplicate_json_rejected(self):
        for value in ('{', '{"a":1,"a":2}', '[]'):
            with zipfile.ZipFile(self.apk, 'w') as archive:
                archive.writestr('assets/pod.manifest.json', value)
            with self.mock_tools(), self.mock_run(), self.assertRaises(ValueError):
                p.inspect_apk(self.apk)

    def test_unresolved_manifest_and_duplicate_metadata_rejected(self):
        for before, after in [('android:versionCode="30"', 'android:versionCode="@integer/code"'),
                              ('<application', '<application android:debuggable="@bool/debug"'),
                              ('<manifest ', '<manifest android:versionCodeMajor="1" '),
                              ('</application>', '<meta-data android:name="dev.podjs.takeover.sourceVersionCode" '
                               'android:value="40"/></application>')]:
            with self.assertRaises(ValueError):
                p.parse_manifest(FIXTURE.read_text().replace(before, after))

    def test_missing_or_unresolved_component_name_rejected(self):
        for attribute in ('', 'android:name=""', 'android:name="@string/component"'):
            with self.assertRaisesRegex(ValueError, 'component name'):
                p.parse_manifest(FIXTURE.read_text().replace('</application>',
                    f'<activity {attribute}/></application>'))

    def test_invalid_ledger_schema_and_code_rejected(self):
        data = json.loads(self.ledger.read_text())
        data['schemaVersion'] = 2
        self.ledger.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            p.load_ledger(self.ledger)
        data['schemaVersion'] = 1
        data['releases'][0]['versionCode'] = True
        self.ledger.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            p.load_ledger(self.ledger)

    def test_invalid_policy_fails_closed_with_json_cli_output(self):
        original = json.loads(self.ledger.read_text())
        cases = [[], {**original, 'policy': []},
                 {**original, 'releases': [None]}]
        changed = copy.deepcopy(original)
        changed['policy']['packages'][COEXIST]['highestPublishedVerified'] = 'true'
        cases.append(changed)
        for data in cases:
            self.ledger.write_text(json.dumps(data))
            with patch('sys.stdout', new_callable=io.StringIO) as out, patch('sys.stderr', new_callable=io.StringIO):
                self.assertEqual(p.main(['check', str(self.apk), '--channel', 'coexistence',
                                         '--ledger', str(self.ledger)]), 1)
                self.assertIn('error', json.loads(out.getvalue()))

    def test_record_reinspects_appends_then_rejects_repeat_without_policy_changes(self):
        before = p.load_ledger(self.ledger)
        with self.mock_tools(), self.mock_run():
            result = p.record(self.apk, 'coexistence', self.ledger,
                              {'app': '035f3bd', 'framework': '3b9b61d'}, '2026-10-07', 'published locally')
        self.assertTrue(result['ok'])
        after = p.load_ledger(self.ledger)
        self.assertEqual(after['policy'], before['policy'])
        self.assertEqual(after['releases'][:-1], before['releases'])
        self.assertEqual(after['releases'][-1]['apkSha256'], p.sha256(self.apk))
        self.assertEqual(after['releases'][-1]['status'], 'published')
        saved = self.ledger.read_bytes()
        with self.mock_tools(), self.mock_run():
            self.assertFalse(p.record(self.apk, 'coexistence', self.ledger,
                {'app': '035f3bd'}, '2026-10-07', 'repeat')['ok'])
        self.assertEqual(self.ledger.read_bytes(), saved)

    def test_failed_check_and_record_do_not_mutate_ledger(self):
        before = self.ledger.read_bytes()
        bad = facts()
        bad['debuggable'] = True
        with patch.object(p, 'inspect_apk', return_value=bad):
            with patch('sys.stdout', new_callable=io.StringIO) as out, patch('sys.stderr', new_callable=io.StringIO):
                self.assertEqual(p.main(['check', str(self.apk), '--channel', 'coexistence',
                                         '--ledger', str(self.ledger)]), 1)
                self.assertFalse(json.loads(out.getvalue())['ok'])
            self.assertFalse(p.record(self.apk, 'coexistence', self.ledger,
                {'app': '035f3bd'}, '2026-10-07', 'must fail')['ok'])
        self.assertEqual(self.ledger.read_bytes(), before)

    def test_cli_default_inspection_json_summary_and_read_only(self):
        before = self.ledger.read_bytes()
        with self.mock_tools(), self.mock_run(), patch('sys.stdout', new_callable=io.StringIO) as out, \
                patch('sys.stderr', new_callable=io.StringIO) as err:
            self.assertEqual(p.main(['check', str(self.apk), '--channel', 'coexistence',
                                     '--ledger', str(self.ledger)]), 0)
            self.assertTrue(json.loads(out.getvalue())['ok'])
            self.assertIn('PASS certificate', err.getvalue())
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.ledger.with_suffix('.json.lock').exists())

    def test_cli_missing_apk_is_structured_failure(self):
        with patch('sys.stdout', new_callable=io.StringIO) as out, patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(p.main(['check', str(self.dir / 'missing.apk'),
                                     '--channel', 'coexistence']), 1)
            self.assertIn('error', json.loads(out.getvalue()))

    def test_cli_record_source_argument_and_success(self):
        with self.mock_tools(), self.mock_run(), patch('sys.stdout', new_callable=io.StringIO) as out, \
                patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(p.main(['record', str(self.apk), '--channel', 'coexistence',
                '--ledger', str(self.ledger), '--source-rev', 'app=035f3bd',
                '--source-rev', 'framework=3b9b61d', '--date', '2026-10-07',
                '--notes', 'local publication fixture']), 0)
            self.assertEqual(json.loads(out.getvalue())['recorded']['sourceRevs'],
                             {'app': '035f3bd', 'framework': '3b9b61d'})

    def test_record_requires_publication_metadata(self):
        for revs, date, notes in [({}, '2026-10-07', 'published'),
                                  ({'app': ''}, '2026-10-07', 'published'),
                                  ({'app': 'abc'}, 'bad-date', 'published'),
                                  ({'app': 'abc'}, '2026-10-07', '')]:
            with self.assertRaises(ValueError):
                p.record(self.apk, 'coexistence', self.ledger, revs, date, notes)


class SdkIntegrationTests(unittest.TestCase):
    def test_real_unsigned_aapt_apk_is_cryptographically_rejected(self):
        # Production constructor, SDK discovery, Java helper and binary AXML parsing.
        # The generated unsigned fixture is temporary; no key material is needed.
        try:
            analyzer, jar, _ = p.sdk_tools()
        except ValueError as error:
            self.skipTest(str(error))
        sdk = analyzer.parents[3]
        android_jars = sorted((sdk / 'platforms').glob('android-*/android.jar'))
        aapt = jar.parents[1] / 'aapt2'
        if not android_jars or not aapt.exists():
            self.skipTest('aapt2 and android.jar required for SDK integration fixture')
        with tempfile.TemporaryDirectory() as temp:
            apk = Path(temp) / 'unsigned.apk'
            p.run([aapt, 'link', '-I', android_jars[-1], '--manifest', FIXTURE, '-o', apk])
            with zipfile.ZipFile(apk, 'a') as archive:
                archive.writestr('assets/pod.manifest.json', '{"schema":1}')
            result = p.inspect_apk(apk)
            self.assertEqual(result['versionCode'], 30)
            self.assertFalse(result['debuggable'])
            self.assertFalse(result['signature']['verified'])
            check = p.evaluate(result, 'coexistence', p.load_ledger(LEDGER_FIXTURE))
            self.assertFalse(check['ok'])
            self.assertFalse(next(c for c in check['checks'] if c['name'] == 'signatureVerified')['passed'])



class InternalDebugTests(unittest.TestCase):
    result = PolicyTests.result
    failed = PolicyTests.failed

    def setUp(self):
        PolicyTests.setUp(self)
        PolicyTests.native(self)
        self.channel = 'internal-debug'
        self.ledger['policy']['channels']['internal-debug'] = copy.deepcopy(self.ledger['policy']['channels']['takeover-prebeta'])
        package = self.ledger['policy']['packages'][NATIVE]
        package['internalDebugVersionCode'] = 1005
        package['installedObservation'] = {
            'versionCode': 1004, 'apkSha256': 'cc09f237705586e9b82af0b21b3dd07b88d2c081567f840c043bb009decbb906',
            'certSha256': CERT, 'debuggable': False, 'uid': 10132, 'serial': 'e3aca8af',
            'observedOn': '2026-10-09', 'migrationStatus': 'ACTIVE',
            'evidence': '.codex-tmp/t20/device/v9b/identity.json'}
        self.facts['versionCode'] = 1005
        self.facts['debuggable'] = True
        self.facts['signature']['lineage'] = []
        self.facts['podManifest']['androidWorkManagerTakeover'] = copy.deepcopy(self.ledger['policy']['workManagerTakeover'])
        details = []
        for tag, name in sorted(p.INTERNAL_DEBUG_COMPONENTS):
            attrs = {p.ANDROID + 'name': name, p.ANDROID + 'exported': 'false' if tag == 'activity' else 'true'}
            if tag != 'activity':
                attrs[p.ANDROID + 'permission'] = 'android.permission.DUMP'
            details.append({'type': tag, 'name': name, 'node': {'type': tag, 'attributes': attrs, 'children': []}})
        self.facts['componentDetails'] = details
        self.facts['components'] = [{'type': item['type'], 'name': item['name']} for item in details]
        self.facts['debugExternalComponents'] = sorted(item['name'] for item in details)

    # Deliberately do not inherit generic policy tests with a different baseline.
    def test_internal_debug_pass_and_immutable(self):
        before = copy.deepcopy((self.facts, self.ledger))
        self.assertTrue(self.result()['ok'], self.result())
        self.assertEqual(before, (self.facts, self.ledger))

    def test_installed_1004_and_public_reserved_1005(self):
        package = self.ledger['policy']['packages'][NATIVE]
        self.assertEqual(package['installedObservation']['versionCode'], 1004)
        self.assertEqual(package['installedObservation']['migrationStatus'], 'ACTIVE')
        self.assertEqual(package['installedObservation']['apkSha256'], 'cc09f237705586e9b82af0b21b3dd07b88d2c081567f840c043bb009decbb906')
        for code in (40, 1000, 1003, 1004):
            self.facts['versionCode'] = code
            self.failed('versionCode')
        self.facts.update(versionCode=1005, debuggable=False, debugExternalComponents=[])
        self.channel = 'takeover-release'
        self.failed('versionCode')
        self.facts['versionCode'] = 1006
        self.assertTrue(self.result()['ok'])

    def test_debug_requires_explicit_channel(self):
        self.facts['versionCode'] = 1006
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            self.failed('nonDebuggable')
        self.channel = 'internal-debug'
        self.facts['debuggable'] = False
        self.failed('internalDebuggable')

    def test_external_permissions_and_unexpected_components_rejected(self):
        original = copy.deepcopy(self.facts)
        for item in original['componentDetails']:
            for field, value in (('permission', None), ('permission', 'android.permission.INTERNET'), ('exported', 'false')):
                if item['type'] == 'activity':
                    continue
                self.facts = copy.deepcopy(original)
                node = next(v for v in self.facts['componentDetails'] if v['name'] == item['name'])
                if value is None:
                    node['node']['attributes'].pop(p.ANDROID + field)
                else:
                    node['node']['attributes'][p.ANDROID + field] = value
                self.failed('debugExternal')
        self.facts = copy.deepcopy(original)
        self.facts['debugExternalComponents'].append('unexpected.debug.Component')
        self.facts['componentDetails'].append({'type': 'receiver', 'name': 'unexpected.debug.Component', 'node': {}})
        self.failed('debugExternal')
        self.facts = copy.deepcopy(original)
        self.facts['componentDetails'][0]['node']['attributes'][p.ANDROID + 'exported'] = 'true'
        self.failed('debugExternal')
        for field in ('readPermission', 'writePermission', 'grantUriPermissions'):
            self.facts = copy.deepcopy(original)
            provider = next(v for v in self.facts['componentDetails'] if v['type'] == 'provider')
            provider['node']['attributes'][p.ANDROID + field] = 'true' if field == 'grantUriPermissions' else 'android.permission.INTERNET'
            self.failed('debugExternal')

    def test_other_gates_remain_required(self):
        original = copy.deepcopy(self.facts)
        mutations = [('certificate', lambda f: f['signature'].update(certificatesSha256=[OLD])),
                     ('signatureVerified', lambda f: f['signature'].update(verified=False)),
                     ('v3Lineage', lambda f: f['signature'].update(lineage=[{'sha256': OLD, 'installedData': True}])),
                     ('takeoverSourceVersionCode', lambda f: f['metadata'].update({'dev.podjs.takeover.sourceVersionCode': '41'})),
                     ('purgeBackupAfter', lambda f: f['metadata'].update({'dev.podjs.takeover.purgeBackupAfter': '1005'})),
                     ('workManagerTakeover', lambda f: f['podManifest'].pop('androidWorkManagerTakeover')),
                     ('appId', lambda f: f.update(appId=COEXIST))]
        for gate, mutate in mutations:
            self.facts = copy.deepcopy(original)
            mutate(self.facts)
            self.failed(gate)
        self.facts = original
        self.ledger['policy']['packages'][NATIVE]['highestPublishedVerified'] = False
        self.failed('publicationInventory')

    def test_malformed_internal_policy_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ledger.json'
            for value in (None, [], 'takeover', {'kind': 'recovery', 'packages': [NATIVE]},
                          {'kind': 'takeover', 'packages': [COEXIST]}):
                ledger = copy.deepcopy(self.ledger)
                ledger['policy']['channels']['internal-debug'] = value
                path.write_text(json.dumps(ledger))
                with self.assertRaises(ValueError):
                    p.load_ledger(path)
            for value in (True, 0, '1005'):
                ledger = copy.deepcopy(self.ledger)
                ledger['policy']['packages'][NATIVE]['internalDebugVersionCode'] = value
                path.write_text(json.dumps(ledger))
                with self.assertRaises(ValueError):
                    p.load_ledger(path)

    def test_internal_record_rejected_without_inspection_or_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'ledger.json'
            ledger.write_text(json.dumps(self.ledger))
            before = ledger.read_bytes()
            with patch.object(p, 'inspect_apk') as inspect:
                with self.assertRaisesRegex(ValueError, 'check-only'):
                    p.record('nonexistent.apk', 'internal-debug', ledger, {'app': 'rev'}, '2026-10-09', 'internal')
                inspect.assert_not_called()
            self.assertEqual(before, ledger.read_bytes())
            self.assertFalse(ledger.with_suffix('.json.lock').exists())
            entry = copy.deepcopy(self.ledger['releases'][0])
            entry['channel'] = 'internal-debug'
            self.ledger['releases'].append(entry)
            ledger.write_text(json.dumps(self.ledger))
            with self.assertRaisesRegex(ValueError, 'cannot be release records'):
                p.load_ledger(ledger)


class InternalDebugV1006Tests(unittest.TestCase):
    """Frozen T23 policy boundary; does not depend on a future live ledger."""
    result = PolicyTests.result
    failed = PolicyTests.failed

    def setUp(self):
        InternalDebugTests.setUp(self)
        package = self.ledger['policy']['packages'][NATIVE]
        package['internalDebugVersionCode'] = 1006
        package['installedObservation'].update(
            versionCode=1005, debuggable=True,
            apkSha256='e61b69b9d9e219fd0f43fef1e9437f005ecdae1b283ba43899a5aa0be81d1255',
            evidence='.codex-tmp/t22/device/v10/after-identity.json')
        self.facts['versionCode'] = 1006

    def test_internal_1006_pass_and_installed_1005_immutable(self):
        before = copy.deepcopy((self.facts, self.ledger))
        self.assertTrue(self.result()['ok'], self.result())
        self.assertEqual(before, (self.facts, self.ledger))
        observation = self.ledger['policy']['packages'][NATIVE]['installedObservation']
        self.assertEqual((observation['versionCode'], observation['debuggable']), (1005, True))
        self.assertEqual(observation['apkSha256'], 'e61b69b9d9e219fd0f43fef1e9437f005ecdae1b283ba43899a5aa0be81d1255')

    def test_internal_rejects_all_codes_through_installed_1005(self):
        for code in (40, 999, 1000, 1003, 1004, 1005):
            with self.subTest(code=code):
                self.facts['versionCode'] = code
                self.failed('versionCode')
        self.facts['versionCode'] = 1006
        self.assertTrue(self.result()['ok'])

    def test_public_1006_reserved_and_1007_is_first_eligible_code(self):
        self.facts.update(debuggable=False, debugExternalComponents=[])
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            for code in (1004, 1005, 1006):
                with self.subTest(channel=channel, code=code):
                    self.facts['versionCode'] = code
                    self.failed('versionCode')
            self.facts['versionCode'] = 1007
            self.assertTrue(self.result()['ok'], self.result())

    def test_1006_debug_still_requires_explicit_internal_channel(self):
        self.facts['versionCode'] = 1007
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            self.failed('nonDebuggable')
            self.failed('debugExternal')
        self.channel = 'internal-debug'
        self.assertTrue(self.result()['ok'])
        self.facts['debuggable'] = False
        self.failed('internalDebuggable')


class InternalDebugV1007Tests(unittest.TestCase):
    """Frozen T25 policy boundary; does not depend on a future live ledger."""
    result = PolicyTests.result
    failed = PolicyTests.failed

    def setUp(self):
        InternalDebugTests.setUp(self)
        package = self.ledger['policy']['packages'][NATIVE]
        package['internalDebugVersionCode'] = 1007
        package['installedObservation'].update(
            versionCode=1006, debuggable=True,
            apkSha256='5a027af71d8a6d8e7e35c3d16bfab0b505b7dd8cb3e9d3c7976994a3e2c5936c',
            evidence='.codex-tmp/t23/device/after-identity.json')
        self.facts['versionCode'] = 1007

    def test_internal_1007_pass_and_installed_1006_immutable(self):
        before = copy.deepcopy((self.facts, self.ledger))
        self.assertTrue(self.result()['ok'], self.result())
        self.assertEqual(before, (self.facts, self.ledger))
        observation = self.ledger['policy']['packages'][NATIVE]['installedObservation']
        self.assertEqual((observation['versionCode'], observation['debuggable']), (1006, True))
        self.assertEqual(observation['apkSha256'], '5a027af71d8a6d8e7e35c3d16bfab0b505b7dd8cb3e9d3c7976994a3e2c5936c')

    def test_internal_rejects_all_codes_through_installed_1006(self):
        for code in (40, 999, 1000, 1003, 1004, 1005, 1006):
            with self.subTest(code=code):
                self.facts['versionCode'] = code
                self.failed('versionCode')
        self.facts['versionCode'] = 1007
        self.assertTrue(self.result()['ok'])

    def test_public_1007_reserved_and_1008_is_first_eligible_code(self):
        self.facts.update(debuggable=False, debugExternalComponents=[])
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            for code in (1004, 1005, 1006, 1007):
                with self.subTest(channel=channel, code=code):
                    self.facts['versionCode'] = code
                    self.failed('versionCode')
            self.facts['versionCode'] = 1008
            self.assertTrue(self.result()['ok'], self.result())

    def test_1007_debug_still_requires_explicit_internal_channel(self):
        self.facts['versionCode'] = 1008
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            self.failed('nonDebuggable')
            self.failed('debugExternal')
        self.channel = 'internal-debug'
        self.assertTrue(self.result()['ok'])
        self.facts['debuggable'] = False
        self.failed('internalDebuggable')


class InternalDebugV1008Tests(unittest.TestCase):
    """Frozen T28 policy boundary; does not depend on a future live ledger."""
    result = PolicyTests.result
    failed = PolicyTests.failed

    def setUp(self):
        InternalDebugTests.setUp(self)
        package = self.ledger['policy']['packages'][NATIVE]
        package['internalDebugVersionCode'] = 1008
        package['installedObservation'].update(
            versionCode=1007, debuggable=True,
            apkSha256='f226634db89c6ddc413ee7c63742044882f85927a65c16c13b7733d45d3dcd83',
            evidence='.codex-tmp/t25/device/installed-identity.json')
        self.facts['versionCode'] = 1008

    def test_internal_1008_pass_and_installed_1007_immutable(self):
        before = copy.deepcopy((self.facts, self.ledger))
        self.assertTrue(self.result()['ok'], self.result())
        self.assertEqual(before, (self.facts, self.ledger))
        observation = self.ledger['policy']['packages'][NATIVE]['installedObservation']
        self.assertEqual((observation['versionCode'], observation['debuggable']), (1007, True))
        self.assertEqual(observation['apkSha256'], 'f226634db89c6ddc413ee7c63742044882f85927a65c16c13b7733d45d3dcd83')

    def test_internal_rejects_all_codes_through_installed_1007(self):
        for code in (40, 999, 1000, 1003, 1004, 1005, 1006, 1007):
            with self.subTest(code=code):
                self.facts['versionCode'] = code
                self.failed('versionCode')
        self.facts['versionCode'] = 1008
        self.assertTrue(self.result()['ok'])

    def test_public_1008_reserved_and_1009_is_first_eligible_code(self):
        self.facts.update(debuggable=False, debugExternalComponents=[])
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            for code in (1004, 1005, 1006, 1007, 1008):
                with self.subTest(channel=channel, code=code):
                    self.facts['versionCode'] = code
                    self.failed('versionCode')
            self.facts['versionCode'] = 1009
            self.assertTrue(self.result()['ok'], self.result())

    def test_1008_debug_still_requires_explicit_internal_channel(self):
        self.facts['versionCode'] = 1009
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            self.failed('nonDebuggable')
            self.failed('debugExternal')
        self.channel = 'internal-debug'
        self.assertTrue(self.result()['ok'])
        self.facts['debuggable'] = False
        self.failed('internalDebuggable')


class InternalDebugV1009Tests(unittest.TestCase):
    """Frozen T30 policy boundary; does not depend on a future live ledger."""
    result = PolicyTests.result
    failed = PolicyTests.failed

    def setUp(self):
        InternalDebugTests.setUp(self)
        package = self.ledger['policy']['packages'][NATIVE]
        package['internalDebugVersionCode'] = 1009
        package['installedObservation'].update(
            versionCode=1008, debuggable=True,
            apkSha256='b366eea96a39be2c1ebd972ce07e75482e8db8f308847d05b6f810bec13bc660',
            evidence='.codex-tmp/t28/device/installed-identity.json')
        self.facts['versionCode'] = 1009

    def test_internal_1009_pass_and_installed_1008_immutable(self):
        before = copy.deepcopy((self.facts, self.ledger))
        self.assertTrue(self.result()['ok'], self.result())
        self.assertEqual(before, (self.facts, self.ledger))
        observation = self.ledger['policy']['packages'][NATIVE]['installedObservation']
        self.assertEqual((observation['versionCode'], observation['debuggable']), (1008, True))
        self.assertEqual(observation['apkSha256'], 'b366eea96a39be2c1ebd972ce07e75482e8db8f308847d05b6f810bec13bc660')

    def test_internal_rejects_all_codes_through_installed_1008(self):
        for code in (40, 999, 1000, 1003, 1004, 1005, 1006, 1007, 1008):
            with self.subTest(code=code):
                self.facts['versionCode'] = code
                self.failed('versionCode')
        self.facts['versionCode'] = 1009
        self.assertTrue(self.result()['ok'])

    def test_public_1009_reserved_and_1010_is_first_eligible_code(self):
        self.facts.update(debuggable=False, debugExternalComponents=[])
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            for code in (1004, 1005, 1006, 1007, 1008, 1009):
                with self.subTest(channel=channel, code=code):
                    self.facts['versionCode'] = code
                    self.failed('versionCode')
            self.facts['versionCode'] = 1010
            self.assertTrue(self.result()['ok'], self.result())

    def test_1009_debug_still_requires_explicit_internal_channel(self):
        self.facts['versionCode'] = 1010
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            self.failed('nonDebuggable')
            self.failed('debugExternal')
        self.channel = 'internal-debug'
        self.assertTrue(self.result()['ok'])
        self.facts['debuggable'] = False
        self.failed('internalDebuggable')


class InternalDebugV1010Tests(unittest.TestCase):
    """Frozen T34 policy boundary; does not depend on a future live ledger."""
    result = PolicyTests.result
    failed = PolicyTests.failed

    def setUp(self):
        InternalDebugTests.setUp(self)
        package = self.ledger['policy']['packages'][NATIVE]
        package['internalDebugVersionCode'] = 1010
        package['installedObservation'].update(
            versionCode=1009, debuggable=True,
            apkSha256='ef487b5b7f579dc8fd30ee6ed30ca0b25384d314660f8eaa1d9c62356ff2fc4d',
            evidence='.codex-tmp/t30/device/installed-identity.json')
        self.facts['versionCode'] = 1010

    def test_internal_1010_pass_and_installed_1009_immutable(self):
        before = copy.deepcopy((self.facts, self.ledger))
        self.assertTrue(self.result()['ok'], self.result())
        self.assertEqual(before, (self.facts, self.ledger))
        observation = self.ledger['policy']['packages'][NATIVE]['installedObservation']
        self.assertEqual((observation['versionCode'], observation['debuggable']), (1009, True))
        self.assertEqual(observation['apkSha256'], 'ef487b5b7f579dc8fd30ee6ed30ca0b25384d314660f8eaa1d9c62356ff2fc4d')

    def test_internal_rejects_all_codes_through_installed_1009(self):
        for code in (40, 999, 1000, 1003, 1004, 1005, 1006, 1007, 1008, 1009):
            with self.subTest(code=code):
                self.facts['versionCode'] = code
                self.failed('versionCode')
        self.facts['versionCode'] = 1010
        self.assertTrue(self.result()['ok'])

    def test_public_1010_reserved_and_1011_is_first_eligible_code(self):
        self.facts.update(debuggable=False, debugExternalComponents=[])
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            for code in (1004, 1005, 1006, 1007, 1008, 1009, 1010):
                with self.subTest(channel=channel, code=code):
                    self.facts['versionCode'] = code
                    self.failed('versionCode')
            self.facts['versionCode'] = 1011
            self.assertTrue(self.result()['ok'], self.result())

    def test_1010_debug_still_requires_explicit_internal_channel(self):
        self.facts['versionCode'] = 1011
        for channel in ('takeover-release', 'takeover-beta', 'takeover-prebeta'):
            self.channel = channel
            self.failed('nonDebuggable')
            self.failed('debugExternal')
        self.channel = 'internal-debug'
        self.assertTrue(self.result()['ok'])
        self.facts['debuggable'] = False
        self.failed('internalDebuggable')


class RetiredAcousticComponentsTests(unittest.TestCase):
    native = PolicyTests.native
    result = PolicyTests.result
    failed = PolicyTests.failed
    setUp = InternalDebugTests.setUp

    def test_recording_permission_rejected_but_playback_and_network_preserved(self):
        self.facts['usesPermissions'] = ['android.permission.INTERNET', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.BLUETOOTH_CONNECT']
        self.assertTrue(self.result()['ok'], self.result())
        self.facts['usesPermissions'].append('android.permission.RECORD_AUDIO')
        self.failed('noRecordingPermission')

    def test_parser_recognizes_both_permission_forms(self):
        xml = FIXTURE.read_text().replace('</manifest>', '<uses-permission android:name="android.permission.INTERNET"/><uses-permission-sdk-23 android:name="android.permission.RECORD_AUDIO"/></manifest>')
        self.assertIn('android.permission.RECORD_AUDIO', p.parse_manifest(xml)['usesPermissions'])

    def test_native_recovery_does_not_require_retired_component_identity(self):
        PolicyTests.recovery(self)
        retired = {'com.lightningstudio.watchrss.AcousticConnectionActivity', 'com.lightningstudio.watchrss.DebugAcousticConnectionActivity'}
        baseline, _ = p.recovery_baseline(self.ledger)
        self.assertTrue(retired.issubset({c['name'] for c in baseline['components']}))
        self.facts['components'] = [c for c in self.facts['components'] if c['name'] not in retired]
        self.facts['componentDetails'] = [c for c in self.facts['componentDetails'] if c['name'] not in retired]
        self.facts['debugExternalComponents'] = [name for name in self.facts['debugExternalComponents'] if name not in retired]
        self.facts['usesPermissions'] = ['android.permission.RECORD_AUDIO']
        self.assertTrue(self.result()['ok'], self.result())

    def test_retired_aliases_are_not_approved_for_internal_debug(self):
        for name in ('com.lightningstudio.watchrss.AcousticConnectionActivity', 'com.lightningstudio.watchrss.DebugAcousticConnectionActivity'):
            with self.subTest(name=name):
                self.setUp()
                self.facts['componentDetails'].append({'type': 'activity-alias', 'name': name, 'node': {'attributes': {p.ANDROID+'name': name, p.ANDROID+'exported': 'true', p.ANDROID+'permission': 'android.permission.DUMP'}, 'children': []}})
                self.facts['components'].append({'type': 'activity-alias', 'name': name})
                self.facts['debugExternalComponents'].append(name)
                self.failed('debugExternal')

    def test_extra_debug_alias_is_not_implicitly_allowed(self):
        self.facts['componentDetails'].append({'type': 'activity-alias', 'name': 'com.lightningstudio.watchrss.debug.Other', 'node': {'attributes': {p.ANDROID+'name': 'com.lightningstudio.watchrss.debug.Other'}, 'children': []}})
        self.facts['debugExternalComponents'].append('com.lightningstudio.watchrss.debug.Other')
        self.failed('debugExternal')


if __name__ == '__main__':
    unittest.main()
