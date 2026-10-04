"""Synthetic offline legal evidence tests; fixtures are not device evidence."""

import copy
import hashlib
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import legal_probe  # noqa: E402
import test_probe as core_fixtures  # noqa: E402


KEY = "watchrss.startup-legal-stack"
URL = "http://127.0.0.1:38417/functions/v1/legal/watch/privacy-policy"
OWNER = "task_owner-17"
BODY = "LEGAL-MARKER 第01段。用于协议恢复验证。\n\n第02段。正文不能进入状态通道。".encode("utf-8")


def reference(raw=BODY, url=URL, owner=OWNER, token="file_17-a"):
    identity_sha = hashlib.sha256(json.dumps(["privacy", url], ensure_ascii=False,
                                            separators=(",", ":")).encode("utf-8")).hexdigest()
    digest = hashlib.sha256(raw).hexdigest()
    return {"version": 1, "owner": owner, "identity": {"page": "privacy", "url": url},
            "identitySha256": identity_sha,
            "path": f"legal-recovery/v1/{owner}/{identity_sha}-{digest}-{token}.utf8",
            "byteLength": len(raw), "sha256": digest}


def saved_stack(phase="top", ref=None):
    anchors = {"top": {"index": 0, "offsetPx": 0},
               "scrolled": {"index": 3, "offsetPx": 11},
               "held": None, "loaded": {"index": 0, "offsetPx": 0}}
    state = {"error": None, "isLoading": phase == "held", "reloadKey": 7,
             "listAnchor": anchors[phase], "scrollOffset": 113 if phase == "scrolled" else 0}
    ref = reference() if ref is None else ref
    return {"version": 2, "owner": ref["owner"], "pages": ["privacy"], "snapshots": [
        {"page": "privacy", "identity": copy.deepcopy(ref["identity"]),
         "state": state, "bodyReference": copy.deepcopy(ref)}]}


def host_state(saved=None, retained=False):
    saved = saved_stack() if saved is None else saved
    retained_stack = {key: copy.deepcopy(saved[key]) for key in ("version", "owner", "snapshots")
                      if key in saved}
    return {"savedJson": json.dumps({KEY: saved, "unrelated.saved": {"allowed": True}},
                                   ensure_ascii=False, separators=(",", ":")),
            "retainedJson": json.dumps({KEY: retained_stack, "unrelated.retained": 3}
                                       if retained else {"unrelated.retained": 3},
                                       ensure_ascii=False, separators=(",", ":"))}


def checkpoint(phase="top", ref=None):
    return legal_probe.checkpoint(host_state(saved_stack(phase, ref)), URL, phase=phase)


def node(node_id, parent, label, role="text", left=20, top=20, right=190, bottom=40):
    return {"id": node_id, "parentId": parent, "label": label, "role": role,
            "actions": 6 if role == "list" else 0, "state": 0,
            "bounds": {"left": left, "top": top, "right": right, "bottom": bottom}}


def snapshot(scrolled=False):
    nodes = [node(10, 0, "协议正文", "list", left=10, top=10, right=210, bottom=210),
             node(11, 10, "LEGAL-MARKER 第01段" if not scrolled else "LEGAL-MARKER 第04段"),
             node(12, 10, "第02段" if not scrolled else "第05段", top=55, bottom=85),
             node(13, 10, "屏幕外正文", top=215, bottom=240),
             node(14, 0, "页面外文字", top=15, bottom=35)]
    return {"version": 1, "runNonce": "a" * 32, "pid": 123,
            "processInstance": "b" * 32, "id": "c" * 32,
            "op": "snapshot", "status": "ok", "taskId": 17,
            "value": {"snapshotToken": "d" * 32, "tree": {"schema": 1, "nodes": nodes}}}


def restore_inputs():
    return [checkpoint("top"), checkpoint("scrolled"), checkpoint("held"), checkpoint("loaded"),
            legal_probe.geometry(snapshot()), legal_probe.geometry(snapshot(True)),
            legal_probe.geometry(snapshot())]


def legal_core_fixture():
    value = core_fixtures.fixture()
    before = host_state(saved_stack("scrolled"), retained=True)
    after = {"savedJson": before["savedJson"], "retainedJson": "{}"}
    for key in ("before_snapshot", "background_ack"):
        value[key]["value"]["hostState"] = copy.deepcopy(before)
    value["after_snapshot"]["value"]["hostState"] = copy.deepcopy(after)
    for event in value["events"]:
        if event["event"] == "postSave" or (event["event"] == "preCreate"
                                               and event["processInstance"] == core_fixtures.NEW):
            event["bundle"] = core_fixtures.saved_bundle(before["savedJson"])
        if event["event"] == "postCreate" and event["processInstance"] == core_fixtures.NEW:
            event["hostState"] = copy.deepcopy(after)
    return value


class LegalCheckpointTest(unittest.TestCase):
    def test_all_supported_phases_accept_compact_saved_and_optional_retained(self):
        for phase in ("top", "scrolled", "held", "loaded"):
            for retained in (False, True):
                with self.subTest(phase=phase, retained=retained):
                    stack = saved_stack(phase)
                    result = legal_probe.checkpoint(host_state(stack, retained), URL, phase=phase)
                    self.assertEqual(result["owner"], OWNER)
                    self.assertEqual(result["entry"], stack["snapshots"][0])
                    self.assertEqual(result["reference"], reference())
                    self.assertEqual(result["state"], stack["snapshots"][0]["state"])
                    self.assertEqual(result["expectedUrl"], URL)

    def test_no_legacy_additional_pages_body_content_or_unknown_metadata(self):
        mutations = {
            "legacy": lambda v: v.update(version=1),
            "boolean version": lambda v: v.update(version=True),
            "missing owner": lambda v: v.pop("owner"),
            "empty owner": lambda v: v.update(owner=""),
            "wrong owner": lambda v: v.update(owner="another-owner"),
            "extra page": lambda v: v["pages"].append("beian"),
            "wrong page": lambda v: v.update(pages=["useragreement"]),
            "no snapshots": lambda v: v.update(snapshots=[]),
            "null snapshot": lambda v: v.update(snapshots=[None]),
            "extra root metadata": lambda v: v.update(content="BODY"),
            "entry body": lambda v: v["snapshots"][0].update(content="BODY"),
            "state body": lambda v: v["snapshots"][0]["state"].update(content="BODY"),
            "wrong entry page": lambda v: v["snapshots"][0].update(page="useragreement"),
            "missing reference": lambda v: v["snapshots"][0].update(bodyReference=None),
            "identity mismatch": lambda v: v["snapshots"][0]["identity"].update(url=URL + "?x=1"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                value = saved_stack()
                mutate(value)
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.checkpoint(host_state(value), URL)

    def test_retained_must_be_compact_and_identical_to_saved(self):
        mutations = {
            "legacy": lambda v: v.update(version=1),
            "pages included": lambda v: v.update(pages=["privacy"]),
            "other owner": lambda v: v.update(owner="other"),
            "other entry": lambda v: v["snapshots"][0]["state"].update(reloadKey=8),
            "missing entry": lambda v: v.update(snapshots=[]),
            "body included": lambda v: v["snapshots"][0].update(content="unexpected"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                value = host_state(retained=True)
                retained = json.loads(value["retainedJson"])
                mutate(retained[KEY])
                value["retainedJson"] = json.dumps(retained)
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.checkpoint(value, URL)

    def test_retained_channel_limit_counts_all_utf8_bytes_including_unrelated_keys(self):
        limit = 896 * 1024
        for retained_present in (False, True):
            with self.subTest(retained_legal_key=retained_present):
                value = host_state(retained=retained_present)
                retained = json.loads(value["retainedJson"])
                retained["unrelated.padding"] = ""
                empty = json.dumps(retained, ensure_ascii=False, separators=(",", ":"))
                full_characters, remainder = divmod(limit - len(empty.encode("utf-8")), 3)
                retained["unrelated.padding"] = "界" * full_characters + "x" * remainder
                value["retainedJson"] = json.dumps(retained, ensure_ascii=False, separators=(",", ":"))
                self.assertEqual(len(value["retainedJson"].encode("utf-8")), limit)
                self.assertLess(len(value["retainedJson"]), limit)
                self.assertEqual(legal_probe.checkpoint(value, URL)["reference"], reference())

                retained["unrelated.padding"] += "x"
                value["retainedJson"] = json.dumps(retained, ensure_ascii=False, separators=(",", ":"))
                byte_count = len(value["retainedJson"].encode("utf-8"))
                self.assertEqual(byte_count, limit + 1)
                self.assertLess(byte_count, 1024 * 1024)
                self.assertLess(len(value["retainedJson"]), limit)
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.checkpoint(value, URL)

    def test_state_types_are_strict_and_phases_are_observed(self):
        invalid_fields = [("error", "request failed"), ("isLoading", 0), ("reloadKey", True),
                          ("reloadKey", -1), ("reloadKey", 1.5), ("reloadKey", 2**53),
                          ("scrollOffset", True), ("scrollOffset", -1), ("scrollOffset", 10**400),
                          ("scrollOffset", float("nan")), ("scrollOffset", float("inf")),
                          ("listAnchor", {"index": True, "offsetPx": 0}),
                          ("listAnchor", {"index": 0, "offsetPx": False}),
                          ("listAnchor", {"index": -1, "offsetPx": 0}),
                          ("listAnchor", {"index": 0, "offsetPx": 0.5}),
                          ("listAnchor", {"index": 0, "offsetPx": 0, "extra": 1})]
        for field, bad in invalid_fields:
            with self.subTest(field=field, bad=bad):
                value = saved_stack()
                value["snapshots"][0]["state"][field] = bad
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.checkpoint(host_state(value), URL)
        for state_phase, requested in (("top", "held"), ("held", "loaded"),
                                       ("scrolled", "top"), ("top", "scrolled"),
                                       ("top", "unknown")):
            with self.subTest(state=state_phase, phase=requested):
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.checkpoint(host_state(saved_stack(state_phase)), URL, phase=requested)
        held = saved_stack("held")
        held["snapshots"][0]["state"]["scrollOffset"] = 1
        with self.assertRaises(legal_probe.EvidenceError):
            legal_probe.checkpoint(host_state(held), URL, phase="held")

    def test_required_state_and_reference_fields_cannot_be_omitted(self):
        for section in ("state", "bodyReference"):
            for field in saved_stack()["snapshots"][0][section]:
                with self.subTest(section=section, field=field):
                    value = saved_stack()
                    value["snapshots"][0][section].pop(field)
                    with self.assertRaises(legal_probe.EvidenceError):
                        legal_probe.checkpoint(host_state(value), URL)

    def test_host_state_requires_strict_serialized_json_objects(self):
        variants = [{"savedJson": {}, "retainedJson": "{}"},
                    {"savedJson": "[]", "retainedJson": "{}"},
                    {"savedJson": "{}", "retainedJson": "{}"},
                    {"savedJson": '{"x":1,"x":2}', "retainedJson": "{}"},
                    {"savedJson": host_state()["savedJson"], "retainedJson": "null"}]
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.checkpoint(value, URL)

    def test_url_is_exact_ascii_loopback_privacy_endpoint(self):
        invalid_urls = [URL.replace("127.0.0.1", "localhost"), URL.replace("http:", "https:"),
                        URL.replace(":38417/", ":0/"), URL.replace(":38417/", ":65536/"),
                        URL.replace(":38417/", "/"), URL.replace("127.0.0.1", "127.0.0.2"),
                        URL.replace("privacy-policy", "user-agreement"), URL + "/", URL + "?x=1",
                        URL + "#fragment", URL + "\n", URL.replace("38417", "３８４１７"),
                        URL.replace("127.0.0.1", "user@127.0.0.1")]
        for url in invalid_urls:
            with self.subTest(url=url):
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.checkpoint(host_state(saved_stack(ref=reference(url=url))), url)
        for port in (1, 65535):
            url = URL.replace("38417", str(port))
            self.assertEqual(legal_probe.checkpoint(host_state(saved_stack(ref=reference(url=url))), url)
                             ["expectedUrl"], url)
        with self.assertRaises(legal_probe.EvidenceError):
            legal_probe.checkpoint(host_state(), URL.replace("38417", "38418"))


class LegalBodyTest(unittest.TestCase):
    def test_complete_body_hash_and_device_path(self):
        value = legal_probe.body(reference(), BODY, URL, BODY)
        self.assertEqual(value["path"], reference()["path"])
        self.assertEqual(value["devicePath"], "files/podjs/files/" + reference()["path"])
        self.assertEqual(value["bytes"], len(BODY))
        self.assertEqual(value["sha256"], hashlib.sha256(BODY).hexdigest())

    def test_reference_hash_identity_path_and_integer_fail_closed(self):
        mutations = {
            "version bool": lambda r: r.update(version=True),
            "owner traversal": lambda r: r.update(owner="../owner"),
            "owner too long": lambda r: r.update(owner="a" * 97),
            "identity page": lambda r: r["identity"].update(page="useragreement"),
            "identity extra": lambda r: r["identity"].update(content="BODY"),
            "identity digest": lambda r: r.update(identitySha256="0" * 64),
            "body digest": lambda r: r.update(sha256="0" * 64),
            "uppercase digest": lambda r: r.update(sha256=r["sha256"].upper()),
            "length bool": lambda r: r.update(byteLength=True),
            "length float": lambda r: r.update(byteLength=float(r["byteLength"])),
            "length zero": lambda r: r.update(byteLength=0),
            "length wrong": lambda r: r.update(byteLength=r["byteLength"] + 1),
            "length oversized": lambda r: r.update(byteLength=512 * 1024 + 1),
            "extra body field": lambda r: r.update(content="BODY"),
            "absolute path": lambda r: r.update(path="/" + r["path"]),
            "path traversal": lambda r: r.update(path=r["path"].replace("file_17-a", "../file")),
            "owner path mismatch": lambda r: r.update(path=r["path"].replace(OWNER, "another")),
            "empty token": lambda r: r.update(path=r["path"].replace("file_17-a", "")),
            "long token": lambda r: r.update(path=r["path"].replace("file_17-a", "a" * 97)),
            "wrong suffix": lambda r: r.update(path=r["path"] + ".backup"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                value = reference()
                mutate(value)
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.body(value, BODY, URL, BODY)

    def test_hash_correct_but_invalid_utf8_or_empty_body_is_rejected(self):
        for raw in (b"", b" \t\r\n", b"\xff", b"\xc0\xaf", b"\xed\xa0\x80", b"\xe4\xb8",
                    b"x" * (512 * 1024 + 1)):
            with self.subTest(length=len(raw), prefix=raw[:10]):
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.body(reference(raw), raw, URL, raw)
        maximum = b"x" * (512 * 1024)
        self.assertEqual(legal_probe.body(reference(maximum), maximum, URL, maximum)["bytes"], len(maximum))

    def test_bytes_and_expected_server_body_are_checked_independently(self):
        for raw, expected in ((BODY + b"x", BODY), (BODY, BODY + b"x"), (BODY[:-1], BODY)):
            with self.subTest(raw_bytes=len(raw), expected_bytes=len(expected)):
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.body(reference(), raw, URL, expected)
        other = "另一个合法但不同的正文".encode("utf-8")
        with self.assertRaises(legal_probe.EvidenceError):
            legal_probe.body(reference(other), other, URL, BODY)


class LegalGeometryTest(unittest.TestCase):
    def test_only_visible_legal_descendants_and_root_are_returned_without_ids(self):
        result = legal_probe.geometry(snapshot(), marker="LEGAL-MARKER")
        self.assertEqual([n["label"] for n in result], ["协议正文", "LEGAL-MARKER 第01段", "第02段"])
        self.assertTrue(all(set(n) == {"label", "role", "state", "bounds"} for n in result))
        renamed = snapshot()
        for n in renamed["value"]["tree"]["nodes"]:
            n["id"] += 100
            if n["parentId"]:
                n["parentId"] += 100
        self.assertEqual(result, legal_probe.geometry(renamed, marker="LEGAL-MARKER"))

    def test_marker_must_occur_in_a_visible_descendant(self):
        for marker in ("absent-marker", "屏幕外正文", "页面外文字", "协议正文"):
            with self.subTest(marker=marker):
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.geometry(snapshot(), marker=marker)

    def test_geometry_requires_successful_current_snapshot_ack(self):
        mutations = {
            "wrong operation": lambda v: v.update(op="background"),
            "failed ack": lambda v: v.update(status="error"),
            "bad process id": lambda v: v.update(pid=True),
            "bad command id": lambda v: v.update(id="old"),
            "schema bool": lambda v: v["value"]["tree"].update(schema=True),
            "schema version": lambda v: v["value"]["tree"].update(schema=2),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                value = snapshot()
                mutate(value)
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.geometry(value)

    def test_malformed_trees_and_bounds_fail_closed(self):
        mutations = {
            "duplicate id": lambda ns: ns.append(copy.deepcopy(ns[1])),
            "duplicate legal root": lambda ns: ns.append(node(15, 0, "协议正文", "list")),
            "missing legal root": lambda ns: ns[0].update(label="other"),
            "orphan": lambda ns: ns[1].update(parentId=999),
            "cycle": lambda ns: (ns[1].update(parentId=12), ns[2].update(parentId=11)),
            "self cycle": lambda ns: ns[1].update(parentId=11),
            "boolean id": lambda ns: ns[1].update(id=True),
            "boolean state": lambda ns: ns[1].update(state=True),
            "missing bounds": lambda ns: ns[1].pop("bounds"),
            "boolean coordinate": lambda ns: ns[1]["bounds"].update(left=True),
            "infinite coordinate": lambda ns: ns[1]["bounds"].update(top=float("inf")),
            "nan coordinate": lambda ns: ns[1]["bounds"].update(top=float("nan")),
            "overflow coordinate": lambda ns: ns[1]["bounds"].update(top=10**400),
            "reversed bounds": lambda ns: ns[1]["bounds"].update(right=0),
            "no visible text": lambda ns: (ns[1].update(parentId=0), ns[2].update(parentId=0)),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                value = snapshot()
                mutate(value["value"]["tree"]["nodes"])
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.geometry(value)

    def test_intersection_includes_partial_text_but_excludes_touching_edges(self):
        value = snapshot()
        nodes = value["value"]["tree"]["nodes"]
        nodes[1]["bounds"].update(top=0, bottom=20)
        nodes[2]["bounds"].update(top=210, bottom=240)
        result = legal_probe.geometry(value)
        self.assertEqual([n["label"] for n in result], ["协议正文", "LEGAL-MARKER 第01段"])

    def test_semantic_comparison_respects_tolerance_order_role_and_state(self):
        before = legal_probe.geometry(snapshot())
        shifted = copy.deepcopy(before)
        shifted[1]["bounds"]["top"] += 1
        self.assertTrue(legal_probe.compare_geometry(before, shifted))
        self.assertFalse(legal_probe.compare_geometry(before, shifted, tolerance=0))
        shifted[1]["bounds"]["top"] += 1
        self.assertFalse(legal_probe.compare_geometry(before, shifted))
        self.assertTrue(legal_probe.compare_geometry(before, shifted, tolerance=2))
        for field, value in (("label", "different"), ("role", "button"), ("state", 1)):
            changed = copy.deepcopy(before)
            changed[1][field] = value
            with self.subTest(field=field):
                self.assertFalse(legal_probe.compare_geometry(before, changed))
        self.assertFalse(legal_probe.compare_geometry(before, [before[0], before[2], before[1]]))
        self.assertFalse(legal_probe.compare_geometry(before, before[:-1]))

    def test_comparison_rejects_invalid_input_instead_of_reporting_match(self):
        valid = legal_probe.geometry(snapshot())
        for bad in (None, {}, [], [{"label": "x"}]):
            with self.subTest(bad=bad):
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.compare_geometry(bad, valid)
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.compare_geometry(valid, bad)
        for tolerance in (-1, True, float("nan"), float("inf"), 10**400):
            with self.subTest(tolerance=tolerance):
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.compare_geometry(valid, valid, tolerance=tolerance)


class LegalRestoreTest(unittest.TestCase):
    def test_complete_held_reset_proof_keeps_pixel_and_event_claims_false(self):
        values = restore_inputs()
        legal_probe.validate_held(values[1], values[2])
        result = legal_probe.validate_restored(*values)
        self.assertIs(result["pixelParityVerified"], False)
        self.assertIs(result["eventTimingVerified"], False)

    def test_held_transition_cannot_change_reference_owner_identity_or_reload(self):
        mutations = {
            "changed reference": lambda v: v["reference"].update(path=v["reference"]["path"].replace("file_17-a", "file-other")),
            "changed owner": lambda v: v.update(owner="other"),
            "changed identity": lambda v: v["entry"]["identity"].update(url=URL.replace("38417", "38418")),
            "reload changed": lambda v: v["state"].update(reloadKey=8),
            "loading false": lambda v: v["state"].update(isLoading=False),
            "anchor retained": lambda v: v["state"].update(listAnchor={"index": 3, "offsetPx": 11}),
            "offset retained": lambda v: v["state"].update(scrollOffset=113),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                before, held = checkpoint("scrolled"), checkpoint("held")
                mutate(held)
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.validate_held(before, held)

    def test_restore_requires_top_reset_and_distinct_prior_scroll_geometry(self):
        mutations = {
            "after anchor not top": lambda v: v[3]["state"].update(listAnchor={"index": 1, "offsetPx": 0}),
            "after anchor offset": lambda v: v[3]["state"].update(listAnchor={"index": 0, "offsetPx": 1}),
            "after loading": lambda v: v[3]["state"].update(isLoading=True),
            "after reference changed": lambda v: v[3]["reference"].update(path=v[3]["reference"]["path"].replace("file_17-a", "file-new")),
            "top reference changed": lambda v: v[0]["reference"].update(path=v[0]["reference"]["path"].replace("file_17-a", "file-top")),
            "unchanged scroll geometry": lambda v: v.__setitem__(5, copy.deepcopy(v[4])),
            "after text mismatch": lambda v: v[6][1].update(label="unexpected"),
            "after geometry mismatch": lambda v: v[6][1]["bounds"].update(top=30),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                values = restore_inputs()
                mutate(values)
                with self.assertRaises(legal_probe.EvidenceError):
                    legal_probe.validate_restored(*values)

    def test_detached_aliases_cannot_forge_boolean_integer_metadata(self):
        held = checkpoint("held")
        held["state"] = copy.deepcopy(held["state"])
        held["state"]["scrollOffset"] = False
        self.assertEqual(held["state"], held["entry"]["state"])
        with self.assertRaises(legal_probe.EvidenceError):
            legal_probe.validate_held(checkpoint("scrolled"), held)
        held = checkpoint("held")
        held["reference"] = copy.deepcopy(held["reference"])
        held["reference"]["version"] = True
        self.assertEqual(held["reference"], held["entry"]["bodyReference"])
        with self.assertRaises(legal_probe.EvidenceError):
            legal_probe.validate_held(checkpoint("scrolled"), held)
        values = restore_inputs()
        values[3]["state"] = copy.deepcopy(values[3]["state"])
        values[3]["state"]["listAnchor"]["index"] = False
        self.assertEqual(values[3]["state"], values[3]["entry"]["state"])
        with self.assertRaises(legal_probe.EvidenceError):
            legal_probe.validate_restored(*values)


class LegalCoreIntegrationTest(unittest.TestCase):
    def test_legal_core_accepts_compact_bundle_without_claiming_file_or_branch_proof(self):
        core = legal_probe.probe
        result = core.validate(**legal_core_fixture(), scenario="legal", legal_url=URL)
        self.assertEqual(result["scenario"], "legal")
        self.assertIs(result["legalCompactMetadataInSavedBundle"], True)
        self.assertEqual(result["savedLegalCheckpoint"],
                         legal_probe.checkpoint(host_state(saved_stack("scrolled"), retained=True),
                                                URL, phase="scrolled"))
        for flag in ("actualProcessReplacementVerified", "sameSystemTaskAndActivityRecordVerified",
                     "actualIncomingBundleVerified", "savedRestoredBeforeGuestBoot",
                     "retainedAbsentBeforeGuestBoot", "persistentKvUnchanged"):
            self.assertIs(result[flag], True, flag)
        for flag in ("legalBodyFilesVerified", "legalBranchOutcomeVerified", "uiParityVerified"):
            self.assertIs(result[flag], False, flag)

    def test_legal_mode_preserves_incoming_bundle_pid_and_system_record_guards(self):
        core = legal_probe.probe

        def change_incoming_bundle(value):
            changed = saved_stack("scrolled")
            changed["snapshots"][0]["state"]["reloadKey"] += 1
            for event in value["events"]:
                if event["event"] == "preCreate" and event["processInstance"] == core_fixtures.NEW:
                    event["bundle"] = core_fixtures.saved_bundle(host_state(changed)["savedJson"])

        def reuse_old_pid(value):
            old_pid = value["before_snapshot"]["pid"]
            value["after_snapshot"]["pid"] = old_pid
            value["recovered"]["pid"] = old_pid
            for event in value["events"]:
                if event["processInstance"] == core_fixtures.NEW:
                    event["pid"] = old_pid

        def retain_state_before_guest_boot(value):
            for event in value["events"]:
                if event["event"] == "postCreate" and event["processInstance"] == core_fixtures.NEW:
                    event["hostState"]["retainedJson"] = '{"unexpected":true}'

        mutations = {
            "validly hashed but different incoming Bundle": change_incoming_bundle,
            "new process identity reuses old PID": reuse_old_pid,
            "dead system record changed": lambda v: v["dead"].update(systemRecord="ffff"),
            "recovered system record changed": lambda v: v["recovered"].update(systemRecord="ffff"),
            "retained channel survived before guest boot": retain_state_before_guest_boot,
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                value = legal_core_fixture()
                mutate(value)
                with self.assertRaises(core.EvidenceError):
                    core.validate(**value, scenario="legal", legal_url=URL)

    def test_default_custom_scenario_remains_distinct_from_legal(self):
        core = legal_probe.probe
        custom = core.validate(**core_fixtures.fixture())
        self.assertEqual(custom["scenario"], "custom")
        self.assertIs(custom["checkedAgreementAndNondefaultCustomizationInSavedBundle"], True)
        self.assertEqual(custom["savedCustomization"]["font"], 16)
        self.assertNotIn("savedLegalCheckpoint", custom)
        with self.assertRaises(core.EvidenceError):
            core.validate(**core_fixtures.fixture(), scenario="legal", legal_url=URL)
        with self.assertRaises(core.EvidenceError):
            core.validate(**legal_core_fixture())


if __name__ == "__main__":
    unittest.main()
