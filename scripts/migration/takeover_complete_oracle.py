"""Independent offline SQL/reader oracle plus byte checks of every source asset/store.

Inputs and scratch stay private. Output contains fixed table names, counts and booleans.
The tiny temporary tar contains preference metadata and empty asset names only, never
database/media contents; it is removed together with the disposable SQL copies.
"""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
from stage_native_v18 import stage
from stage_reader_presets import run as reader_stage
from takeover_oracle import compare, connect_copy


def same_file(left, right):
    if not left.is_file() or not right.is_file():
        return False
    with left.open('rb') as a, right.open('rb') as b:
        return hashlib.file_digest(a, 'sha256').digest() == hashlib.file_digest(b, 'sha256').digest()


def compare_complete(native, candidate):
    result = compare(native, candidate)
    with tempfile.TemporaryDirectory(prefix='wrss-complete-oracle-', dir=native.parent) as temp:
        scratch = Path(temp)
        with contextlib.closing(connect_copy(native, 'databases/watchrss.db', temp)) as source:
            source.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        with contextlib.closing(connect_copy(candidate, 'podjs.sqlite', temp)) as actual:
            baseline = scratch / 'baseline.sqlite'
            lock = json.loads((Path(__file__).resolve().parents[2] / 'framework.lock.json').read_text())
            schema = Path(lock['path']) / 'platforms/android/runtime/src/main/resources/dev/podjs/runtime/watchrss-schema.json'
            with contextlib.closing(sqlite3.connect(baseline)) as db, db:
                # Independent versioned schema, rather than trusting the candidate's DDL.
                for sql in json.loads(schema.read_text()):
                    db.execute(sql)
                db.execute("INSERT INTO sync_local_identity VALUES(1,'oracle','oracle')")
            metadata = scratch / 'metadata-only.tar'
            with tarfile.open(metadata, 'w', format=tarfile.GNU_FORMAT) as archive:
                for path in sorted(native.rglob('*')):
                    if not path.is_file() or path.relative_to(native).parts[0] == 'databases':
                        continue
                    name = path.relative_to(native).as_posix()
                    data = path.read_bytes() if name in ('shared_prefs/watch_device_identity.xml', 'shared_prefs/reader_preset_state.xml') else b''
                    info = tarfile.TarInfo(name); info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
            expected = scratch / 'expected.sqlite'
            with contextlib.redirect_stdout(io.StringIO()):
                stage(scratch / 'watchrss.db', baseline, metadata, expected, scratch / 'sql-report.json')
                reader_stage(scratch / 'watchrss.db', metadata, scratch / 'reader.json', scratch / 'reader-report.json')
            checks = {}
            # This is a regenerated counter, deliberately excluded by the original independent oracle.
            # Runtime-derived caches may be hydrated after activation; they are not imported native tables.
            derived = {'sync_library_revision', 'article_sync_content', 'article_sync_encoding_cache',
                       'article_sync_encoding_state', 'article_sync_cache_state'}
            with contextlib.closing(sqlite3.connect(expected)) as db:
                ddl = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name"
                result['targetSchema'] = list(db.execute(ddl)) == list(actual.execute(ddl))
                for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
                    if table in derived:
                        continue
                    columns = [r[1] for r in db.execute('PRAGMA table_info("' + table + '")')]
                    def rows(connection):
                        values = []
                        for row in connection.execute('SELECT * FROM "' + table + '"'):
                            row = list(row)
                            if table == 'llm_token_usage':
                                i = columns.index('usage_json'); row[i] = json.loads(row[i])
                            values.append(row)
                        return sorted(values, key=repr)
                    left, right = rows(db), rows(actual)
                    checks[table] = {'pass': left == right, 'sourceRows': len(left), 'targetRows': len(right)}
            result['allTargetTables'] = checks
            result['targetIntegrity'] = actual.execute('PRAGMA quick_check').fetchone() == ('ok',) and not actual.execute('PRAGMA foreign_key_check').fetchall()
        reader = json.loads((scratch / 'reader.json').read_text())
        kv = json.loads((candidate / 'podjs/podjs-kv.json').read_text())['watchrss.reader-presets']
        canonical_rows = lambda rows: sorted(rows, key=lambda row: json.dumps(row, sort_keys=True))
        reader_checks = {'fieldSets': set(reader) == set(kv) and set(reader['assets']) == set(kv['assets']) and
                                        all(set(reader[k]) == set(kv[k]) for k in ('selection', 'schedule')),
                         'version': reader['version'] == kv.get('version'),
                         'records': canonical_rows(reader['records']) == canonical_rows(kv['records'])}
        for key in ('fonts', 'backgrounds', 'deletions'):
            reader_checks[key] = canonical_rows(reader['assets'][key]) == canonical_rows(kv['assets'][key])
        for section in ('selection', 'schedule'):
            for key in reader[section]:
                reader_checks[section + '.' + key] = reader[section][key] == kv[section].get(key)
        result['readerStateChecks'] = reader_checks
        result['readerCatalogsAndSelection'] = all(reader_checks.values())
    files = json.loads((candidate / 'files-snapshot.json').read_text())['entries']
    assets = 0
    expected_files = {p.relative_to(native).as_posix() for p in (native / 'files').rglob('*')
                      if p.is_file() and not p.relative_to(native).as_posix().startswith('files/datastore/')}
    inventory_complete = set(files) == expected_files
    file_ok = inventory_complete
    for path, record in files.items():
        if path not in expected_files:
            # Never follow an untrusted absolute/traversal manifest path.
            file_ok = False
            continue
        source = native / path
        file_ok &= same_file(source, candidate / 'files-source' / path)
        if record['category'] == 'asset':
            assets += 1
            file_ok &= same_file(source, candidate / 'podjs/files' / path.removeprefix('files/'))
    source_stores = [p for directory in ('shared_prefs', 'files/datastore') for p in (native / directory).glob('*') if p.is_file()]
    # P5's exact instrumentation DataStores are retained by the file converter,
    # never mixed with real user preference candidates.
    store_ok = all(same_file(p, candidate / 'stores-source' / p.relative_to(native)) or
                   same_file(p, candidate / 'files-source' / p.relative_to(native)) for p in source_stores)
    result['allFiles'] = {'pass': bool(file_ok), 'inventoryComplete': inventory_complete,
                          'snapshotFiles': len(files), 'publishedAssets': assets}
    result['allStoreSourceBytes'] = {'pass': store_ok, 'files': len(source_stores)}
    result['storeCandidateValidated'] = json.loads((candidate / 'stores-validation.json').read_text())['candidateValid'] is True
    result['excludedDerivedTables'] = sorted(derived)
    result['pass'] &= result['targetSchema'] and all(x['pass'] for x in checks.values()) and result['targetIntegrity'] and result['readerCatalogsAndSelection'] and file_ok and store_ok and result['storeCandidateValidated']
    result['scope'] = 'independent offline mappings of all imported SQL tables and reader KV; every asset/store source byte; host production store verification; isolated secrets excluded'
    return result


if __name__ == '__main__':
    import argparse
    import os
    import sys
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    args = parser.parse_args()
    for path in (args.native, args.candidate):
        if not path.resolve().is_relative_to(Path('/tmp')):
            parser.error('inputs must be private copies under /tmp')
    try:
        result = compare_complete(args.native, args.candidate)
        print(json.dumps(result, indent=2))
        sys.exit(0 if result['pass'] else 1)
    except Exception as error:
        import traceback
        frame = traceback.extract_tb(error.__traceback__)[-1]
        print(json.dumps({'pass': False, 'error': 'complete_oracle_failed', 'type': type(error).__name__,
                          'function': frame.name, 'line': frame.lineno}))
        sys.exit(1)
