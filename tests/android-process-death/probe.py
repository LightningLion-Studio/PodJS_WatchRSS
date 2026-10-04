#!/usr/bin/env python3
"""Offline command generator and fail-closed Activity process-death evidence checker.

This program reads only the local files named by the caller and prints JSON. It
does not connect to a device, run commands, create a Bundle, or signal a process.
The debug application's package and Activity component are deliberately fixed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import sys
from pathlib import Path
from typing import Any


PACKAGE = "dev.podjs.tests.startup"
COMPONENT = PACKAGE + "/dev.podjs.androidwatch.MainActivity"
HEX32 = re.compile(r"[0-9a-f]{32}\Z")
ACTIVITY_ID = re.compile(r"[0-9a-f]{1,8}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
MAX_INPUT_BYTES = 32 * 1024 * 1024


class EvidenceError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceError(message)


def integer(value: Any, minimum: int = 0) -> bool:
    return type(value) is int and minimum <= value <= 2**53 - 1


def object_value(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label}: expected a JSON object")
    return value


def unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def parse_json(raw: str, label: str) -> Any:
    try:
        return json.loads(raw, object_pairs_hook=unique_keys,
                          parse_constant=lambda value: (_ for _ in ()).throw(
                              EvidenceError(f"{label}: non-finite JSON number {value}")))
    except (json.JSONDecodeError, UnicodeError) as error:
        raise EvidenceError(f"{label}: invalid JSON: {error}") from error


def read_text(path: str | Path) -> str:
    path = Path(path)
    require(path.is_file(), f"Missing evidence file: {path}")
    require(path.stat().st_size <= MAX_INPUT_BYTES, f"Evidence file too large: {path}")
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeError as error:
        raise EvidenceError(f"Evidence is not UTF-8: {path}") from error


def read_json(path: str | Path) -> dict[str, Any]:
    return object_value(parse_json(read_text(path), str(path)), str(path))


def hex32(value: Any, label: str) -> str:
    require(isinstance(value, str) and HEX32.fullmatch(value) is not None,
            f"{label}: expected 32 lowercase hexadecimal characters")
    return value


def identity(value: dict[str, Any], label: str) -> tuple[str, int, str]:
    require(value.get("version") == 1 and type(value.get("version")) is int,
            f"{label}: unsupported protocol version")
    nonce = hex32(value.get("runNonce"), f"{label}.runNonce")
    require(integer(value.get("pid"), 1), f"{label}: invalid pid")
    instance = hex32(value.get("processInstance"), f"{label}.processInstance")
    if "packageName" in value:
        require(value["packageName"] == PACKAGE, f"{label}: package outside the isolated probe")
    return nonce, value["pid"], instance


def read_events(path: str | Path) -> list[dict[str, Any]]:
    raw = read_text(path)
    require(bool(raw) and raw.endswith("\n"), "Lifecycle journal is empty or has an incomplete final line")
    events: list[dict[str, Any]] = []
    last: dict[str, tuple[int, int, int]] = {}
    run_nonce: str | None = None
    retired: set[str] = set()
    active: str | None = None
    for line_number, line in enumerate(raw.splitlines(), 1):
        require(bool(line.strip()), f"Lifecycle line {line_number}: blank line")
        event = object_value(parse_json(line, f"lifecycle line {line_number}"), "lifecycle event")
        nonce, pid, instance = identity(event, f"lifecycle line {line_number}")
        if run_nonce is None:
            run_nonce = nonce
        require(nonce == run_nonce, "Lifecycle journal contains multiple run nonces")
        require(isinstance(event.get("event"), str) and
                re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,63}", event["event"]) is not None,
                f"Lifecycle line {line_number}: invalid event name")
        for field, minimum in (("eventSeq", 1), ("uptimeMillis", 0), ("wallTimeMillis", 0)):
            require(integer(event.get(field), minimum), f"Lifecycle line {line_number}: invalid {field}")
        if "taskId" in event:
            require(integer(event["taskId"]), f"Lifecycle line {line_number}: invalid taskId")
        if "activityInstance" in event:
            require(isinstance(event["activityInstance"], str) and
                    ACTIVITY_ID.fullmatch(event["activityInstance"]) is not None,
                    f"Lifecycle line {line_number}: invalid activityInstance")
        if "activityClass" in event:
            require(event["activityClass"] == COMPONENT.split("/", 1)[1],
                    f"Lifecycle line {line_number}: unexpected Activity class")
        if instance in last:
            prior_pid, seq, uptime = last[instance]
            require(pid == prior_pid and event["eventSeq"] > seq and event["uptimeMillis"] >= uptime,
                    "Lifecycle process identity, event sequence, or uptime regressed")
        if active != instance:
            require(instance not in retired, "A retired process instance wrote after the new process")
            if active is not None:
                retired.add(active)
            active = instance
        last[instance] = pid, event["eventSeq"], event["uptimeMillis"]
        events.append(event)
    require(bool(events), "Lifecycle journal has no events")
    return events


def latest_identity(events: list[dict[str, Any]]) -> tuple[str, int, str]:
    result = identity(events[-1], "latest lifecycle event")
    require(any(identity(event, "lifecycle event") == result and event["event"] == "postCreate"
                for event in events), "Latest process has no completed Activity creation")
    return result


def command(events: list[dict[str, Any]], operation: str) -> dict[str, Any]:
    nonce, pid, instance = latest_identity(events)
    activity = [event for event in events if event["processInstance"] == instance and
                event["event"] in ("postResume", "postPause", "postStop", "postDestroy")]
    require(bool(activity) and activity[-1]["event"] == "postResume",
            "Latest Activity lifecycle evidence is not resumed")
    return {"version": 1, "runNonce": nonce, "id": secrets.token_hex(16),
            "pid": pid, "processInstance": instance, "op": operation}


def ack(value: dict[str, Any], operation: str) -> dict[str, Any]:
    identity(value, operation + " acknowledgement")
    hex32(value.get("id"), "acknowledgement id")
    require(value.get("op") == operation, f"Expected {operation} acknowledgement")
    require(value.get("status") == "ok", f"{operation} acknowledgement did not succeed")
    return object_value(value.get("value"), operation + " acknowledgement value")


def nodes_from_snapshot(value: dict[str, Any]) -> dict[int, dict[str, Any]]:
    tree = object_value(value.get("tree"), "snapshot tree")
    nodes = tree.get("nodes")
    require(isinstance(nodes, list), "Snapshot tree has no nodes array")
    result: dict[int, dict[str, Any]] = {}
    for raw in nodes:
        node = object_value(raw, "snapshot node")
        require(integer(node.get("id"), 1), "Snapshot has an invalid node id")
        require(node["id"] not in result, "Snapshot has duplicate node ids")
        require(integer(node.get("parentId", 0)), "Snapshot has an invalid parent id")
        require(integer(node.get("actions", 0)) and integer(node.get("state", 0)),
                "Snapshot has an invalid action/state mask")
        result[node["id"]] = node
    return result


def resolve_action(value: dict[str, Any], label: str, action: int) -> int:
    nodes = nodes_from_snapshot(value)
    matches = [node for node in nodes.values() if node.get("label") == label]
    require(len(matches) == 1, f"Label must identify exactly one live node: {label!r} ({len(matches)} matches)")
    target = matches[0]
    seen: set[int] = set()
    while True:
        node_id = target["id"]
        require(node_id not in seen, "Snapshot parent chain contains a cycle")
        seen.add(node_id)
        require(target.get("state", 0) & 1 == 0, "Target or its action ancestor is disabled")
        if target.get("actions", 0) & action:
            return node_id
        parent = target.get("parentId", 0)
        require(parent in nodes, f"No ancestor supports action {action} for {label!r}")
        target = nodes[parent]


def action_command(events: list[dict[str, Any]], snapshot: dict[str, Any],
                   label: str, action: int) -> dict[str, Any]:
    require(action in (1, 2, 4), "Only semantic actions 1, 2, and 4 are supported")
    value = ack(snapshot, "snapshot")
    require(identity(snapshot, "snapshot") == latest_identity(events),
            "Snapshot belongs to an old process or another run")
    token = hex32(value.get("snapshotToken"), "snapshotToken")
    result = command(events, "action")
    result.update(snapshotToken=token, nodeId=resolve_action(value, label, action), action=action)
    return result


def json_channel(value: Any, label: str) -> str:
    require(isinstance(value, str), f"{label}: expected serialized JSON")
    object_value(parse_json(value, label), label)
    try:
        value.encode("utf-8")
    except UnicodeError as error:
        raise EvidenceError(f"{label}: invalid Unicode") from error
    return value


def host_state(value: Any, label: str) -> dict[str, str]:
    value = object_value(value, label)
    return {key: json_channel(value.get(key), label + "." + key)
            for key in ("savedJson", "retainedJson")}


def kv(value: Any, label: str) -> dict[str, Any]:
    value = object_value(value, label)
    require(type(value.get("exists")) is bool, f"{label}: missing exists boolean")
    require(integer(value.get("bytes")), f"{label}: invalid byte count")
    if value["exists"]:
        require(isinstance(value.get("sha256"), str) and SHA256.fullmatch(value["sha256"]) is not None,
                f"{label}: missing SHA-256")
    else:
        require(value.get("sha256") is None and value["bytes"] == 0,
                f"{label}: absent file must have zero bytes and null SHA-256")
    return {key: value.get(key) for key in ("exists", "sha256", "bytes")}


def bundle(value: Any, label: str) -> dict[str, Any]:
    value = object_value(value, label)
    require(type(value.get("present")) is bool and type(value.get("savedKeyPresent")) is bool,
            f"{label}: missing Bundle presence flags")
    if value["savedKeyPresent"]:
        require(value["present"], f"{label}: saved key without a Bundle")
        saved = json_channel(value.get("savedJson"), label + ".savedJson")
        data = saved.encode("utf-8")
        require(type(value.get("savedUtf8Bytes")) is int and value["savedUtf8Bytes"] == len(data),
                f"{label}: Bundle UTF-8 byte count does not match")
        require(value.get("savedSha256") == hashlib.sha256(data).hexdigest(),
                f"{label}: Bundle SHA-256 does not match")
    else:
        require(value.get("savedJson") is None and value.get("savedSha256") is None and
                type(value.get("savedUtf8Bytes")) is int and value["savedUtf8Bytes"] == 0,
                f"{label}: missing saved key has inconsistent metadata")
    return value


def scoped_dump(raw: str) -> dict[str, Any]:
    """Parse one exact Activity block, never borrow state from another Activity."""
    task_id: int | None = None
    matches: list[dict[str, Any]] = []
    active: dict[str, Any] | None = None
    for line in raw.splitlines():
        task = re.match(r"^\s*TASK\s+.+?\s+id=(\d+)(?:\s|$)", line)
        if task:
            task_id = int(task.group(1))
            active = None
            continue
        header = re.match(r"^\s*ACTIVITY\s+(\S+)\s+([0-9a-fA-F]+)\s+(.+?)\s*$", line)
        if header:
            active = None
            if header.group(1) != COMPONENT:
                continue
            require(task_id is not None, "Scoped Activity has no preceding TASK id")
            status = header.group(3)
            pid_match = re.fullmatch(r"pid=(\d+)", status)
            not_running = status in ("(not running)", "pid=(not running)")
            require(pid_match is not None or not_running, "Unsupported scoped Activity process header")
            pid = int(pid_match.group(1)) if pid_match else None
            require(pid is None or pid > 0, "Scoped Activity has an invalid pid")
            active = {"component": COMPONENT, "taskId": task_id,
                      "systemRecord": header.group(2).lower(), "pid": pid,
                      "notRunning": not_running, "lines": []}
            matches.append(active)
        elif re.match(r"^\s*ACTIVITY\s+", line):
            active = None
        elif active is not None:
            active["lines"].append(line)
    require(len(matches) == 1, "Dumpsys must contain exactly one scoped probe Activity header")
    result = matches[0]
    body = "\n".join(result.pop("lines"))
    for field in ("state", "stopped", "finishing", "mHaveState", "mIcicle"):
        values = re.findall(r"(?<![\w])" + re.escape(field) + r"=([^\s]+)", body)
        require(bool(values) and len(set(values)) == 1, f"Scoped Activity lacks unambiguous {field}")
        result[field] = values[0]
    return result


def stopped_dump(value: dict[str, Any]) -> None:
    require(value["state"] == "STOPPED" and value["stopped"] == "true" and
            value["finishing"] == "false", "Activity is not stopped and non-finishing")
    require(value["mHaveState"] == "true" and value["mIcicle"] != "null" and
            value["mIcicle"].startswith("Bundle["), "System Activity record has no saved Bundle")


def activity_events(events: list[dict[str, Any]], expected: tuple[str, int, str]) -> list[dict[str, Any]]:
    return [event for event in events if identity(event, "event") == expected]


def acknowledged_event(events: list[dict[str, Any]], receipt: dict[str, Any]) -> dict[str, Any]:
    ident = identity(receipt, "acknowledgement")
    matches = [event for event in events if identity(event, "event") == ident and
               event["event"] == "commandAcknowledged" and event.get("id") == receipt["id"]]
    require(len(matches) == 1, "Acknowledgement has no unique durable lifecycle journal entry")
    event = matches[0]
    require(event.get("op") == receipt["op"] and event.get("status") == "ok" and
            event.get("taskId") == receipt.get("taskId") and integer(receipt.get("taskId")),
            "Acknowledgement and lifecycle entry differ in operation, status, or task")
    return event


def process_started(events: list[dict[str, Any]]) -> None:
    starts = [event for event in events if event["event"] == "processStarted"]
    require(len(starts) == 1 and events[0] is starts[0],
            "Process journal must start with one processStarted event")
    require(starts[0].get("packageName") == PACKAGE and starts[0].get("controller") == "private-files",
            "Process evidence is not from the configured private-file controller")
    require(not any(event["event"] in ("harnessError", "controlExpired") for event in events),
            "Harness error or expired controller invalidates this process evidence")


def onboarding_draft(state: dict[str, str]) -> dict[str, Any]:
    key = "watchrss.onboarding-draft"
    saved = object_value(parse_json(state["savedJson"], "saved channel").get(key), "saved onboarding draft")
    retained = object_value(parse_json(state["retainedJson"], "retained channel").get(key), "retained onboarding draft")
    require(saved.get("version") == 1 and saved.get("agreed") is True and
            type(saved.get("agreementError")) is bool and type(saved.get("offlineWarning")) is bool,
            "Process-death fixture must include a checked, valid saved agreement draft")
    require(retained.get("version") == 1 and type(retained.get("page")) is int and retained["page"] == 2,
            "Process-death fixture must be on retained customization page 2")
    custom = object_value(saved.get("customization"), "saved customization draft")
    require(integer(custom.get("font"), 12) and custom["font"] <= 32 and custom["font"] % 2 == 0 and
            type(custom.get("volume")) is bool and type(custom.get("guard")) is bool,
            "Saved customization values are invalid")
    limit = custom.get("limit")
    require(limit is None or integer(limit) and limit <= 100 and limit % 5 == 0,
            "Saved customization limit is invalid")
    require(integer(custom.get("scrollOffset"), 1), "A nonzero saved customization scroll position is required")
    require(custom["font"] != 14 or custom["volume"] is not True or custom["guard"] is not False or limit is not None,
            "At least one customization control must differ from its default")
    return custom


def barrier(events: list[dict[str, Any]], background_ack: dict[str, Any],
            before: dict[str, Any], expected_kv: dict[str, Any]) -> dict[str, Any]:
    value = ack(background_ack, "background")
    require(value.get("moved") is True, "Background command did not move the task")
    ident = identity(background_ack, "background acknowledgement")
    selected = activity_events(events, ident)
    require(bool(selected), "Background acknowledgement has no matching lifecycle process")
    process_started(selected)
    background_event = acknowledged_event(events, background_ack)
    stopped_dump(before)
    require(before["pid"] == ident[1] and not before["notRunning"],
            "Before-death dumpsys does not identify the acknowledged live process")
    stops = [event for event in selected if event["event"] == "postStop"]
    saves = [event for event in selected if event["event"] == "postSave"]
    require(bool(stops) and bool(saves), "Both postStop and postSave evidence are required")
    stop, save = stops[-1], saves[-1]
    instance = stop.get("activityInstance")
    require(isinstance(instance, str) and bool(instance), "postStop has no Activity instance identity")
    require(save.get("activityInstance") == instance, "Saved and stopped evidence refers to different Activities")
    require(background_event.get("activityInstance") == instance and
            background_event["eventSeq"] < stop["eventSeq"] < save["eventSeq"],
            "Expected background acknowledgement, then postStop, then postSave for this API 30/target 36 fixture")
    require(stop.get("finishing") is False and stop.get("changingConfigurations") is False and
            save.get("finishing") is False and save.get("changingConfigurations") is False,
            "Barrier is a finish or configuration change rather than a background save")
    require(stop.get("taskId") == save.get("taskId") == before["taskId"],
            "Lifecycle task does not match the stopped system task")
    resumes = [event for event in selected if event["event"] == "postResume" and
               event.get("activityInstance") == instance]
    require(bool(resumes), "Stopped Activity has no prior postResume")
    last_resume = resumes[-1]
    require(last_resume["eventSeq"] < min(stop["eventSeq"], save["eventSeq"]),
            "Activity resumed after the purported save/stop barrier")
    require(not any(event["event"] in ("postDestroy", "preDestroy") and
                    event.get("activityInstance") == instance and
                    event["eventSeq"] > last_resume["eventSeq"] for event in selected),
            "Activity was explicitly destroyed before process-death recovery")
    saved_bundle = bundle(save.get("bundle"), "postSave Bundle")
    require(saved_bundle["present"] and saved_bundle["savedKeyPresent"],
            "postSave did not capture the Activity-state key")
    state = host_state(value.get("hostState"), "background host state")
    require(state["savedJson"] == saved_bundle["savedJson"],
            "Background saved state differs from the stopped Activity Bundle")
    require(kv(value.get("persistentKv"), "background persistent KV") == expected_kv,
            "Persistent KV changed before the process-death barrier")
    return {"identity": ident, "activityInstance": instance, "taskId": before["taskId"],
            "systemRecord": before["systemRecord"], "save": save, "stop": stop,
            "state": state, "order": "stop-then-save" if stop["eventSeq"] < save["eventSeq"] else "save-then-stop"}


def validate(events: list[dict[str, Any]], background_ack: dict[str, Any],
             before_snapshot: dict[str, Any], after_snapshot: dict[str, Any],
             before: dict[str, Any], dead: dict[str, Any], recovered: dict[str, Any],
             expected_kv: dict[str, Any], *, scenario: str = "custom",
             legal_url: str | None = None) -> dict[str, Any]:
    require(scenario in ("custom", "legal"), "Unknown process-death scenario")
    ready = barrier(events, background_ack, before, expected_kv)
    old_identity = ready["identity"]
    before_value = ack(before_snapshot, "snapshot")
    after_value = ack(after_snapshot, "snapshot")
    for value in (before_value, after_value):
        hex32(value.get("snapshotToken"), "snapshotToken")
        nodes_from_snapshot(value)
    require(identity(before_snapshot, "before snapshot") == old_identity,
            "Before snapshot does not belong to the stopped process")
    before_snapshot_event = acknowledged_event(events, before_snapshot)
    background_event = acknowledged_event(events, background_ack)
    require(before_snapshot_event["eventSeq"] < background_event["eventSeq"] and
            before_snapshot_event.get("activityInstance") == ready["activityInstance"],
            "Before snapshot was not captured before the background barrier")
    new_identity = identity(after_snapshot, "after snapshot")
    require(new_identity == latest_identity(events), "After snapshot is not from the latest lifecycle process")
    require(new_identity[0] == old_identity[0] and new_identity[1] != old_identity[1] and
            new_identity[2] != old_identity[2], "Recovery requires a new PID and process instance in the same run")
    require(before_snapshot["id"] != after_snapshot["id"] and
            before_value["snapshotToken"] != after_value["snapshotToken"], "Before/after snapshots were reused")
    for label, value in (("before", before_value), ("after", after_value)):
        require(kv(value.get("persistentKv"), label + " persistent KV") == expected_kv,
                f"Persistent KV changed in the {label} snapshot")
        host_state(value.get("hostState"), label + " host state")
    require(host_state(before_value["hostState"], "before host state") == ready["state"],
            "Before snapshot and background command captured different Activity states")
    if scenario == "custom":
        fixture = onboarding_draft(ready["state"])
        scenario_proof = {"checkedAgreementAndNondefaultCustomizationInSavedBundle": True,
                          "savedCustomization": fixture}
    else:
        import legal_probe
        fixture = legal_probe.checkpoint(ready["state"], legal_url, "scrolled")
        scenario_proof = {"legalCompactMetadataInSavedBundle": True, "savedLegalCheckpoint": fixture,
                          "legalBodyFilesVerified": False, "legalBranchOutcomeVerified": False}
    for stage, dump in (("dead", dead), ("recovered", recovered)):
        require(dump["taskId"] == ready["taskId"] and dump["systemRecord"] == ready["systemRecord"],
                f"{stage}: original system Activity/task record was replaced")
        require(dump["finishing"] == "false", f"{stage}: Activity is finishing")
    require(dead["state"] in ("STOPPED", "DESTROYED") and dead["mHaveState"] == "true" and
            dead["mIcicle"].startswith("Bundle["), "Dead system record lost its saved Bundle")
    require(dead["notRunning"] and dead["pid"] is None, "Dead-stage Activity still has a running process")
    require(recovered["pid"] == new_identity[1] and not recovered["notRunning"] and
            recovered["state"] == "RESUMED" and recovered["stopped"] == "false",
            "Recovered system Activity is not resumed in the new process")
    new_events = activity_events(events, new_identity)
    process_started(new_events)
    after_snapshot_event = acknowledged_event(events, after_snapshot)
    creates = [event for event in new_events if event["event"] == "preCreate"]
    require(len(creates) == 1, "Recovery must contain one unambiguous new-process preCreate")
    incoming = creates[0]
    new_activity = incoming.get("activityInstance")
    # identityHashCode has meaning only within one VM and may repeat after death.
    require(isinstance(new_activity, str) and ACTIVITY_ID.fullmatch(new_activity) is not None,
            "Recovery does not identify its Activity instance")
    require(incoming.get("taskId") == ready["taskId"], "Incoming Activity has a different task")
    require(incoming.get("lastNonConfigurationPresent") is False,
            "New process unexpectedly received non-configuration retained state")
    require(incoming.get("finishing") is False and incoming.get("changingConfigurations") is False,
            "Recovered Activity reports finishing or a configuration change")
    restored_bundle = bundle(incoming.get("bundle"), "incoming system Bundle")
    prior_bundle = bundle(ready["save"]["bundle"], "prior saved Bundle")
    require(restored_bundle == prior_bundle, "Actual incoming Bundle differs from prior postSave evidence")
    require(incoming["uptimeMillis"] >= max(ready["stop"]["uptimeMillis"], ready["save"]["uptimeMillis"]),
            "Recovered process predates the save/stop barrier")
    posts = [event for event in new_events if event["event"] == "postCreate" and
             event.get("activityInstance") == new_activity]
    require(len(posts) == 1, "Missing or ambiguous recovered postCreate")
    post = posts[0]
    require(post.get("taskId") == ready["taskId"] and post["eventSeq"] > incoming["eventSeq"],
            "Recovered postCreate ordering/task is inconsistent")
    require(post.get("hostBooted") is False, "Restoration must be inspected before guest boot")
    restored_state = host_state(post.get("hostState"), "pre-boot recovered host state")
    require(restored_state["savedJson"] == prior_bundle["savedJson"], "Saved host state was not restored from the incoming Bundle")
    require(parse_json(restored_state["retainedJson"], "new retained state") == {},
            "Retained host state survived true process replacement")
    resumes = [event for event in new_events if event["event"] == "postResume" and event.get("activityInstance") == new_activity and
                event.get("taskId") == ready["taskId"] and event["eventSeq"] > post["eventSeq"]
               and event["eventSeq"] < after_snapshot_event["eventSeq"]]
    require(bool(resumes) and after_snapshot_event.get("activityInstance") == new_activity,
            "Recovered snapshot was not acknowledged after the new Activity resumed")
    return {"version": 1, "status": "validated", "packageName": PACKAGE,
            "runNonce": old_identity[0], "oldPid": old_identity[1], "newPid": new_identity[1],
            "taskId": ready["taskId"], "systemRecord": ready["systemRecord"],
            "saveStopOrder": ready["order"], "actualProcessReplacementVerified": True,
            "sameSystemTaskAndActivityRecordVerified": True, "actualIncomingBundleVerified": True,
            "savedRestoredBeforeGuestBoot": True, "retainedAbsentBeforeGuestBoot": True,
            "scenario": scenario, **scenario_proof,
            "persistentKvUnchanged": True, "uiParityVerified": False,
            "scope": "Offline validation of supplied process-death lifecycle and scoped system evidence; no device actions performed."}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("config", help="Print a fresh isolated probe configuration")
    cmd = sub.add_parser("command", help="Print a command bound to the latest journal process")
    cmd.add_argument("--events", required=True)
    cmd.add_argument("--op", choices=("snapshot", "background"), required=True)
    action = sub.add_parser("action", help="Resolve one label/ancestor in a current snapshot")
    action.add_argument("--events", required=True)
    action.add_argument("--snapshot", required=True)
    action.add_argument("--label", required=True)
    action.add_argument("--action", type=int, choices=(1, 2, 4), required=True)
    for mode in ("barrier", "validate"):
        audit = sub.add_parser(mode, help="Validate local evidence without issuing device commands")
        audit.add_argument("--events", required=True)
        audit.add_argument("--background-ack", required=True)
        audit.add_argument("--before-dump", required=True)
        audit.add_argument("--expected-kv", required=True, help="Local JSON containing {exists,sha256,bytes}")
        if mode == "validate":
            audit.add_argument("--scenario", choices=("custom", "legal"), default="custom")
            audit.add_argument("--legal-base-url", help="Legal scenario's immutable loopback base URL")
            for flag in ("before-snapshot", "after-snapshot", "dead-dump", "recovered-dump"):
                audit.add_argument("--" + flag, required=True)
    args = parser.parse_args(argv)
    try:
        if args.mode == "config":
            result = {"version": 1, "packageName": PACKAGE, "runNonce": secrets.token_hex(16)}
        else:
            events = read_events(args.events)
            if args.mode == "command":
                result = command(events, args.op)
            elif args.mode == "action":
                result = action_command(events, read_json(args.snapshot), args.label, args.action)
            else:
                expected_kv = kv(read_json(args.expected_kv), "expected KV baseline")
                background_ack = read_json(args.background_ack)
                before = scoped_dump(read_text(args.before_dump))
                if args.mode == "barrier":
                    ready = barrier(events, background_ack, before, expected_kv)
                    require(ready["identity"] == latest_identity(events), "Barrier is not for the latest process")
                    result = {"version": 1, "status": "barrier-validated", "packageName": PACKAGE,
                              "runNonce": ready["identity"][0], "pid": ready["identity"][1],
                              "processInstance": ready["identity"][2], "taskId": ready["taskId"],
                              "systemRecord": ready["systemRecord"], "saveStopOrder": ready["order"],
                              "processDeathVerified": False}
                else:
                    result = validate(events, background_ack, read_json(args.before_snapshot),
                                      read_json(args.after_snapshot), before,
                                      scoped_dump(read_text(args.dead_dump)),
                                      scoped_dump(read_text(args.recovered_dump)), expected_kv,
                                      scenario=args.scenario,
                                      legal_url=(args.legal_base_url + "/functions/v1/legal/watch/privacy-policy")
                                      if args.legal_base_url is not None else None)
                paths = {key: value for key, value in vars(args).items()
                         if key not in ("mode", "scenario", "legal_base_url") and isinstance(value, str)}
                result["evidence"] = {key: {"path": str(Path(value).resolve()),
                                             "sha256": hashlib.sha256(Path(value).read_bytes()).hexdigest()}
                                      for key, value in paths.items()}
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except (EvidenceError, OSError, UnicodeError) as error:
        print(json.dumps({"status": "rejected", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
