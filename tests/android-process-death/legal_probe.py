"""Pure offline checks for the single-page legal-v2 process-death fixture.

These checks complement ``probe``: they do not prove process replacement, HTTP
request counts, unchanged KV, pixel parity, or exact guest lifecycle events.
There is no device, filesystem, clock, or network access in this module.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from typing import Any

import probe

EvidenceError = probe.EvidenceError
require = probe.require
KEY = "watchrss.startup-legal-stack"
MAX_BODY_BYTES = 512 * 1024
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,96}\Z")
URL = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/functions/v1/legal/watch/privacy-policy\Z")
STATE_KEYS = {"error", "isLoading", "reloadKey", "listAnchor", "scrollOffset"}
ENTRY_KEYS = {"page", "identity", "state", "bodyReference"}
REF_KEYS = {"version", "owner", "identity", "identitySha256", "path", "byteLength", "sha256"}


def _object(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    result = probe.object_value(value, label)
    require(set(result) == keys, f"{label}: unexpected or missing fields")
    return result


def _text(value: Any, label: str) -> str:
    require(isinstance(value, str), f"{label}: expected text")
    try:
        value.encode("utf-8")
    except UnicodeError as error:
        raise EvidenceError(f"{label}: invalid Unicode") from error
    return value


def _url(value: Any) -> str:
    value = _text(value, "expected legal URL")
    match = URL.fullmatch(value)
    require(match is not None and int(match[1]) <= 65535,
            "Expected URL must be the canonical loopback privacy fixture URL")
    return value


def _token(value: Any, label: str) -> str:
    require(isinstance(value, str) and TOKEN.fullmatch(value) is not None,
            f"{label}: invalid owner/allocation token")
    return value


def _identity(value: Any, expected_url: str) -> dict[str, str]:
    value = _object(value, {"page", "url"}, "legal document identity")
    require(value["page"] == "privacy" and value["url"] == expected_url,
            "Legal document identity differs from the exact fixture URL")
    return dict(value)


def _reference(value: Any, expected_url: str, owner: str | None = None) -> dict[str, Any]:
    expected_url = _url(expected_url)
    value = _object(value, REF_KEYS, "legal body reference")
    require(type(value["version"]) is int and value["version"] == 1,
            "Legal body reference must use schema v1")
    actual_owner = _token(value["owner"], "body owner")
    require(owner is None or actual_owner == owner, "Body owner differs from stack owner")
    _identity(value["identity"], expected_url)
    for field in ("identitySha256", "sha256"):
        require(isinstance(value[field], str) and probe.SHA256.fullmatch(value[field]) is not None,
                f"Body reference has invalid {field}")
    identity_bytes = json.dumps(["privacy", expected_url], ensure_ascii=False,
                                separators=(",", ":")).encode("utf-8")
    require(hashlib.sha256(identity_bytes).hexdigest() == value["identitySha256"],
            "Body identity SHA-256 does not bind the exact page and URL")
    require(probe.integer(value["byteLength"], 1) and value["byteLength"] <= MAX_BODY_BYTES,
            "Legal body byte length is outside 1..512 KiB")
    prefix = f"legal-recovery/v1/{actual_owner}/{value['identitySha256']}-{value['sha256']}-"
    path = _text(value["path"], "body path")
    require(path.startswith(prefix) and path.endswith(".utf8"), "Body path does not match its owner/digests")
    _token(path[len(prefix):-5], "body allocation")
    return copy.deepcopy(value)


def _number(value: Any) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _state(value: Any, phase: str) -> dict[str, Any]:
    require(phase in ("top", "scrolled", "held", "loaded"), "Unknown legal checkpoint phase")
    value = _object(value, STATE_KEYS, "compact legal state")
    require(value["error"] is None, "Legal checkpoint contains an error")
    require(type(value["isLoading"]) is bool, "isLoading must be boolean")
    require(probe.integer(value["reloadKey"]), "Invalid legal reload key")
    require(_number(value["scrollOffset"]) and value["scrollOffset"] >= 0,
            "Invalid legal compatibility scroll offset")
    anchor = value["listAnchor"]
    if anchor is not None:
        anchor = _object(anchor, {"index", "offsetPx"}, "legal list anchor")
        require(all(probe.integer(anchor[field]) for field in ("index", "offsetPx")),
                "Anchor values must be nonnegative safe integers")
    if phase == "held":
        require(value["isLoading"] and anchor is None and value["scrollOffset"] == 0,
                "Held checkpoint must be loading with a discarded anchor and zero offset")
    else:
        require(not value["isLoading"] and anchor is not None,
                "Loaded checkpoint must have a canonical anchor and no loading state")
        if phase == "top":
            require(anchor == {"index": 0, "offsetPx": 0} and value["scrollOffset"] == 0,
                    "Top checkpoint must be at the canonical zero anchor/offset")
        elif phase == "scrolled":
            require(anchor["index"] > 0 or anchor["offsetPx"] > 0,
                    "Scrolled checkpoint must have a nonzero anchor")
    return copy.deepcopy(value)


def _entry(value: Any, owner: str, expected_url: str, phase: str) -> dict[str, Any]:
    value = _object(value, ENTRY_KEYS, "compact legal entry")
    require(value["page"] == "privacy", "Only the single privacy fixture is supported")
    _identity(value["identity"], expected_url)
    _state(value["state"], phase)
    # Non-null even while held: otherwise missing-file hydration fallback could
    # be mistaken for the successful-document loading/unmount branch.
    _reference(value["bodyReference"], expected_url, owner)
    return copy.deepcopy(value)


def checkpoint(host_state: dict[str, str], expected_url: str,
               phase: str = "loaded") -> dict[str, Any]:
    """Validate one compact saved v2 checkpoint and any matching retained copy."""
    expected_url = _url(expected_url)
    channels = probe.host_state(host_state, "legal host state")
    require(len(channels["savedJson"].encode("utf-8")) <= 64 * 1024,
            "Saved channel exceeds the SDK's compact 64 KiB limit")
    require(len(channels["retainedJson"].encode("utf-8")) <= 896 * 1024,
            "Retained channel exceeds the SDK's 896 KiB limit")
    saved = probe.parse_json(channels["savedJson"], "legal saved channel")
    retained = probe.parse_json(channels["retainedJson"], "legal retained channel")
    stack = _object(saved.get(KEY), {"version", "owner", "pages", "snapshots"}, "saved legal stack")
    require(type(stack["version"]) is int and stack["version"] == 2, "Saved legal stack must use v2")
    owner = _token(stack["owner"], "stack owner")
    require(stack["pages"] == ["privacy"], "Expected exactly one privacy page")
    snapshots = stack["snapshots"]
    require(isinstance(snapshots, list) and len(snapshots) == 1, "Expected exactly one saved legal entry")
    entry = _entry(snapshots[0], owner, expected_url, phase)
    if KEY in retained:
        retained_stack = _object(retained[KEY], {"version", "owner", "snapshots"}, "retained legal stack")
        require(type(retained_stack["version"]) is int and retained_stack["version"] == 2,
                "Retained legal stack must use v2")
        require(retained_stack["owner"] == owner, "Retained legal owner differs")
        copies = retained_stack["snapshots"]
        require(isinstance(copies, list) and len(copies) == 1, "Expected exactly one retained legal entry")
        _entry(copies[0], owner, expected_url, phase)
        require(copies[0] == entry, "Retained legal metadata differs from the saved checkpoint")
    return {"owner": owner, "entry": entry, "reference": copy.deepcopy(entry["bodyReference"]),
            "state": copy.deepcopy(entry["state"]), "expectedUrl": expected_url}


def body(reference: dict[str, Any], raw: bytes, expected_url: str,
         expected_body: bytes) -> dict[str, Any]:
    """Verify caller-supplied bytes; this function never opens the device path."""
    reference = _reference(reference, expected_url)
    require(type(raw) is bytes and type(expected_body) is bytes, "Legal bodies must be raw bytes")
    require(len(raw) == reference["byteLength"], "Recovery body size differs from its reference")
    try:
        content = raw.decode("utf-8", errors="strict")
    except UnicodeError as error:
        raise EvidenceError("Recovery body is not valid UTF-8") from error
    require(bool(content.strip()), "Recovery body is empty/whitespace")
    digest = hashlib.sha256(raw).hexdigest()
    require(digest == reference["sha256"], "Recovery body SHA-256 differs from its reference")
    require(raw == expected_body, "Recovery body differs from the complete fixture response")
    return {"path": reference["path"], "devicePath": "files/podjs/files/" + reference["path"],
            "bytes": len(raw), "sha256": digest}


def _bounds(value: Any) -> dict[str, int | float]:
    value = _object(value, {"left", "top", "right", "bottom"}, "semantic bounds")
    require(all(_number(number) for number in value.values()), "Semantic bounds must be finite numbers")
    require(value["left"] <= value["right"] and value["top"] <= value["bottom"], "Semantic bounds are inverted")
    return dict(value)


def _overlaps(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return max(a["left"], b["left"]) < min(a["right"], b["right"]) and max(a["top"], b["top"]) < min(a["bottom"], b["bottom"])


def geometry(snapshot_ack: dict[str, Any], marker: str | None = None) -> list[dict[str, Any]]:
    """Extract visible legal-list semantics, omitting ephemeral node identities.

    Use the first body paragraph as ``marker`` for top/after snapshots. Omit it
    for the scrolled snapshot where the first paragraph is intentionally absent.
    """
    value = probe.ack(snapshot_ack, "snapshot")
    require(probe.integer(snapshot_ack.get("taskId")), "Snapshot has an invalid task id")
    probe.hex32(value.get("snapshotToken"), "snapshotToken")
    tree = probe.object_value(value.get("tree"), "semantic tree")
    require(type(tree.get("schema")) is int and tree["schema"] == 1, "Unsupported semantic tree schema")
    nodes = probe.nodes_from_snapshot(value)
    roots = [node for node in nodes.values() if node.get("label") == "协议正文"]
    require(len(roots) == 1 and roots[0].get("role") == "list", "Expected one legal document list")
    root = roots[0]
    root_bounds = _bounds(root.get("bounds"))
    require(_overlaps(root_bounds, root_bounds), "Legal list has empty bounds")
    result: list[dict[str, Any]] = []
    for node in nodes.values():
        bounds = _bounds(node.get("bounds"))
        current, ancestors, belongs = node, set(), False
        while True:
            node_id = current["id"]
            require(node_id not in ancestors, "Semantic parent chain contains a cycle")
            ancestors.add(node_id)
            belongs = belongs or node_id == root["id"]
            parent = current.get("parentId", 0)
            if parent == 0:
                break
            require(parent in nodes, "Semantic parent chain has a missing node")
            current = nodes[parent]
        if not belongs or not _overlaps(bounds, root_bounds):
            continue
        label, role = node.get("label"), node.get("role")
        if label is None:
            continue
        _text(label, "semantic label")
        require(isinstance(role, str) and bool(role), "Semantic node has no role")
        require(probe.integer(node.get("state")), "Semantic node has an invalid state")
        result.append({"label": label, "role": role, "state": node["state"], "bounds": bounds})
    # Export order is meaningful. Require the root first rather than sorting away
    # an unexpected hierarchy/order change between snapshots.
    require(bool(result) and result[0]["label"] == "协议正文", "Legal semantic order has no leading list")
    text_nodes = [node for node in result[1:] if node["role"] == "text" and node["label"]]
    require(bool(text_nodes), "Legal list contains no visible text")
    if marker is not None:
        marker = _text(marker, "body marker")
        require(bool(marker.strip()) and any(marker in node["label"] for node in text_nodes),
                "Expected body marker is absent from the visible legal document")
    return result


def _geometry(value: Any) -> list[dict[str, Any]]:
    require(isinstance(value, list) and len(value) >= 2, "Legal geometry needs a list and visible text")
    for node in value:
        _object(node, {"label", "role", "state", "bounds"}, "legal geometry node")
        _text(node["label"], "semantic label")
        require(isinstance(node["role"], str) and bool(node["role"]), "Invalid semantic role")
        require(probe.integer(node["state"]), "Invalid semantic state")
        bounds = _bounds(node["bounds"])
        require(_overlaps(bounds, bounds), "Legal geometry contains an empty node")
    require(value[0]["label"] == "协议正文" and value[0]["role"] == "list", "Legal geometry has no leading list")
    require(any(node["role"] == "text" and node["label"] for node in value[1:]), "Legal geometry has no visible text")
    return value


def compare_geometry(before: list[dict[str, Any]], after: list[dict[str, Any]],
                     tolerance: int | float = 1) -> bool:
    require(_number(tolerance) and tolerance >= 0, "Geometry tolerance must be finite and nonnegative")
    before, after = _geometry(before), _geometry(after)
    if len(before) != len(after):
        return False
    return all(all(a[key] == b[key] for key in ("label", "role", "state")) and
               all(abs(a["bounds"][key] - b["bounds"][key]) <= tolerance for key in a["bounds"])
               for a, b in zip(before, after))


def _checkpoint(value: Any, phase: str) -> dict[str, Any]:
    value = _object(value, {"owner", "entry", "reference", "state", "expectedUrl"}, "validated legal checkpoint")
    owner, url = _token(value["owner"], "stack owner"), _url(value["expectedUrl"])
    entry = _entry(value["entry"], owner, url, phase)
    _state(value["state"], phase)
    _reference(value["reference"], url, owner)
    require(value["reference"] == entry["bodyReference"] and value["state"] == entry["state"],
            "Checkpoint aliases differ from their entry")
    return value


def _same_reference(before: dict[str, Any], after: dict[str, Any]) -> None:
    for field in ("owner", "expectedUrl", "reference"):
        require(before[field] == after[field], f"Legal {field} changed across checkpoints")
    require(before["state"]["reloadKey"] == after["state"]["reloadKey"], "Unexpected legal retry generation")


def validate_held(before_checkpoint: dict[str, Any], held_checkpoint: dict[str, Any]) -> None:
    before = _checkpoint(before_checkpoint, "scrolled")
    held = _checkpoint(held_checkpoint, "held")
    _same_reference(before, held)


def validate_restored(top_checkpoint: dict[str, Any], scrolled_checkpoint: dict[str, Any],
                      held_checkpoint: dict[str, Any], after_checkpoint: dict[str, Any],
                      top_geometry: list[dict[str, Any]], scrolled_geometry: list[dict[str, Any]],
                      after_geometry: list[dict[str, Any]]) -> dict[str, Any]:
    top, scrolled = _checkpoint(top_checkpoint, "top"), _checkpoint(scrolled_checkpoint, "scrolled")
    held, after = _checkpoint(held_checkpoint, "held"), _checkpoint(after_checkpoint, "top")
    for candidate in (scrolled, held, after):
        _same_reference(top, candidate)
    validate_held(scrolled, held)
    require(not compare_geometry(top_geometry, scrolled_geometry), "Scrolled geometry did not differ from the top")
    require(compare_geometry(top_geometry, after_geometry), "Restored legal geometry does not match the initial top")
    return {"scenario": "legal-v2-held", "legalSchemaVersion": 2,
            "compactMetadataVerified": True, "scrolledAnchorWasNonzero": True,
            "bodyReferencePreservedThroughHeldLoading": True,
            "bodyReferenceUnchangedAcrossCheckpoints": True,
            "restoredAnchorDiscardedDuringHeldLoading": True,
            "canonicalAnchorResetToTop": True, "semanticTopGeometryVerified": True,
            "owner": top["owner"], "bodyReference": copy.deepcopy(top["reference"]),
            "oldAnchor": copy.deepcopy(scrolled["state"]["listAnchor"]),
            "afterAnchor": copy.deepcopy(after["state"]["listAnchor"]),
            "eventTimingVerified": False, "exactEventCountsVerified": False,
            "pixelParityVerified": False, "uiParityVerified": False,
            "scope": "Compact legal metadata and semantic reset outcome only; the caller must separately verify process replacement, file bytes, held HTTP response ordering and unchanged KV."}
