import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import takeover_rehearsal as r


class RehearsalTest(unittest.TestCase):
    def test_phase_samples_are_fixed_deduplicated_and_monotonic_safe(self):
        samples=[]
        r.sample_phase(samples, {'phase':'COPYING'}, -5)
        r.sample_phase(samples, {'phase':'COPYING'}, 10)
        r.sample_phase(samples, {'phase':'SECRET_VALUE'}, 20)
        r.sample_phase(samples, {'phase':'VERIFYING'}, 30.9)
        self.assertEqual(samples,[{'phase':'COPYING','elapsedMs':0},{'phase':'VERIFYING','elapsedMs':30}])

    def test_dry_run_has_no_io(self):
        with patch.object(r.subprocess, 'run', side_effect=AssertionError('device I/O')), patch.object(r.tempfile, 'mkdtemp', side_effect=AssertionError('write')):
            r.rehearse(SimpleNamespace(dry_run=True, serial='synthetic'))

    def test_archive_rejects_escape_links_duplicates_and_podjs(self):
        for name, kind, duplicate in [('../escape', tarfile.REGTYPE, False), ('/files/x', tarfile.REGTYPE, False),
            ('files/link', tarfile.SYMTYPE, False), ('files/hard', tarfile.LNKTYPE, False),
            ('files/fifo', tarfile.FIFOTYPE, False), ('files/x', tarfile.REGTYPE, True),
            ('files/package-takeover/journal', tarfile.REGTYPE, False)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                stream=io.BytesIO()
                with tarfile.open(fileobj=stream,mode='w') as archive:
                    info=tarfile.TarInfo(name); info.type=kind; info.linkname='/tmp/forbidden'
                    archive.addfile(info)
                    if duplicate: archive.addfile(info)
                stream.seek(0)
                with self.assertRaises(ValueError):r.unpack(stream,Path(temp),native=True)

    def test_valid_archive_and_digest_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            stream=io.BytesIO()
            with tarfile.open(fileobj=stream,mode='w') as archive:
                info=tarfile.TarInfo('files/body');info.size=4;archive.addfile(info,io.BytesIO(b'body'))
            stream.seek(0);root=Path(temp);r.unpack(stream,root,native=True)
            before=r.manifest(root);self.assertTrue(r.unchanged(before,r.manifest(root)))
            (root/'files/body').write_bytes(b'edit');self.assertFalse(r.unchanged(before,r.manifest(root)))

    def test_activation_requires_matching_pointer_and_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);base=root/'files/package-takeover';g=base/'generations/g-fixture';g.mkdir(parents=True)
            receipt='generation=g-fixture\nreceipt='+'a'*64+'\n'
            (base/'journal').write_text('phase=ACTIVE\n'+receipt);(base/'active').write_text(receipt);(g/'activation-receipt').write_text(receipt)
            self.assertEqual(r.activated(root)[0],g)
            (g/'activation-receipt').write_text(receipt.replace('a'*64,'b'*64))
            with self.assertRaises(ValueError):r.activated(root)

    def test_wrong_apk_refused_before_device_writes(self):
        with patch.object(r,'command',return_value=b'com.lightningstudio.watchrss.podjs\n') as cmd:
            with self.assertRaisesRegex(ValueError,'identity_mismatch'):
                r.rehearse(SimpleNamespace(dry_run=False,apk=Path('fake.apk')))
            self.assertEqual(cmd.call_count,1)
            self.assertEqual(cmd.call_args.args[0][0],'apkanalyzer')

    def test_orchestration_active_and_blocked(self):
        for blocked in (False, True):
            with self.subTest(blocked=blocked):
                calls=[]
                def cmd(argv, **kwargs):
                    calls.append(argv)
                    if argv[:3]==['apkanalyzer','manifest','application-id']:
                        return (r.REHEARSAL+('.test' if argv[-1]=='test.apk' else '')).encode()
                    if argv[:3]==['apkanalyzer','manifest','debuggable']:return b'true'
                    if argv[:3]==['apkanalyzer','manifest','print']:
                        return ('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><instrumentation android:targetPackage="'+r.REHEARSAL+'"/></manifest>').encode()
                    return b'OK (1 test)'
                def capture(adb, package, root, **kwargs):
                    root.mkdir()
                    (root/'databases').mkdir();(root/'databases/watchrss.db').write_bytes(b'native')
                    if package==r.REHEARSAL:
                        base=root/'files/package-takeover';g=base/'generations/g-test';g.mkdir(parents=True)
                        receipt='generation=g-test\nreceipt='+'a'*64+'\n'
                        (base/'journal').write_text('phase=ACTIVE\n'+receipt)
                        (base/'active').write_text(receipt);(g/'activation-receipt').write_text(receipt)
                    return r.manifest(root)
                launches=[{'phase':'BLOCKED' if blocked else 'ACTIVE','phases':r.PHASES,'reason':'needs_reauth' if blocked else ''}, {'phase':'ACTIVE','phases':[],'reason':''}]
                args=SimpleNamespace(dry_run=False,apk=Path('app.apk'),test_apk=Path('test.apk'),adb=['adb','-s','synthetic'],serial='synthetic',takeover_timeout=1,cleanup_private=True)
                with patch.object(r,'command',side_effect=cmd), patch.object(r,'capture',side_effect=capture) as snapshots, patch.object(r,'upload'), patch.object(r,'launch',side_effect=launches), patch.object(r,'oracle',return_value={'pass':True}), patch.object(r.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout=b'',stderr=b'')):
                    if blocked:
                        with self.assertRaisesRegex(ValueError,'rehearsal_not_passed'):r.rehearse(args)
                    else:r.rehearse(args)
                    self.assertEqual(snapshots.call_args.args[1],r.NATIVE)
                self.assertFalse(any('com.lightningstudio.watchrss.podjs' in call for call in calls))
                self.assertEqual(sum('instrument' in call for call in calls),0 if blocked else 1)

    def test_oracle_detects_progress_settings_and_saved_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);native=root/'native';candidate=root/'candidate'
            (native/'databases').mkdir(parents=True);(candidate/'podjs').mkdir(parents=True)
            s=sqlite3.connect(native/'databases/watchrss.db');d=sqlite3.connect(candidate/'podjs.sqlite')
            s.executescript('''CREATE TABLE rss_channels(id,url,title,description,imageUrl,lastFetchedAt,createdAt,sortOrder,isPinned);
CREATE TABLE rss_items(id,channelId,title,description,content,link,guid,pubDate,imageUrl,audioUrl,videoUrl,isRead,readingProgress,dedupKey,fetchedAt,readingPositionChangedAt,readingPositionBytes,readingPositionContentHash);
CREATE TABLE saved_entries(itemId,saveType,createdAt,sortOrder);
CREATE TABLE saved_sync_states(itemId,saveType,saved,changedAt,sortOrder);
INSERT INTO rss_channels VALUES(1,'url','title',NULL,NULL,0,1,2,1);
INSERT INTO rss_items VALUES(2,1,'article','','body','link',NULL,NULL,NULL,NULL,NULL,1,0.5,'key',3,4,5,'hash');
INSERT INTO saved_entries VALUES(2,'FAVORITE',6,7);''')
            d.executescript('''CREATE TABLE channels(id,url,title,description,image_url,last_fetched_at,created_at,sort_order,is_pinned);
CREATE TABLE articles(id,channel_id,title,description,content,link,guid,pub_date,image_url,audio_url,video_url,is_read,reading_progress,dedup_key,fetched_at,is_saved);
CREATE TABLE article_reading_state(article_id,progress,changed_at,position_bytes,position_hash);
CREATE TABLE article_saved_states(article_id,save_type,saved,changed_at,sort_order);
CREATE TABLE article_saved_entry_times(article_id,save_type,created_at);
INSERT INTO channels VALUES(1,'url','title',NULL,NULL,0,1,2,1);
INSERT INTO articles VALUES(2,1,'article','','body','link',NULL,NULL,NULL,NULL,NULL,1,0.5,'key',3,1);
INSERT INTO article_reading_state VALUES(2,0.5,4,5,'hash');
INSERT INTO article_saved_states VALUES(2,'favorite',1,6,-7);
INSERT INTO article_saved_entry_times VALUES(2,'favorite',6);''')
            s.commit();d.commit();s.close();d.close()
            # Genuine protobuf map entry: reading_font_size_sp => int 18.
            key=b'reading_font_size_sp';entry=b'\x0a'+bytes([len(key)])+key+b'\x12\x02\x18\x12'
            (native/'files/datastore').mkdir(parents=True)
            (native/'files/datastore/settings.preferences_pb').write_bytes(b'\x0a'+bytes([len(entry)])+entry)
            kv=candidate/'podjs/podjs-kv.json';kv.write_text(json.dumps({'watchrss.settings':{'fontSizeSp':18}}))
            before=r.manifest(native);self.assertTrue(r.oracle(native,candidate)['pass'])
            with sqlite3.connect(candidate/'podjs.sqlite') as db:db.execute('UPDATE article_reading_state SET progress=0.9')
            self.assertFalse(r.oracle(native,candidate)['checks']['reading_state']['pass'])
            kv.write_text(json.dumps({'watchrss.settings':{'fontSizeSp':14}}))
            self.assertFalse(r.oracle(native,candidate)['checks']['settings']['pass'])
            with sqlite3.connect(candidate/'podjs.sqlite') as db:db.execute('DELETE FROM article_saved_states')
            self.assertFalse(r.oracle(native,candidate)['checks']['saved_states']['pass'])
            self.assertEqual(before,r.manifest(native))

if __name__=='__main__':unittest.main()
