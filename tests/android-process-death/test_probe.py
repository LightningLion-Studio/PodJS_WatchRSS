"""Synthetic offline parser tests; these fixtures are not device evidence."""

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("process_death_probe", ROOT / "probe.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)

NONCE = "a" * 32
OLD = "b" * 32
NEW = "c" * 32
STATE = {
    "savedJson": json.dumps({"watchrss.onboarding-draft": {"version": 1, "agreed": True,
        "agreementError": False, "offlineWarning": False, "customization": {
            "font": 16, "volume": True, "guard": False, "limit": 0, "scrollOffset": 120}}},
        separators=(",", ":")),
    "retainedJson": '{"watchrss.onboarding-draft":{"version":1,"page":2,"internet":"available"}}',
}
BASELINE = {"exists": True, "bytes": 2, "sha256": hashlib.sha256(b"{}").hexdigest()}


def saved_bundle(saved=None):
    if saved is None:
        return {"present": False, "savedKeyPresent": False, "savedJson": None,
                "savedUtf8Bytes": 0, "savedSha256": None}
    return {"present": True, "savedKeyPresent": True, "savedJson": saved,
            "savedUtf8Bytes": len(saved.encode()), "savedSha256": hashlib.sha256(saved.encode()).hexdigest()}


def event(name, seq, new=False, **values):
    result = {"version": 1, "runNonce": NONCE, "pid": 201 if new else 101,
              "processInstance": NEW if new else OLD, "event": name, "eventSeq": seq,
              "uptimeMillis": (2000 if new else 1000) + seq, "wallTimeMillis": 5000 + seq}
    if name == "processStarted":
        result.update(packageName=probe.PACKAGE, controller="private-files")
    else:
        # Same identityHashCode across VMs must be accepted.
        result.update(taskId=17, activityInstance="f001", activityClass="dev.podjs.androidwatch.MainActivity")
    if name in ("preCreate", "postStop", "postSave", "postResume", "postPause"):
        result.update(finishing=False, changingConfigurations=False)
    result.update(values)
    return result


def receipt(operation, command_id, new=False):
    value = {"hostState": copy.deepcopy(STATE), "persistentKv": dict(BASELINE)}
    if operation == "background":
        value["moved"] = True
    else:
        value.update(snapshotToken=("e" if new else "d") * 32,
                     tree={"nodes": [{"id": 1, "parentId": 0, "label": "Parent", "actions": 1, "state": 0},
                                     {"id": 2, "parentId": 1, "label": "下一页", "actions": 0, "state": 0}]})
    if new:
        value["hostState"]["retainedJson"] = '{"watchrss.onboarding-draft":{"version":1,"page":0,"internet":"checking"}}'
    return {"version": 1, "runNonce": NONCE, "pid": 201 if new else 101,
            "processInstance": NEW if new else OLD, "id": command_id, "op": operation,
            "status": "ok", "taskId": 17, "value": value}


def dump(stage="before", record="abcd", task=17, component=probe.COMPONENT):
    pid = {"before": "pid=101", "dead": "(not running)", "after": "pid=201"}[stage]
    state = {"before": "STOPPED", "dead": "DESTROYED", "after": "RESUMED"}[stage]
    return (f"TASK {probe.PACKAGE} id={task} userId=0\n"
            f"  ACTIVITY {component} {record} {pid}\n"
            f"    state={state} stopped={'false' if stage == 'after' else 'true'} finishing=false\n"
            "    mHaveState=true mIcicle=Bundle[mParcelledData.dataSize=4096]\n")


def fixture():
    before = receipt("snapshot", "1" * 32)
    background = receipt("background", "2" * 32)
    after = receipt("snapshot", "3" * 32, new=True)
    events = [event("processStarted", 1), event("preCreate", 2, bundle=saved_bundle(), lastNonConfigurationPresent=False),
              event("postCreate", 3, hostState={"savedJson": "{}", "retainedJson": "{}"}, hostBooted=False),
              event("postResume", 4),
              event("commandAcknowledged", 5, id=before["id"], op="snapshot", status="ok"),
              event("commandAcknowledged", 6, id=background["id"], op="background", status="ok"),
              event("postPause", 7), event("postStop", 8),
              event("postSave", 9, bundle=saved_bundle(STATE["savedJson"])),
              event("processStarted", 1, True),
              event("preCreate", 2, True, bundle=saved_bundle(STATE["savedJson"]), lastNonConfigurationPresent=False),
              event("postCreate", 3, True, hostState={"savedJson": STATE["savedJson"], "retainedJson": "{}"}, hostBooted=False),
              event("postResume", 4, True),
              event("commandAcknowledged", 5, True, id=after["id"], op="snapshot", status="ok")]
    return {"events": events, "background_ack": background, "before_snapshot": before,
            "after_snapshot": after, "before": probe.scoped_dump(dump()),
            "dead": probe.scoped_dump(dump("dead")), "recovered": probe.scoped_dump(dump("after")),
            "expected_kv": dict(BASELINE)}


class OfflineProbeTest(unittest.TestCase):
    def test_complete_boundary_evidence_and_hashcode_reuse(self):
        result = probe.validate(**fixture())
        self.assertTrue(result["savedRestoredBeforeGuestBoot"])
        self.assertEqual(result["saveStopOrder"], "stop-then-save")
        self.assertFalse(result["uiParityVerified"])
        self.assertEqual(result["savedCustomization"]["font"], 16)

    def test_supported_dead_states_and_explicit_absence(self):
        value = fixture()
        value["dead"]["state"] = "STOPPED"
        probe.validate(**value)
        value["dead"]["notRunning"] = False
        value["dead"]["pid"] = 101
        with self.assertRaises(probe.EvidenceError):
            probe.validate(**value)

    def test_required_proof_cannot_be_dropped_or_changed(self):
        mutations = {
            "same pid": lambda v: v["after_snapshot"].update(pid=101),
            "same process": lambda v: v["after_snapshot"].update(processInstance=OLD),
            "other task": lambda v: v["dead"].update(taskId=18),
            "new record": lambda v: v["recovered"].update(systemRecord="ffff"),
            "no system bundle": lambda v: v["before"].update(mIcicle="null"),
            "not stopped": lambda v: v["before"].update(state="RESUMED"),
            "finishing": lambda v: v["before"].update(finishing="true"),
            "kv changed": lambda v: v["after_snapshot"]["value"]["persistentKv"].update(bytes=3),
            "bundle differs": lambda v: v["events"][10]["bundle"].update(savedJson="{}"),
            "nonconfig": lambda v: v["events"][10].update(lastNonConfigurationPresent=True),
            "guest already booted": lambda v: v["events"][11].update(hostBooted=True),
            "retained survived": lambda v: v["events"][11]["hostState"].update(retainedJson=STATE["retainedJson"]),
            "missing save": lambda v: v["events"].pop(8),
            "missing background ack event": lambda v: v["events"].pop(5),
            "missing snapshot ack event": lambda v: v["events"].pop(),
            "wrong API save order": lambda v: v["events"][7].update(eventSeq=10),
            "configuration recreation": lambda v: v["events"][7].update(changingConfigurations=True),
            "harness failed": lambda v: v["events"].insert(8, event("harnessError", 8)),
            "expired control": lambda v: v["events"].insert(8, event("controlExpired", 8)),
            "missing process start": lambda v: v["events"].pop(0),
        }
        for label, change in mutations.items():
            with self.subTest(label=label):
                value = fixture()
                change(value)
                with self.assertRaises(probe.EvidenceError):
                    probe.validate(**value)

    def test_customization_fixture_must_be_meaningful(self):
        for mutation in (lambda s: s.update(agreed=False),
                         lambda s: s["customization"].update(scrollOffset=0),
                         lambda s: s["customization"].update(font=14, limit=None)):
            state = copy.deepcopy(STATE)
            saved = json.loads(state["savedJson"])
            mutation(saved["watchrss.onboarding-draft"])
            state["savedJson"] = json.dumps(saved)
            with self.assertRaises(probe.EvidenceError):
                probe.onboarding_draft(state)

    def test_command_and_action_bind_to_latest_resumed_process(self):
        value = fixture()
        result = probe.action_command(value["events"], value["after_snapshot"], "下一页", 1)
        self.assertEqual(result["nodeId"], 1)
        self.assertEqual(result["pid"], 201)
        self.assertEqual(result["snapshotToken"], "e" * 32)
        self.assertNotEqual(result["id"], probe.command(value["events"], "snapshot")["id"])
        with self.assertRaises(probe.EvidenceError):
            probe.action_command(value["events"], value["before_snapshot"], "下一页", 1)
        value["events"].append(event("postPause", 6, True))
        with self.assertRaises(probe.EvidenceError):
            probe.command(value["events"], "background")

    def test_duplicate_label_ids_cycles_disabled_and_missing_parent_rejected(self):
        for mutation in (
            lambda n: n.append({**n[1], "id": 3}),
            lambda n: n.append(dict(n[0])),
            lambda n: n[1].update(parentId=2),
            lambda n: n[1].update(parentId=999),
            lambda n: n[0].update(state=1),
        ):
            value = receipt("snapshot", "1" * 32)["value"]
            mutation(value["tree"]["nodes"])
            with self.assertRaises(probe.EvidenceError):
                probe.resolve_action(value, "下一页", 1)

    def test_dumpsys_scoping_rejects_borrowed_flags_and_ambiguous_records(self):
        other = dump(component="other.package/.Main")
        target = dump().replace("mHaveState=true mIcicle=Bundle[mParcelledData.dataSize=4096]", "")
        for text in (other, target + other, dump() + dump(), dump().replace("TASK ", "NOTTASK ")):
            with self.assertRaises(probe.EvidenceError):
                probe.scoped_dump(text)
        parsed = probe.scoped_dump(other + dump())
        self.assertEqual(parsed["component"], probe.COMPONENT)

    def test_lifecycle_input_rejects_partial_mixed_or_regressed_journals(self):
        events = fixture()["events"]
        valid = "".join(json.dumps(event) + "\n" for event in events)
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = pathlib.Path(directory) / "events.jsonl"
            path.write_text(valid)
            self.assertEqual(len(probe.read_events(path)), len(events))
            variants = [valid.rstrip("\n"), valid + "\n", valid.replace('"runNonce": "' + NONCE, '"runNonce": "' + "f" * 32, 1),
                        valid + json.dumps(event("postResume", 10)) + "\n"]
            malformed = copy.deepcopy(events)
            malformed[2]["eventSeq"] = 1
            variants.append("".join(json.dumps(event) + "\n" for event in malformed))
            for text in variants:
                path.write_text(text)
                with self.assertRaises(probe.EvidenceError):
                    probe.read_events(path)

    def test_strict_json_and_kv_metadata(self):
        for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}'):
            with self.assertRaises(probe.EvidenceError):
                probe.parse_json(raw, "fixture")
        with self.assertRaises(probe.EvidenceError):
            probe.kv({"exists": False, "bytes": 1, "sha256": None}, "fixture")
        self.assertEqual(probe.kv({"exists": False, "bytes": 0, "sha256": None}, "fixture")["bytes"], 0)

    def test_cli_validate_and_config_are_offline_json(self):
        value = fixture()
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            directory = pathlib.Path(directory)
            files = {"events": "".join(json.dumps(event) + "\n" for event in value["events"]),
                     "background-ack": json.dumps(value["background_ack"]),
                     "before-snapshot": json.dumps(value["before_snapshot"]),
                     "after-snapshot": json.dumps(value["after_snapshot"]),
                     "expected-kv": json.dumps(BASELINE), "before-dump": dump(),
                     "dead-dump": dump("dead"), "recovered-dump": dump("after")}
            argv = ["validate"]
            for name, content in files.items():
                path = directory / name
                path.write_text(content)
                argv += ["--" + name, str(path)]
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(probe.main(argv), 0)
            result = json.loads(output.getvalue())
            self.assertEqual(len(result["evidence"]), 8)
            self.assertTrue(result["actualIncomingBundleVerified"])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(probe.main(["config"]), 0)
        config = json.loads(output.getvalue())
        self.assertEqual(config["packageName"], probe.PACKAGE)
        self.assertRegex(config["runNonce"], r"^[0-9a-f]{32}$")


if __name__ == "__main__":
    unittest.main()
