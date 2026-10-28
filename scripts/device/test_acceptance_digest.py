"""Host-only upgrade safety regression for takeover-generation SQLite."""
import hashlib
import io
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest

import acceptance


class GenerationDigestTests(unittest.TestCase):
    def test_marker_is_strict_and_legacy_remains_supported(self):
        self.assertEqual(acceptance.database_member('legacy\n'), 'databases/podjs.sqlite')
        self.assertEqual(acceptance.database_member('# properties\ngeneration=g-abc-123\n'),
                         'files/package-takeover/generations/g-abc-123/podjs.sqlite')
        for marker in ['', 'generation=../other\n', 'generation=g-x/../other\n',
                       'generation=g-a\ngeneration=g-b\n', 'generation=g-x\r\n']:
            with self.subTest(marker=marker), self.assertRaises(ValueError):
                acceptance.database_member(marker)

    def archive(self, entries):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for path, body in entries.items():
                info = tarfile.TarInfo(path)
                info.size = len(body)
                archive.addfile(info, io.BytesIO(body))
        stream.seek(0)
        return stream

    def test_active_database_is_checked_and_every_original_file_is_hashed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'fixture.sqlite'
            with sqlite3.connect(source) as db:
                db.execute('CREATE TABLE content(id INTEGER PRIMARY KEY, body TEXT)')
                db.execute("INSERT INTO content VALUES(1,'synthetic fixture')")
            raw = source.read_bytes()
            active = acceptance.database_member('generation=g-current\n')
            entries = {active: raw, 'files/package-takeover/active': b'generation=g-current\n',
                       'databases/podjs.sqlite': b'old placeholder', 'files/original.txt': b'body'}
            extracted = root / 'extract'
            extracted.mkdir()
            receipt = acceptance.stream_digest(self.archive(entries), extracted, active)
            self.assertEqual(receipt['integrity'], 'ok')
            self.assertEqual(receipt['tables']['content']['rows'], 1)
            self.assertEqual(receipt['databaseMember'], active)
            self.assertEqual(receipt['files'], {p: hashlib.sha256(b).hexdigest() for p, b in entries.items()})
            self.assertFalse(receipt['archiveStored'])
            # A stale legacy DB must never substitute for a missing selected DB.
            with self.assertRaisesRegex(ValueError, 'Selected SQLite database missing'):
                acceptance.stream_digest(self.archive({'databases/podjs.sqlite': raw}), root / 'unused', active)

    def test_legacy_database_still_has_real_integrity_and_table_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db = root / 'source.sqlite'
            with sqlite3.connect(db) as connection:
                connection.execute('CREATE TABLE fixture(value TEXT)')
            self.assertEqual(acceptance.stream_digest(self.archive({'databases/podjs.sqlite': db.read_bytes()}), root)['integrity'], 'ok')


if __name__ == '__main__':
    unittest.main()
