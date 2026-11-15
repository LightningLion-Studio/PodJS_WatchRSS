#!/usr/bin/env python3
"""Independent Python/stdlib oracle for frozen library-resume-v1 wire bytes.

Fixtures are synthetic. No account credential, signing key or recovery token is
created. Kotlin/TS consumers must use the stored byte strings without reordering.
"""
import base64
import gzip
import hashlib
import json
from pathlib import Path
import random
import struct


def h(data):
    return hashlib.sha256(data).hexdigest()


def lp(value):
    data = value.encode('utf-8')
    return struct.pack('>I', len(data)) + data


def d(domain, parts):
    return h(lp(domain) + struct.pack('>I', len(parts)) + b''.join(map(lp, parts)))


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def b64(data):
    return base64.b64encode(data).decode('ascii')


LIMITS = dict(maxObjectBytes=16777216, maxInFlightObjects=4, maxFrameBytes=262144,
              maxManifestPageBytes=131072, maxManifestPageEntries=16,
              maxMetadataBytes=16384, maxPlanObjects=4096, maxManifestBytes=16777216,
              maxRangesPerPage=128, maxResultsPerPage=16, maxStagingBytes=134217728,
              maxJournalBytes=67108864, maxActiveJobs=2)
KINDS = ['articleBody', 'articleMetadata', 'noteAsset', 'readerMetadata', 'readerResource', 'rssSource']
CAP = dict(version=1, kinds=[dict(kind=k, schemaVersion=1, send=True, receive=True) for k in KINDS], limits=LIMITS)
SELECTION = dict(kinds=[dict(kind=k, schemaVersion=1) for k in ['articleBody', 'articleMetadata', 'rssSource']], limits=LIMITS)


def cd(c):
    args = [str(c['version']), str(len(c['kinds']))]
    for k in c['kinds']:
        args += [k['kind'], str(k['schemaVersion']), str(k['send']).lower(), str(k['receive']).lower()]
    return d('wrss.library-resume.v1/capability', args + [str(c['limits'][k]) for k in LIMITS])


def sd(s):
    args = [str(len(s['kinds']))]
    for k in s['kinds']:
        args += [k['kind'], str(k['schemaVersion'])]
    return d('wrss.library-resume.v1/selection', args + [str(s['limits'][k]) for k in LIMITS])


def obj(kind, bid, data, meta, dependencies=()):
    hashes = [h(data[i:i+65536]) for i in range(0, len(data), 65536)]
    raw = encoded(meta)
    deps = sorted(dependencies)
    encoding = 'article-v14' if kind == 'articleBody' else 'raw' if kind in ['noteAsset', 'readerResource'] else 'none'
    args = [kind, '1', bid, 'v1', encoding, str(len(data)), h(data), str(len(hashes)), *hashes, h(raw), str(len(deps)), *deps]
    return dict(objectId=d('wrss.library-resume.v1/object', args), kind=kind, schemaVersion=1,
                businessId=bid, contentVersion='v1', encoding=encoding, size=len(data), sha256=h(data),
                chunkHashes=hashes, metadataBase64=b64(raw), metadataSha256=h(raw), dependsOn=deps)


def snap(s):
    return ['none'] if s is None else ['some', s['snapshotId'], s['manifestDigest'], str(s['fromExclusive']), str(s['toInclusive'])]


def snapshot_args(s):
    return [s['snapshotId'], s['manifestDigest'], str(s['fromExclusive']), str(s['toInclusive'])]


def main():
    rng = random.Random(20261115)
    rid = lambda: f'{rng.getrandbits(128):032x}'
    account = dict(backendBaseUrl='https://resume.invalid', userId='RESUMEC-FIXTURE')
    account_scope = d('wrss.library-resume.v1/account', list(account.values()))
    phone, watch = 'RESUMEC-PHONE', 'RESUMEC-WATCH'
    job = rid()
    phone_snapshot = dict(snapshotId='phone-v1', manifestDigest=h(b'phone frozen manifest'), fromExclusive=0, toInclusive=0)
    watch_snapshot = dict(snapshotId='watch-v1', manifestDigest=h(b'watch frozen manifest'), fromExclusive=0, toInclusive=0)
    text = b64(rng.randbytes(110000))
    # Existing v14 Java JSON omits null HTML and escapes every slash.
    body_json = encoded(dict(contentText=text)).replace(b'/', b'\\/')
    body = gzip.compress(body_json, compresslevel=6, mtime=0)
    # Match the existing stable gzip header (OS byte does not carry identity).
    body = body[:9] + b'\xff' + body[10:]
    assert 65536 < len(body) < 131072
    metadata = dict(articleId='resume-article', sourceDeviceId=phone,
                    url='https://example.invalid/resume', title='断点续传 😀', siteName='Fixture',
                    excerpt='fixture', imageUrl=None, contentHash=h(text.encode()), importedAt=1000,
                    updatedAt=2000, independentSaved=True, independentChangedAt=2000,
                    independentSortOrder=2000, rssSourceUrl=None, rssSourceTitle=None,
                    favoriteSaved=False, favoriteChangedAt=0, favoriteSortOrder=0,
                    watchLaterSaved=False, watchLaterChangedAt=0, watchLaterSortOrder=0,
                    deleted=False, deletedAt=0, readingProgress=0.25, readingPositionBytes=0,
                    readingPositionContentHash='', readingPositionChangedAt=0, isRead=False,
                    body=dict(bodyHash=h(body), bodyByteCount=len(body), chunkSize=131072,
                              chunkHashes=[h(body)], metadataOnly=False))
    source = dict(url='https://feed.invalid/rss', sourceDeviceId=phone, title='Fixture', description='',
                  siteUrl=None, imageUrl=None, createdAt=1000, updatedAt=2000, sortOrder=2000,
                  isPinned=False, deleted=False, deletedAt=0)
    article = obj('articleBody', metadata['articleId'], body, metadata)
    rss = obj('rssSource', source['url'], b'', source)
    objects = sorted([article, rss], key=lambda o: o['objectId'])
    root = d('wrss.library-resume.v1/objects', [str(len(objects)), *[o['objectId'] for o in objects]])
    plan_args = [account_scope, phone, watch, 'phoneToWatch', sd(SELECTION),
                 *snapshot_args(phone_snapshot), *snapshot_args(watch_snapshot), str(len(objects)), root]
    plan = d('wrss.library-resume.v1/plan', plan_args)
    requests = []

    def request(name, phase, payload, args, prepare=False, epoch=1):
        jd, pd = ('', '') if prepare else (job, plan)
        digest = d('wrss.library-resume.v1/request', [jd, pd, phase, *args])
        wire = dict(action='syncLibraryResume', version=1, phase=phase, type='request',
                    jobId=None if prepare else job, requestId=rid(), requestDigest=digest,
                    epoch=None if prepare or phase == 'begin' else epoch,
                    planDigest=None if prepare else plan, payload=payload)
        requests.append(dict(name=name, phaseArgs=args, frame=wire, utf8Base64=b64(encoded(wire))))
        return wire

    offer = dict(step='offer', accountScope=account_scope, phoneDeviceId=phone, watchDeviceId=watch,
                 phoneCapabilities=CAP, phoneSnapshot=phone_snapshot, watchSnapshot=None)
    offered = request('offer', 'prepare', offer, ['offer', account_scope, phone, watch, cd(CAP), *snap(phone_snapshot), *snap(None)], True)
    offer_digest = d('wrss.library-resume.v1/offer', [account_scope, phone, watch, cd(CAP), cd(CAP), *snap(phone_snapshot), *snap(watch_snapshot)])
    bindings = [dict(direction='phoneToWatch', jobId=job, intent='create', selection=SELECTION)]
    prepare_digest = d('wrss.library-resume.v1/prepare', [offer_digest, '1', 'phoneToWatch', job, 'create', sd(SELECTION)])
    request('confirm', 'prepare', dict(step='confirm', offerRequestId=offered['requestId'], bindings=bindings, preparationDigest=prepare_digest), ['confirm', offered['requestId'], prepare_digest], True)
    begin = dict(intent='create', accountScope=account_scope, phoneDeviceId=phone, watchDeviceId=watch,
                 direction='phoneToWatch', phoneSnapshot=phone_snapshot, watchSnapshot=watch_snapshot,
                 selection=SELECTION, selectionDigest=sd(SELECTION), objectCount=len(objects), objectsRoot=root, pageObjectCounts=[len(objects)])
    request('begin', 'begin', begin, ['create', account_scope, phone, watch, 'phoneToWatch', sd(SELECTION), *snapshot_args(phone_snapshot), *snapshot_args(watch_snapshot), str(len(objects)), root, '1', str(len(objects))])
    pg = d('wrss.library-resume.v1/page', [plan, '0', '0', str(len(objects)), *[o['objectId'] for o in objects], '0'*64])
    request('manifest', 'manifestPage', dict(pageIndex=0, startIndex=0, previousPageDigest='0'*64, pageDigest=pg, entries=objects), ['0', '0', '0'*64, pg, str(len(objects)), *[o['objectId'] for o in objects]])
    request('missing', 'missing', dict(afterObjectId=None, afterChunkIndex=None, limit=16), ['', '', '16'])
    request('chunk0', 'putChunk', dict(objectId=article['objectId'], chunkIndex=0, dataBase64=b64(body[:65536])), [article['objectId'], '0'])
    receipts = []
    for o in objects:
        a = request('apply-'+o['kind'], 'apply', dict(objectId=o['objectId']), [o['objectId']])
        result_digest = d('wrss.library-resume.v1/applied', [job, plan, o['objectId'], a['requestId'], a['requestDigest'], watch, 'merged'])
        receipts.append(dict(jobId=job, planDigest=plan, objectId=o['objectId'], applyRequestId=a['requestId'], applyRequestDigest=a['requestDigest'], receiverDeviceId=watch, resultDigest=result_digest, outcome='merged'))
    receipt_root = d('wrss.library-resume.v1/receipts', [str(len(receipts)), *[r['resultDigest'] for r in receipts]])
    request('complete', 'complete', dict(objectCount=len(objects), receiptsRoot=receipt_root, ackToInclusive=0), [str(len(objects)), receipt_root, '0'])
    request('cancel', 'cancel', dict(reason='USER_CANCEL'), ['USER_CANCEL'])
    done = dict(state='COMPLETE', objectCount=len(objects), receiptsRoot=receipt_root, ackToInclusive=0,
                completionDigest=d('wrss.library-resume.v1/complete', [job, plan, str(len(objects)), receipt_root, '0']))
    font = dict(id='font-1', sha256=h(b'x'), displayName='Font', familyName='Font', fileName='font.ttf', mimeType='font/ttf', metadataJson='{}', modifiedBy=phone, byteCount=1, updatedAt=2000, faceCount=1, deleted=True)
    deletion = dict(kind='font', entityId='font-1', deletedBy=phone, deletedAt=2000)
    reader = obj('readerMetadata', 'font:font-1', b'', dict(presets=[], fonts=[font], backgrounds=[], deletions=[deletion]))
    resource = obj('readerResource', 'font:font.ttf', b'x', dict(kind='font', fileName='font.ttf', sha256=h(b'x'), byteCount=1), [reader['objectId']])
    boundaries = []
    for size in [0, 1, 65535, 65536, 65537, 16777216]:
        data = bytes(size)
        boundaries.append(dict(recipe=dict(repeatByte=0, length=size), size=size, sha256=h(data), chunkCount=(size+65535)//65536, lastChunkBytes=size-((size-1)//65536)*65536 if size else 0))
    names = ['utf8-digests','block-boundaries','chunk-ack-loss','staged-crash','applied-reply-loss',
             'first-terminal-reconnect','stale-connection','same-id-different-bytes','missing-corrupt-cache',
             'bidirectional-push','expiry-source-cancel','bounded-window-1864','runtime-gate',
             'legacy-v14','reconnect-thresholds','business-rollback','manifest-conflicts',
             'prepare-handoff','inverse-hash-dependencies','reader-entity-history','reader-kv-gate',
             'cancelled-resume-and-old-ack']
    image = b'\x89PNG\r\n\x1a\nRESUMEC'
    image_metadata = dict(storageKey='resume.png', sha256=h(image), size=len(image))
    asset = obj('noteAsset', 'resume.png', image, image_metadata)
    metadata_only = dict(metadata, body=dict(metadata['body'],metadataOnly=True))
    metadata_object = obj('articleMetadata', article['businessId'], b'', metadata_only)
    fixture = dict(format='library-resume-v1-vectors', version=1,
                   fixed=dict(chunkBytes=65536, retentionMillis=86400000, leaseMillis=30000),
                   account=account, accountScope=account_scope, phoneDeviceId=phone, watchDeviceId=watch,
                   capability=CAP, selection=SELECTION, capabilityDigest=cd(CAP), selectionDigest=sd(SELECTION),
                   phoneSnapshot=phone_snapshot, watchSnapshot=watch_snapshot, offerDigest=offer_digest,
                   preparationDigest=prepare_digest, bindings=bindings, bodyBase64=b64(body),
                   metadataObjects=[metadata_object], reconnectCases=[dict(disconnectMillis=[0,5000,10000],stop=True),dict(disconnectMillis=[0,5000,10001],stop=False),dict(searchOutcomes=['failure','failure','failure'],stopBeforeRound=4)], assetObjects=[asset], assetBase64=b64(image), metadataRejects=[dict(kind='noteAsset',metadata=dict(image_metadata,storageKey='../escape'),code='BUSINESS_REJECTED'),dict(kind='noteAsset',metadata=dict(image_metadata,sha256='0'*64),code='OBJECT_CONFLICT'),dict(kind='readerMetadata',metadata=dict(presets=[],fonts=[font],backgrounds=[],deletions=[dict(deletion,entityId='other')]),code='BUSINESS_REJECTED')], metadata=metadata, objects=objects, readerObjects=[reader, resource], objectsRoot=root,
                   planDigest=plan, pageDigest=pg, receipts=receipts, completion=done, requests=requests,
                   lp=[dict(value=v, hex=lp(v).hex()) for v in ['', 'ASCII', '中文', '😀', '中😀']],
                   boundaries=boundaries, scenarios=[dict(id=f'RC{i:02d}', name=name) for i, name in enumerate(names, 1)])
    path = Path(__file__).resolve().parents[2] / 'tests/fixtures/library-resume-v1.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2)+'\n')
    print(f'{path}: {len(requests)} request vectors; {len(names)} scenarios; sha256={h(path.read_bytes())}')


if __name__ == '__main__':
    main()
