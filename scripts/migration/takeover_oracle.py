#!/usr/bin/env python3
"""Read private rehearsal copies; report counts/booleans only, never source values."""
import json
from pathlib import Path
import sqlite3
import tempfile
import shutil
from stage_settings import decode


def connect_copy(root, name, scratch):
    # SQLite may recover WAL/SHM: only open a disposable working copy.
    target = Path(scratch) / Path(name).name
    for suffix in ('', '-wal', '-shm', '-journal'):
        source = root / (name + suffix)
        if source.is_file():
            shutil.copyfile(source, Path(str(target) + suffix))
    db = sqlite3.connect(target)
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('oracle_integrity_failed')
    return db


def compare(native, candidate):
    results = {}
    with tempfile.TemporaryDirectory(prefix='wrss-oracle-', dir=native.parent) as temp:
        s = connect_copy(native, 'databases/watchrss.db', temp)
        d = connect_copy(candidate, 'podjs.sqlite', temp)
        try:
            checks = {
                'channels': ('SELECT id,url,title,description,imageUrl,lastFetchedAt,createdAt,sortOrder,isPinned FROM rss_channels ORDER BY id',
                             'SELECT id,url,title,description,image_url,last_fetched_at,created_at,sort_order,is_pinned FROM channels ORDER BY id'),
                'articles': ('SELECT id,channelId,title,description,content,link,guid,pubDate,imageUrl,audioUrl,videoUrl,isRead,readingProgress,dedupKey,fetchedAt FROM rss_items ORDER BY id',
                             'SELECT id,channel_id,title,description,content,link,guid,pub_date,image_url,audio_url,video_url,is_read,reading_progress,dedup_key,fetched_at FROM articles ORDER BY id'),
                'reading_state': ('SELECT id,readingProgress,readingPositionChangedAt,readingPositionBytes,readingPositionContentHash FROM rss_items WHERE readingProgress != 0 OR readingPositionChangedAt != 0 ORDER BY id',
                                  'SELECT article_id,progress,changed_at,position_bytes,position_hash FROM article_reading_state ORDER BY article_id'),
                'favorite_flags': ("SELECT id,EXISTS(SELECT 1 FROM saved_entries WHERE itemId=rss_items.id AND saveType='FAVORITE') FROM rss_items ORDER BY id",
                                   'SELECT id,is_saved FROM articles ORDER BY id'),
                'saved_entry_times': ("SELECT itemId,CASE saveType WHEN 'FAVORITE' THEN 'favorite' WHEN 'WATCH_LATER' THEN 'watchLater' ELSE saveType END,createdAt FROM saved_entries ORDER BY 1,2",
                                      'SELECT article_id,save_type,created_at FROM article_saved_entry_times ORDER BY 1,2'),
            }
            for label, (left, right) in checks.items():
                a, b = s.execute(left).fetchall(), d.execute(right).fetchall()
                results[label] = {'pass': a == b, 'sourceRows': len(a), 'targetRows': len(b)}
            # Both current entries and tombstone state; native sort order reverses in UI storage.
            saved = {}
            ids = {r[0] for r in s.execute('SELECT id FROM rss_items')}
            for item, kind, enabled, changed, order in s.execute("SELECT itemId,saveType,saved,changedAt,sortOrder FROM saved_sync_states WHERE saveType IN ('FAVORITE','WATCH_LATER')"):
                if item in ids:
                    saved[(item, 'favorite' if kind == 'FAVORITE' else 'watchLater')] = [enabled, changed, -order]
            for item, kind, created, order in s.execute('SELECT itemId,saveType,createdAt,sortOrder FROM saved_entries'):
                key = (item, 'favorite' if kind == 'FAVORITE' else 'watchLater')
                saved[key] = [1, saved.get(key, [None, created])[1], -order]
            actual = {(r[0], r[1]): list(r[2:]) for r in d.execute('SELECT article_id,save_type,saved,changed_at,sort_order FROM article_saved_states')}
            results['saved_states'] = {'pass': saved == actual, 'sourceRows': len(saved), 'targetRows': len(actual)}
        finally:
            s.close(); d.close()
    paths = [native / 'files/datastore' / x for x in ('settings.preferences_pb', 'settings.preferences_pb.preferences_pb')]
    paths = [p for p in paths if p.is_file()]
    if len(paths) > 1:
        raise ValueError('oracle_ambiguous_settings')
    kv = json.loads((candidate / 'podjs/podjs-kv.json').read_text())
    if paths:
        values = decode(paths[0].read_bytes())
        mapping = {'reading_font_size_sp': 'fontSizeSp', 'tts_speed': 'speechRate',
                   'reader_auto_scroll_enabled': 'readerAutoStart',
                   'reader_auto_scroll_lines_per_second': 'readerScrollSpeed',
                   'media_volume_control_enabled': 'mediaVolumeControl',
                   'media_volume_guard_enabled': 'mediaVolumeGuard',
                   'sync_media_keep_alive_enabled': 'syncMediaKeepAlive', 'share_use_system': 'shareUseSystem',
                   'llm_enabled': 'llmEnabled', 'llm_auto_summarize': 'llmAutoSummarize', 'llm_show_token_usage': 'llmShowTokenUsage'}
        expected = {dst: values[src] for src, dst in mapping.items() if src in values}
        if 'cache_limit_bytes' in values:
            expected['cacheLimitMb'] = values['cache_limit_bytes'] // (1024 * 1024)
        if 'llm_prompt_preset' in values:
            expected['llmPromptPreset'] = values['llm_prompt_preset'] + 1
        settings = kv.get('watchrss.settings', {})
        ok = all(settings.get(k) == v for k, v in expected.items())
        onboard = kv.get('watchrss.onboarding', {})
        for src, dst in [('oobe_seen_version', 'oobeSeenVersion'), ('privacy_policy_agreed_version', 'privacyPolicyAgreedVersion')]:
            if src in values:
                ok = ok and onboard.get(dst) == values[src]
        results['settings'] = {'pass': ok, 'checkedKeys': len(expected), 'sourcePresent': True}
    else:
        results['settings'] = {'pass': True, 'checkedKeys': 0, 'sourcePresent': False}
    return {'pass': all(v['pass'] for v in results.values()), 'checks': results,
            'scope': 'all core rows; selected explicit settings; no secret values exported'}


if __name__ == '__main__':
    import argparse
    import os
    import sys
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    args = parser.parse_args()
    # Inputs stay private; never let this helper stage personal SQLite outside /tmp.
    for path in (args.native, args.candidate):
        if not path.resolve().is_relative_to(Path('/tmp')):
            parser.error('inputs must be private copies under /tmp')
    try:
        result = compare(args.native, args.candidate)
        print(json.dumps(result, indent=2))
        sys.exit(0 if result['pass'] else 1)
    except Exception:
        print('oracle_failed (source values redacted)', file=sys.stderr)
        sys.exit(1)
