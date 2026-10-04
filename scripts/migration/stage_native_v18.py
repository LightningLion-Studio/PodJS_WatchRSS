#!/usr/bin/env python3
"""Build a review-only PodJS SQLite stage from a stopped native v18 snapshot.

This never writes either input or a live Android package. Reader assets and
encrypted/preferences stores remain in separate private stages.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import shutil
import sqlite3
import tarfile
import xml.etree.ElementTree as ET


CORE_TABLES = (
    "channels", "articles", "article_saved_states", "article_saved_entry_times",
    "notes", "memo_notes", "memo_folders", "offline_media", "article_native_sync_hash", "sync_saved_states",
    "sync_article_deletions", "sync_source_states", "sync_change_log",
    "sync_peer_state", "sync_article_ids", "sync_article_aliases",
)
SOURCE_TABLES = (
    "rss_channels", "rss_items", "saved_entries", "saved_sync_states",
    "rss_source_sync_states", "sync_change_log", "sync_peer_state",
    "watch_notes", "watch_note_folders", "reader_presets",
    "reader_font_assets", "reader_background_assets", "reader_deletions",
    "offline_media", "llm_token_usage",
)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def scalar(db: sqlite3.Connection, sql: str, args: tuple = ()) -> object:
    return db.execute(sql, args).fetchone()[0]


def device_order(value: str) -> str:
    return value.encode("utf-16-be", "surrogatepass").hex()


def device_id_from_tar(path: Path) -> str:
    with tarfile.open(path) as archive:
        member = archive.extractfile("shared_prefs/watch_device_identity.xml")
        if member is None:
            raise ValueError("Native device identity preference is absent")
        root = ET.fromstring(member.read())
    value = next((node.text for node in root if node.attrib.get("name") == "device_id"), None)
    if not value or not value.strip():
        raise ValueError("Native device identity is blank")
    return value.strip()


def asset_inventory(native: sqlite3.Connection, path: Path) -> dict[str, int]:
    with tarfile.open(path) as archive:
        members = set(archive.getnames())
    markers = set()
    for column in ("content", "originalContent"):
        for (value,) in native.execute(
            f"SELECT {column} FROM rss_items WHERE {column} LIKE 'watchrss-watch-content:%'"
        ):
            if value:
                markers.add(value.removeprefix("watchrss-watch-content:"))
    missing_content = sum("files/article_content/" + name not in members for name in markers)
    font_names = [row[0] for row in native.execute(
        "SELECT fileName FROM reader_font_assets WHERE deleted=0"
    )]
    background_names = [row[0] for row in native.execute(
        "SELECT masterFileName FROM reader_background_assets WHERE deleted=0"
    )]
    return {
        "contentMarkers": len(markers),
        "missingContentFiles": missing_content,
        "activeFontFiles": len(font_names),
        "missingActiveFontFiles": sum("files/reader_assets/fonts/" + name not in members for name in font_names),
        "activeBackgroundMasters": len(background_names),
        "missingActiveBackgroundMasters": sum(
            "files/reader_assets/backgrounds/" + name not in members for name in background_names
        ),
    }


def stage(native_path: Path, target_path: Path, files_tar: Path, output: Path, report: Path) -> None:
    for path in (native_path, target_path, files_tar):
        if not path.is_file():
            raise ValueError(f"Input missing: {path}")
    if output.exists() or report.exists():
        raise ValueError("Refusing to overwrite a stage or report")
    if output.resolve() in (native_path.resolve(), target_path.resolve()):
        raise ValueError("Output must differ from both inputs")
    native = sqlite3.connect(f"{native_path.resolve().as_uri()}?mode=ro", uri=True)
    native.row_factory = sqlite3.Row
    partial = output.with_name(output.name + ".partial")
    if partial.exists():
        raise ValueError("An earlier partial stage exists")
    try:
        if scalar(native, "PRAGMA user_version") != 18:
            raise ValueError("Native database is not Room v18")
        if scalar(native, "PRAGMA quick_check") != "ok":
            raise ValueError("Native snapshot failed quick_check")
        native_tables = {row[0] for row in native.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        if set(SOURCE_TABLES) - native_tables:
            raise ValueError("Native snapshot is missing required v18 tables")
        identity = device_id_from_tar(files_tar)
        assets = asset_inventory(native, files_tar)
        if assets["missingContentFiles"]:
            raise ValueError("A referenced native article content file is missing")
        shutil.copyfile(target_path, partial)
        os.chmod(partial, 0o600)
        dest = sqlite3.connect(partial)
        try:
            dest.execute("PRAGMA foreign_keys=ON")
            if scalar(dest, "PRAGMA quick_check") != "ok":
                raise ValueError("PodJS baseline failed quick_check")
            dest.execute("""CREATE TABLE IF NOT EXISTS offline_media (
                id INTEGER PRIMARY KEY,item_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
                media_type TEXT NOT NULL CHECK(media_type IN ('IMAGE','VIDEO')),
                origin_url TEXT NOT NULL,relative_path TEXT,created_at INTEGER NOT NULL,
                UNIQUE(item_id,origin_url))""")
            dest.execute("""CREATE TABLE IF NOT EXISTS article_native_sync_hash (
                item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
                body_hash TEXT NOT NULL)""")
            for table in CORE_TABLES:
                if scalar(dest, f'SELECT COUNT(*) FROM "{table}"'):
                    raise ValueError(f"PodJS baseline contains {table}; merge policy is required")
            if scalar(dest, "SELECT COUNT(*) FROM sync_local_identity") != 1:
                raise ValueError("PodJS baseline must have one local identity")
            dest.execute("BEGIN IMMEDIATE")
            dest.execute("UPDATE sync_local_identity SET device_id=?,device_order=? WHERE id=1",
                         (identity, device_order(identity)))
            channels = native.execute("SELECT * FROM rss_channels").fetchall()
            dest.executemany("""INSERT INTO channels(id,url,title,description,image_url,last_fetched_at,created_at,sort_order,is_pinned)
                VALUES(?,?,?,?,?,?,?,?,?)""", [
                (r["id"], r["url"], r["title"], r["description"], r["imageUrl"],
                 r["lastFetchedAt"], r["createdAt"], r["sortOrder"], r["isPinned"])
                for r in channels
            ])
            dest.executemany("INSERT INTO source_preferences(channel_id,use_original_content,read_preset) VALUES(?,?,'default')",
                             [(r["id"], r["useOriginalContent"]) for r in channels])
            dest.executemany("INSERT INTO source_media_preferences(channel_id,continue_in_background) VALUES(?,?)",
                             [(r["id"], r["continuePlaybackInBackground"]) for r in channels])
            active_favorites = {row[0] for row in native.execute(
                "SELECT itemId FROM saved_entries WHERE saveType='FAVORITE'"
            )}
            items = native.execute("SELECT * FROM rss_items ORDER BY id").fetchall()
            dest.executemany("""INSERT INTO articles(id,channel_id,title,description,content,link,guid,pub_date,
                image_url,audio_url,video_url,is_read,is_saved,reading_progress,dedup_key,fetched_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", [
                (r["id"], r["channelId"], r["title"], r["description"], r["content"], r["link"],
                 r["guid"], r["pubDate"], r["imageUrl"], r["audioUrl"], r["videoUrl"],
                 r["isRead"], int(r["id"] in active_favorites), r["readingProgress"],
                 r["dedupKey"], r["fetchedAt"])
                for r in items
            ])
            dest.executemany("INSERT INTO article_previews(article_id,summary,image_url) VALUES(?,?,?)", [
                (r["id"], r["summary"], r["previewImageUrl"]) for r in items
                if r["summary"] is not None or r["previewImageUrl"] is not None
            ])
            originals = [r for r in items if r["originalContent"]]
            dest.executemany("INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(?,0,?)",
                             [(r["id"], r["originalContent"]) for r in originals])
            dest.executemany("INSERT INTO article_original_meta(article_id,source_url,fetched_at) VALUES(?,?,?)",
                             [(r["id"], r["link"] or "", r["fetchedAt"]) for r in originals])
            native_hashes = [(r["id"], r["syncBodyHash"]) for r in items if r["syncBodyHash"]]
            dest.executemany("INSERT INTO article_native_sync_hash(item_id,body_hash) VALUES(?,?)", native_hashes)
            dest.executemany("""INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash)
                VALUES(?,?,?,?,?)""", [
                (r["id"], r["readingProgress"], r["readingPositionChangedAt"],
                 r["readingPositionBytes"], r["readingPositionContentHash"])
                for r in items if r["readingProgress"] or r["readingPositionChangedAt"]
            ])
            sync_rows = native.execute("SELECT * FROM saved_sync_states").fetchall()
            valid_item_ids = {r["id"] for r in items}
            orphan_sync_references = sum(
                r["itemId"] is not None and r["itemId"] not in valid_item_ids for r in sync_rows
            )
            def save_type(value: str) -> str:
                return {"FAVORITE": "favorite", "WATCH_LATER": "watchLater"}[value]
            deleted = [r for r in sync_rows if r["saveType"] == "ARTICLE_DELETE"]
            saved = [r for r in sync_rows if r["saveType"] in ("FAVORITE", "WATCH_LATER")]
            if len(saved) + len(deleted) != len(sync_rows):
                raise ValueError("Unrecognized native saved-state type")
            dest.executemany("""INSERT INTO sync_article_deletions(article_id,url,changed_at,source_device_id,source_order)
                VALUES(?,?,?,?,?)""", [
                (r["articleId"], r["url"], r["changedAt"], r["sourceDeviceId"],
                 device_order(r["sourceDeviceId"])) for r in deleted
            ])
            mappings = {}
            for row in saved:
                if row["itemId"] in valid_item_ids:
                    previous = mappings.setdefault(row["articleId"], (row["itemId"], row["url"]))
                    if previous != (row["itemId"], row["url"]):
                        raise ValueError("Conflicting native article mapping")
            dest.executemany("INSERT INTO sync_article_ids(article_id,item_id,url) VALUES(?,?,?)",
                             [(article_id, item_id, url) for article_id, (item_id, url) in mappings.items()])
            dest.executemany("INSERT INTO sync_article_aliases(item_id,article_id) VALUES(?,?)",
                             [(item_id, article_id) for article_id, (item_id, _) in mappings.items()])
            dest.executemany("""INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,
                sort_order,source_device_id,source_order) VALUES(?,?,?,?,?,?,?,?,?)""", [
                (r["articleId"], save_type(r["saveType"]),
                 r["itemId"] if r["itemId"] in valid_item_ids else None, r["url"], r["saved"],
                 r["changedAt"], r["sortOrder"], r["sourceDeviceId"], device_order(r["sourceDeviceId"]))
                for r in saved
            ])
            dest.executemany("""INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order)
                VALUES(?,?,?,?,?)""", [
                (r["itemId"], save_type(r["saveType"]), r["saved"], r["changedAt"], -r["sortOrder"])
                for r in saved if r["itemId"] in valid_item_ids
            ])
            entries = native.execute("SELECT * FROM saved_entries").fetchall()
            dest.executemany("""INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order)
                VALUES(?,?,1,?,?) ON CONFLICT(article_id,save_type) DO UPDATE SET
                saved=1,sort_order=excluded.sort_order""", [
                (r["itemId"], save_type(r["saveType"]), r["createdAt"], -r["sortOrder"])
                for r in entries
            ])
            dest.executemany("INSERT INTO article_saved_entry_times(article_id,save_type,created_at) VALUES(?,?,?)",
                             [(r["itemId"], save_type(r["saveType"]), r["createdAt"]) for r in entries])
            dest.executemany("""INSERT INTO sync_source_states(url,source_device_id,title,description,site_url,
                image_url,created_at,updated_at,sort_order,is_pinned,deleted,deleted_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", [
                (r["url"], r["sourceDeviceId"], r["title"], r["description"], r["siteUrl"],
                 r["imageUrl"], r["createdAt"], r["updatedAt"], r["sortOrder"], r["isPinned"],
                 r["deleted"], r["deletedAt"])
                for r in native.execute("SELECT * FROM rss_source_sync_states")
            ])
            dest.executemany("""INSERT INTO sync_change_log(seq,kind,entity_id,changed_at,origin_device_id,reason,created_at)
                VALUES(?,?,?,?,?,?,?)""", [
                tuple(r) for r in native.execute("SELECT seq,kind,entityId,changedAt,originDeviceId,reason,createdAt FROM sync_change_log")
            ])
            dest.executemany("""INSERT INTO sync_peer_state(peer_device_id,last_local_seq_acked,last_remote_seq_applied,
                last_full_sync_at,last_protocol_version,updated_at) VALUES(?,?,?,?,?,?)""", [
                tuple(r) for r in native.execute("""SELECT peerDeviceId,lastLocalSeqAckedByPeer,lastRemoteSeqApplied,
                    lastFullSyncAt,lastProtocolVersion,updatedAt FROM sync_peer_state""")
            ])
            dest.executemany("""INSERT INTO memo_notes(note_id,folder_id,title,markdown,plain_text,content_hash,
                base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", [
                tuple(r) for r in native.execute("""SELECT noteId,folderId,title,markdown,plainText,contentHash,
                    baseContentHash,baseMarkdown,pinned,createdAt,updatedAt,modifiedBy,deleted,deletedAt FROM watch_notes""")
            ])
            dest.executemany("""INSERT INTO memo_folders(folder_id,name,sort_order,updated_at,modified_by,deleted,deleted_at)
                VALUES(?,?,?,?,?,?,?)""", [
                tuple(r) for r in native.execute("""SELECT folderId,name,sortOrder,updatedAt,modifiedBy,deleted,deletedAt
                    FROM watch_note_folders""")
            ])
            usage_rows = native.execute("SELECT * FROM llm_token_usage").fetchall()
            def usage_json(row: sqlite3.Row) -> str:
                fields = {
                    "prompt_tokens": "promptTokens", "completion_tokens": "completionTokens",
                    "total_tokens": "totalTokens", "reasoning_tokens": "reasoningTokens",
                    "input_tokens": "inputTokens", "output_tokens": "outputTokens",
                    "promptTokenCount": "promptTokenCount",
                    "candidatesTokenCount": "candidatesTokenCount",
                    "totalTokenCount": "totalTokenCount",
                }
                value = {wire: row[column] for wire, column in fields.items()
                         if row[column] is not None}
                if row["cachedPromptTokens"] is not None:
                    value["prompt_tokens_details"] = {"cached_tokens": row["cachedPromptTokens"]}
                return json.dumps(value, separators=(",", ":"))
            dest.executemany("""INSERT INTO llm_token_usage(id,provider,model,request_id,usage_json,created_at)
                VALUES(?,?,?,?,?,?)""", [
                (r["id"], r["provider"], r["model"], r["requestId"], usage_json(r), r["createdAt"])
                for r in usage_rows
            ])
            offline_rows = native.execute("SELECT * FROM offline_media").fetchall()
            def relative_offline(path: str | None) -> str | None:
                if path is None:
                    return None
                if "/files/" not in path:
                    raise ValueError("Native offline media path is outside app files")
                relative = path.split("/files/", 1)[1]
                parts = PurePosixPath(relative).parts
                if parts[:2] != ("offline", "rss") or len(parts) != 4 or ".." in parts:
                    raise ValueError("Unsafe native offline media path")
                return relative
            dest.executemany("""INSERT INTO offline_media(id,item_id,media_type,origin_url,relative_path,created_at)
                VALUES(?,?,?,?,?,?)""", [
                (r["id"], r["itemId"], r["mediaType"], r["originUrl"],
                 relative_offline(r["localPath"]), r["createdAt"]) for r in offline_rows
            ])
            if dest.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise ValueError("Staged database has foreign-key violations")
            expected = {
                "channels": len(channels), "articles": len(items),
                "article_saved_entry_times": len(entries),
                "sync_saved_states": len(saved), "sync_article_deletions": len(deleted),
                "sync_source_states": scalar(native, "SELECT COUNT(*) FROM rss_source_sync_states"),
                "sync_change_log": scalar(native, "SELECT COUNT(*) FROM sync_change_log"),
                "sync_peer_state": scalar(native, "SELECT COUNT(*) FROM sync_peer_state"),
                "memo_notes": scalar(native, "SELECT COUNT(*) FROM watch_notes"),
                "memo_folders": scalar(native, "SELECT COUNT(*) FROM watch_note_folders"),
                "llm_token_usage": len(usage_rows),
                "article_native_sync_hash": len(native_hashes),
                "offline_media": len(offline_rows),
            }
            for table, count in expected.items():
                if scalar(dest, f'SELECT COUNT(*) FROM "{table}"') != count:
                    raise ValueError(f"Staged count differs for {table}")
            dest.commit()
            if scalar(dest, "PRAGMA quick_check") != "ok":
                raise ValueError("Staged database failed quick_check")
        finally:
            dest.close()
        os.replace(partial, output)
        report_data = {
            "sourceVersion": 18, "nativeDbSha256": digest(native_path),
            "podjsBaselineSha256": digest(target_path), "filesTarSha256": digest(files_tar),
            "stageSha256": digest(output), "mappedRows": expected,
            "assets": assets, "orphanNativeSavedItemReferences": orphan_sync_references,
            "activationReady": False,
            "deferred": ["reader presets and asset catalog", "offline media on-device acceptance",
                         "settings and account encrypted stores", "article sync chunk metadata regeneration",
                         "article file transfer into PodJS sandbox", "physical UI and phone sync acceptance"],
        }
        report.write_text(json.dumps(report_data, ensure_ascii=False, indent=2) + "\n")
        os.chmod(report, 0o600)
        print(json.dumps({"stageSha256": report_data["stageSha256"], "mappedRows": expected,
                          "activationReady": False}))
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    finally:
        native.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-db", type=Path, required=True)
    parser.add_argument("--podjs-db", type=Path, required=True)
    parser.add_argument("--files-tar", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    stage(args.native_db, args.podjs_db, args.files_tar, args.out, args.report)
