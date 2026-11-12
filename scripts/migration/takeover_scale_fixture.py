#!/usr/bin/env python3
"""Synthetic Compose Room v18 sandbox. Never reads an installed package or account."""
import argparse
import json
from pathlib import Path
import sqlite3
import struct
import zlib


def png(size=0):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    header = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 32, 32, 8, 2, 0, 0, 0))
    pixels = chunk(b'IDAT', zlib.compress((b'\0' + bytes([32, 64, 96]) * 32) * 32))
    end = chunk(b'IEND', b'')
    padding = chunk(b'tEXt', b'Comment\0' + b'm' * (size - len(header + pixels + end) - 20)) if size else b''
    return header + pixels + padding + end


def preferences(values):
    def varint(value):
        out = bytearray()
        while value >= 128:
            out.append((value & 127) | 128)
            value >>= 7
        return bytes(out + bytes([value]))
    def field(tag, data):
        return bytes([tag]) + varint(len(data)) + data
    return b''.join(field(10, field(10, key.encode()) + field(18, b'\x18' + varint(value))) for key, value in values.items())


def create(root: Path, contract: Path, articles=6006, inline_bytes=0, large_note=False):
    if articles < 1200 or inline_bytes < 0:
        raise ValueError('fixture_size_invalid')
    if root.exists():
        raise ValueError('fixture_destination_exists')
    root.mkdir(parents=True, mode=0o700)
    schema = json.loads(contract.read_text())
    (root / 'databases').mkdir()
    db = sqlite3.connect(root / 'databases/watchrss.db')
    for sql in schema['sql']:
        db.execute(sql)
    db.execute('PRAGMA user_version=18')

    def row(table, ident):
        return {c['name']: None if not c['notnull'] and not c['pk'] else
                f"{c['name']}-{ident}" if c['type'] == 'TEXT' else
                0.25 if c['type'] == 'REAL' else ident for c in schema['tables'][table]}

    def insert(table, value):
        columns = ','.join('"' + k + '"' for k in value)
        db.execute(f'INSERT INTO {table}({columns}) VALUES({",".join("?" for _ in value)})', tuple(value.values()))

    for i in range(1, 14):
        r = row('rss_channels', i)
        r.update(url='https://migration.invalid/rss' if i == 1 else f'https://watchrss.local/import-txt-novel/fixture-{i}',
                 isPinned=0, useOriginalContent=0, continuePlaybackInBackground=0)
        insert('rss_channels', r)
    body = '合成正文 😀 ' * 160
    for i in range(1, articles + 1):
        r = row('rss_items', i)
        content = 'x' * inline_bytes if inline_bytes and i <= 1024 else 'watchrss-watch-content:body.txt' if i % 10 == 0 else body
        channel = 1 if i <= articles - 1200 else 2 + (i - (articles - 1199)) // 100
        link = f'https://migration.invalid/article/{i}' if channel == 1 else f'https://watchrss.local/import-txt-novel/fixture-{channel}/chapter-{i}'
        r.update(channelId=channel,
                 content=content,
                 originalContent=None, link=link, isRead=i % 2,
                 isLiked=0, readingProgress=0.25, readingPositionChangedAt=0, guid=f'migration-{i}', dedupKey=f'guid:migration-{i}')
        insert('rss_items', r)
        if i % 10 == 0:
            r = row('saved_entries', i)
            r.update(itemId=i, saveType='FAVORITE')
            insert('saved_entries', r)
    for i in range(1, 401):
        r = row('watch_notes', i)
        wide = 'n' * (3 * 1024**2) if large_note and i == 400 else None
        r.update(folderId=None, markdown=wide if wide else f'合成笔记 {i} ![](assets/note.png)', plainText=wide if wide else f'合成笔记 {i}',
                 baseMarkdown=wide if wide else '', deleted=0, pinned=0)
        insert('watch_notes', r)
    for i in range(1, 201):
        r = row('offline_media', i)
        r.update(itemId=i, mediaType='IMAGE', originUrl=f'https://migration.invalid/media/{i}',
                 localPath=f'/data/user/0/com.lightningstudio.watchrss.podjs.rehearsal/files/offline/rss/{i}/media.png')
        insert('offline_media', r)
        f = root / f'files/offline/rss/{i}/media.png'
        f.parent.mkdir(parents=True)
        f.write_bytes(png(65536))
    db.commit()
    assert db.execute('PRAGMA quick_check').fetchone() == ('ok',)
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    db.close()
    for name, data in {
        'files/article_content/body.txt': ('书籍正文 😀\n' * 10000).encode(),
        'files/notes/assets/note.png': png(),
        'files/datastore/settings.preferences_pb.preferences_pb': preferences({'oobe_seen_version': 3, 'privacy_policy_agreed_version': 1, 'reading_font_size_sp': 16}),
        'shared_prefs/watch_device_identity.xml': b'<map><string name="device_id">migration-fixture</string></map>',
    }.items():
        f = root / name
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
    return {'articles': articles, 'bookChapters': 1200, 'notes': 400, 'media': 200}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--room-contract', required=True, type=Path)
    parser.add_argument('--inline-bytes', type=int, default=0)
    parser.add_argument('--large-note', action='store_true')
    args = parser.parse_args()
    print(json.dumps(create(args.output, args.room_contract, inline_bytes=args.inline_bytes, large_note=args.large_note)))
