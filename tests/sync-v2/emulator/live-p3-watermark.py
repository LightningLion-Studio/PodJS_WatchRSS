#!/usr/bin/env python3
"""Preserve this fixed synthetic watch author's local signing reservation floor.

Fresh emulator disks do not contain P2's two unreferenced C6 signed probes. The
fixed, retained P2 run is a test-only recovery witness, not a product recovery API.
Never infer a sequence from a clock or retire a server-side object/ref.
"""
import hashlib
import json
import sys
from pathlib import Path

watermark = Path(sys.argv[1])
base = Path('/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2')
fixture = json.loads((base / 'integration/watch.json').read_text())
proof = base / 'evidence/T-SYNCGIT-P2/watch/c5-full/summary.json'
summary = json.loads(proof.read_text())
assert summary['complete']['phase'] == 'complete'
assert summary['c3']['keyId'] == fixture['servicePin']['receiptKeyId']
assert [x['generation'] for x in summary['wrongGenerations']] == ['1', '9007199254740993']
assert all(x['server'] == 'rollback_conflict' for x in summary['wrongGenerations'])
# The retained guest reserves nextD64 once before EACH of these signed probes.
source = proof.with_name('guest.js')
assert 'nextD64(next.cloud.deviceSequence)' in source.read_text()
value = {
    'deviceId': fixture['deviceId'],
    'sequence': str(int(summary['published']['deviceSequence']) + len(summary['wrongGenerations'])),
    'witnessCommitOid': summary['published']['commitOid'],
    'source': str(proof),
    'sourceSha256': hashlib.sha256(proof.read_bytes()).hexdigest(),
    'guestSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
}
if watermark.exists():
    old = json.loads(watermark.read_text())
    assert old['deviceId'] == value['deviceId']
    if int(old['sequence']) >= int(value['sequence']):
        value = old
if len(sys.argv) == 3:
    result = Path(sys.argv[2])
    if result.exists():
        try:
            events = json.loads(result.read_text())
        except json.JSONDecodeError:
            events = []
        for event in events:
            if event.get('phase') == 'author-reserved' and int(event['deviceSequence']) > int(value['sequence']):
                value['sequence'] = event['deviceSequence']
                value['latestLocalJournalEvidence'] = str(result)
                value['latestLocalJournalSha256'] = hashlib.sha256(result.read_bytes()).hexdigest()
watermark.parent.mkdir(parents=True, exist_ok=True)
watermark.write_text(json.dumps(value, indent=2) + '\n')
