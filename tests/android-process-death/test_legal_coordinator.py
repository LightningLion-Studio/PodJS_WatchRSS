"""Offline legal coordinator regressions; no ADB, server, socket, or device proof.

Only the coordinator runs here. The independent HTTP fixture is represented by
immutable local bytes and explicit server-state observations; its implementation
has separate tests. A virtual monotonic clock makes deadline failures immediate.
"""

import argparse
import copy
import importlib.util
import json
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


support = load("legal_coordinator_support", "test_run_device.py")
device, probe = support.device, support.probe
with mock.patch.dict(sys.modules, {"probe": probe}):
    legal_probe = load("legal_coordinator_probe", "legal_probe.py")
with mock.patch.dict(sys.modules, {"legal_probe": legal_probe}):
    legal = load("legal_coordinator_fixtures", "test_legal_probe.py")


class LegalCoordinatorOfflineTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="watchrss-legal-coordinator-unit-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.receipt = self.directory / "ownership.json"
        self.receipt.write_bytes(device.encoded(support.ownership_receipt()))
        self.server_directory = self.directory / "independent-server"
        self.server_directory.mkdir(mode=0o700)
        self.manifest = {"version": 1, "nonce": "a" * 32, "pid": 12345,
                         "host": "127.0.0.1", "port": 38417,
                         "requestPath": "/functions/v1/legal/watch/privacy-policy",
                         "bodyFile": "body.utf8", "bodyBytes": len(legal.BODY),
                         "bodySha256": device.digest(legal.BODY), "holdTimeoutMs": 10000}
        (self.server_directory / "manifest.json").write_bytes(device.encoded(self.manifest))
        (self.server_directory / "body.utf8").write_bytes(legal.BODY)
        self.server_value = {"requestCount": 0, "failure": None, "requests": []}
        self.server_probes = {"version": 1, "nonce": self.manifest["nonce"],
                              "pid": self.manifest["pid"], "probeCount": 0, "probes": []}
        self.server = SimpleNamespace(
            read_manifest=mock.Mock(side_effect=lambda directory: copy.deepcopy(self.manifest)),
            read_state=mock.Mock(side_effect=lambda directory, manifest: copy.deepcopy(self.server_value)),
            read_probes=mock.Mock(side_effect=lambda directory, manifest: copy.deepcopy(self.server_probes)),
            release_second=mock.Mock(return_value={"nonce": self.manifest["nonce"], "request": 2}))
        self.clock = 100.0
        self.transport = []
        for patch in (
                mock.patch.dict(sys.modules, {"legal_server": self.server, "legal_probe": legal_probe}),
                mock.patch.object(device, "LOCK_ROOT", self.directory / "shared-device-locks"),
                mock.patch.object(device.subprocess, "run", side_effect=AssertionError("Real subprocess forbidden")),
                mock.patch.object(socket, "socket", side_effect=AssertionError("Real sockets forbidden")),
                mock.patch.object(device.time, "monotonic", side_effect=lambda: self.clock),
                mock.patch.object(device.time, "monotonic_ns", side_effect=lambda: int(self.clock * 1e9)),
                mock.patch.object(device.time, "sleep", side_effect=self.advance)):
            patch.start()
            self.addCleanup(patch.stop)

    def advance(self, seconds):
        self.clock += seconds

    def args(self, mode="prepare", output="run", scenario="legal", **overrides):
        values = dict(serial="offline-serial", user=0, receipt=str(self.receipt),
                      out=str(self.directory / output), mode=mode, scenario=scenario,
                      legal_base_url="http://127.0.0.1:38417" if mode == "prepare" and scenario == "legal" else None,
                      legal_server=str(self.server_directory) if mode == "prepare" and scenario == "legal" else None)
        values.update(overrides)
        return argparse.Namespace(**values)

    def factory(self, *arguments):
        value = support.FakeAdb(*arguments)
        self.transport.append(value)
        return value

    def coordinator(self, **arguments):
        value = device.Coordinator(self.args(**arguments), adb_factory=self.factory)
        self.addCleanup(value.close)
        return value

    def server_observation(self, count=2, status="held", received=100_000_000_000):
        self.server_value = {"requestCount": count, "failure": None,
                             "requests": [{"status": "complete", "httpStatus": 200,
                                           "receivedMonotonicNs": 90_000_000_000}]}
        if count == 2:
            self.server_value["requests"].append({"status": status, "httpStatus": None,
                                                   "receivedMonotonicNs": received})
        return self.server_value

    def snapshot_value(self, phase="held", new=True):
        value = legal.snapshot(phase == "scrolled")
        value.update(pid=201 if new else 101, processInstance=support.fixtures.NEW if new else support.fixtures.OLD)
        value["value"].update(hostState=legal.host_state(legal.saved_stack(phase)),
                              persistentKv=dict(support.fixtures.BASELINE))
        if phase == "held":
            value["value"]["tree"]["nodes"] = [legal.node(1, 0, "正在加载")]
        elif phase in ("top", "loaded"):
            value["value"]["tree"]["nodes"][1]["label"] = legal.BODY.decode().split("\n", 1)[0]
        return value

    def held_fixture(self):
        coordinator = self.coordinator()
        coordinator.state.update(phase="restored", expectedKv=dict(support.fixtures.BASELINE),
                                 restoredIdentity=["a" * 32, 201, support.fixtures.NEW],
                                 legalBefore={"checkpoint": legal.checkpoint("scrolled")})
        coordinator.adb.deadline = 999.0
        coordinator.adb.files["files/podjs/files/" + legal.reference()["path"]] = legal.BODY
        self.server_observation()
        value = self.snapshot_value()
        coordinator.snapshot = mock.Mock(side_effect=lambda: (copy.deepcopy(value), coordinator.artifact("held-snapshot.json", value)))
        coordinator.save()
        return coordinator, value

    def assert_failed_without_release(self, coordinator):
        self.server.release_second.assert_not_called()
        self.assertEqual(coordinator.state["phase"], "restored")
        self.assertIsNone(coordinator.state["pending"])
        self.assertIn("legalFailure", coordinator.state)
        self.assertEqual(coordinator.adb.deadline, 999.0)
        self.assertIn("legalFailure", json.loads((coordinator.root / "run.json").read_text()))

    def recorded_sample(self, coordinator, phase="top"):
        value = self.snapshot_value(phase, new=phase == "held")
        point = legal.checkpoint(phase)
        body = legal_probe.body(point["reference"], legal.BODY, legal.URL, legal.BODY)
        body["artifact"] = coordinator.artifact("recorded-body.utf8", legal.BODY)
        sample = {"snapshot": coordinator.artifact("recorded-snapshot.json", value),
                  "checkpoint": point, "body": body}
        if phase != "held":
            sample["geometry"] = legal_probe.geometry(value, legal.BODY.decode().split("\n", 1)[0] if phase == "top" else None)
        event = support.fixtures.event("commandAcknowledged", 5, new=phase == "held",
                                       id=value["id"], op="snapshot", status="ok")
        return sample, [event], probe.identity(value, "fixture")

    def http_sample(self, coordinator):
        first = {"number": 1, "method": "GET", "path": self.manifest["requestPath"],
                 "receivedMonotonicNs": 90_000_000_000, "receivedAt": "first-received",
                 "completedMonotonicNs": 91_000_000_000, "completedAt": "first-completed",
                 "status": "complete", "httpStatus": 200, "error": None}
        second = {"number": 2, "method": "GET", "path": self.manifest["requestPath"],
                  "receivedMonotonicNs": 100_000_000_000, "receivedAt": "second-received",
                  "completedMonotonicNs": None, "completedAt": None,
                  "status": "held", "httpStatus": None, "error": None}
        bracket = {"nonce": self.manifest["nonce"], "pid": self.manifest["pid"],
                   "requestCount": 2, "failure": None, "requests": [first, second]}
        coordinator.state["legalHeld"] = {"serverBefore": copy.deepcopy(bracket),
                                           "serverAfter": copy.deepcopy(bracket),
                                           "capturedMonotonicNs": 102_000_000_000}
        completed = copy.deepcopy(bracket)
        completed["requests"][1].update(status="complete", httpStatus=200,
                                          completedMonotonicNs=104_000_000_000,
                                          completedAt="second-completed")
        marker = device.encoded({"version": 1, "nonce": self.manifest["nonce"], "request": 2})
        (self.server_directory / "release-2.json").write_bytes(marker)
        receipt = {"version": 1, "nonce": self.manifest["nonce"], "pid": self.manifest["pid"],
                   "request": 2, "path": "release-2.json", "bytes": len(marker),
                   "sha256": device.digest(marker), "manifestSha256": coordinator.state["legal"]["manifestSha256"],
                   "bodySha256": device.digest(legal.BODY), "publishedMonotonicNs": 103_000_000_000,
                   "publishedAt": "marker-published"}
        coordinator.state["legalRelease"] = coordinator.artifact("http-release.json", receipt)
        (self.server_directory / "release-2.receipt.json").write_bytes(device.encoded(receipt))
        return completed, receipt

    def test_omitted_scenario_defaults_to_custom_and_legacy_run_remains_resumable(self):
        coordinator = self.coordinator(scenario=None)
        self.assertEqual(coordinator.state["scenario"], "custom")
        coordinator.state.pop("scenario")
        coordinator.state.pop("scenarioSha256")
        coordinator.save()
        coordinator.close()
        resumed = self.coordinator(mode="collect", scenario=None)
        self.assertNotIn("legal", resumed.state)

    def test_legal_prepare_binds_server_nonce_and_seeds_only_legal_fixture_options(self):
        coordinator = self.coordinator()
        coordinator.prepare()
        self.assertEqual(coordinator.state["runNonce"], self.manifest["nonce"])
        self.assertEqual(coordinator.state["legal"]["url"], legal.URL)
        seed = json.loads(coordinator.adb.files[device.KV_PATH])
        self.assertEqual(seed["watchrss.onboarding"]["oobeSeenVersion"], 3)
        self.assertEqual(seed["watchrss.onboarding"]["privacyPolicyAgreedVersion"], 0)
        self.assertEqual(seed["startup-legal-base-url"], "http://127.0.0.1:38417")
        self.assertIs(seed["legal-restoration-events"], False)
        self.assertEqual((coordinator.root / "legal-body.utf8").read_bytes(), legal.BODY)

    def test_custom_rejects_legal_options_and_legal_rejects_noncanonical_base_url(self):
        bad = [("custom", {"legal_base_url": "http://127.0.0.1:38417"}),
               ("custom", {"legal_server": str(self.server_directory)})]
        bad.extend(("legal", {"legal_base_url": url}) for url in
                   ("http://localhost:38417", "https://127.0.0.1:38417", "http://127.0.0.1:0",
                    "http://127.0.0.1:65536", "http://127.0.0.1:038417", "http://127.0.0.1:38417/"))
        for index, (scenario, options) in enumerate(bad):
            with self.subTest(scenario=scenario, options=options), self.assertRaises(probe.EvidenceError):
                self.coordinator(output="bad-" + str(index), scenario=scenario, **options)
        self.assertEqual(self.transport, [])

    def test_legal_prepare_rejects_used_or_failed_server_before_any_adb(self):
        for index, changes in enumerate(({"requestCount": 1}, {"failure": "fixture failed"})):
            self.server_value.update(requestCount=0, failure=None)
            self.server_value.update(changes)
            with self.subTest(changes=changes), self.assertRaises(probe.EvidenceError):
                self.coordinator(output="used-" + str(index))
        self.assertEqual(self.transport, [])

    def test_resumed_scenario_is_inherited_and_explicit_switch_is_rejected(self):
        coordinator = self.coordinator()
        coordinator.close()
        resumed = self.coordinator(mode="collect", scenario=None)
        self.assertEqual(resumed.state["scenario"], "legal")
        resumed.close()
        with self.assertRaisesRegex(probe.EvidenceError, "Scenario cannot change"):
            self.coordinator(mode="collect", scenario="custom")

    def test_resume_rejects_changed_scenario_bytes_config_and_legal_arguments(self):
        for index, kind in enumerate(("bytes", "config", "url", "server")):
            with self.subTest(kind=kind):
                output = "immutable-" + str(index)
                coordinator = self.coordinator(output=output)
                options = {}
                if kind == "bytes":
                    path = coordinator.root / "scenario.json"
                    path.write_bytes(path.read_bytes() + b"\n")
                elif kind == "config":
                    coordinator.state["legal"]["baseUrl"] = "http://127.0.0.1:38418"
                    coordinator.save()
                else:
                    options["legal_base_url" if kind == "url" else "legal_server"] = "changed"
                coordinator.close()
                with self.assertRaises(probe.EvidenceError):
                    self.coordinator(mode="collect", output=output, scenario=None, **options)

    def test_context_rejects_mutated_server_or_copied_manifest_and_body(self):
        for index, (location, name) in enumerate((("server", "manifest.json"), ("run", "legal-server-manifest.json"),
                                                  ("server", "body.utf8"), ("run", "legal-body.utf8"))):
            with self.subTest(location=location, name=name):
                coordinator = self.coordinator(output="content-" + str(index))
                path = (self.server_directory if location == "server" else coordinator.root) / name
                original = path.read_bytes()
                path.write_bytes(original + b"\n")
                with self.assertRaises(probe.EvidenceError):
                    coordinator.legal_context()
                path.write_bytes(original)
                coordinator.close()

    def test_context_rejects_manifest_identity_changed_by_reader(self):
        coordinator = self.coordinator()
        self.manifest["pid"] += 1
        with self.assertRaisesRegex(probe.EvidenceError, "identity changed"):
            coordinator.legal_context()

    def test_release_observes_durable_held_body_and_pending_intent(self):
        coordinator, _ = self.held_fixture()
        def released(directory, manifest):
            saved = json.loads((coordinator.root / "run.json").read_text())
            self.assertEqual(saved["legalReleasePending"]["nonce"], manifest["nonce"])
            self.assertEqual(saved["legalHeld"]["checkpoint"], legal.checkpoint("held"))
            self.assertEqual((coordinator.root / saved["legalHeld"]["body"]["artifact"]).read_bytes(), legal.BODY)
            self.assertEqual(saved["phase"], "restored")
            self.assertIsNone(saved["pending"])
            self.assertLess(self.clock, coordinator.adb.deadline)
            return {"nonce": manifest["nonce"], "request": 2}
        self.server.release_second.side_effect = released
        result = coordinator.legal_hold_release()
        self.assertEqual(result["heldCheckpoint"]["checkpoint"]["reference"], legal.reference())
        self.server.release_second.assert_called_once()
        self.assertNotIn("legalReleasePending", coordinator.state)
        self.assertNotIn("legalFailure", coordinator.state)
        self.assertEqual(coordinator.adb.deadline, 999.0)
        self.assertIn("legalRelease", json.loads((coordinator.root / "run.json").read_text()))

    def test_failed_wrong_count_or_nonheld_server_never_captures_or_releases(self):
        for kind in ("failure", "count", "complete"):
            with self.subTest(kind=kind):
                coordinator, _ = self.held_fixture()
                if kind == "failure":
                    self.server_value["failure"] = "deadline expired"
                elif kind == "count":
                    self.server_value["requestCount"] = 3
                else:
                    self.server_value["requests"][-1]["status"] = "complete"
                with self.assertRaises(probe.EvidenceError):
                    coordinator.legal_hold_release()
                coordinator.snapshot.assert_not_called()
                self.assert_failed_without_release(coordinator)
                coordinator.close()
                # Each rejection needs a fresh run and an independent server state.
                self.directory.joinpath("run").rename(self.directory / ("rejected-" + kind))
                self.server_value = {"requestCount": 0, "failure": None, "requests": []}
                self.clock = 100.0

    def test_already_expired_hold_never_submits_snapshot(self):
        coordinator, _ = self.held_fixture()
        self.clock = 110.0
        with self.assertRaisesRegex(probe.EvidenceError, "already expired"):
            coordinator.legal_hold_release()
        coordinator.snapshot.assert_not_called()
        self.assert_failed_without_release(coordinator)

    def test_snapshot_crossing_deadline_never_releases(self):
        coordinator, value = self.held_fixture()
        def snapshot():
            self.clock = 110.0
            return value, coordinator.artifact("late-snapshot.json", value)
        coordinator.snapshot.side_effect = snapshot
        with self.assertRaisesRegex(probe.EvidenceError, "no longer held"):
            coordinator.legal_hold_release()
        self.assert_failed_without_release(coordinator)

    def test_durable_save_crossing_deadline_preserves_release_intent_without_release(self):
        coordinator, _ = self.held_fixture()
        save = coordinator.save
        def slow_save():
            save()
            if "legalReleasePending" in coordinator.state:
                self.clock = 110.0
        with mock.patch.object(coordinator, "save", side_effect=slow_save):
            with self.assertRaisesRegex(probe.EvidenceError, "persisting"):
                coordinator.legal_hold_release()
        self.assert_failed_without_release(coordinator)
        self.assertIn("legalHeld", coordinator.state)
        self.assertIn("legalReleasePending", json.loads((coordinator.root / "run.json").read_text()))

    def test_changed_request_identity_around_body_observation_never_releases(self):
        coordinator, _ = self.held_fixture()
        original = copy.deepcopy(self.server_value)
        changed = copy.deepcopy(original)
        changed["requests"][-1]["receivedMonotonicNs"] += 1
        self.server.read_state.side_effect = [original, original, changed]
        with self.assertRaisesRegex(probe.EvidenceError, "no longer held"):
            coordinator.legal_hold_release()
        self.assert_failed_without_release(coordinator)

    def test_missing_or_corrupt_same_reference_body_never_releases(self):
        coordinator, _ = self.held_fixture()
        path = "files/podjs/files/" + legal.reference()["path"]
        coordinator.adb.files[path] = legal.BODY + b"corruption"
        with self.assertRaises(probe.EvidenceError):
            coordinator.legal_hold_release()
        self.assert_failed_without_release(coordinator)
        coordinator.state.pop("legalFailure")
        coordinator.adb.files.pop(path)
        with self.assertRaises(probe.EvidenceError):
            coordinator.legal_hold_release()
        self.assert_failed_without_release(coordinator)

    def test_loading_state_with_document_semantics_cannot_pass_held_barrier(self):
        coordinator, value = self.held_fixture()
        value["value"]["tree"]["nodes"] = legal.snapshot()["value"]["tree"]["nodes"]
        with self.assertRaisesRegex(probe.EvidenceError, "deadline expired"):
            coordinator.legal_hold_release()
        self.assert_failed_without_release(coordinator)
        self.assertNotIn("legalHeld", coordinator.state)

    def test_release_failure_keeps_core_restore_and_durable_intent(self):
        coordinator, _ = self.held_fixture()
        self.server.release_second.side_effect = probe.EvidenceError("Injected release failure")
        with self.assertRaisesRegex(probe.EvidenceError, "Injected release"):
            coordinator.legal_hold_release()
        self.server.release_second.assert_called_once()
        self.assertEqual(coordinator.state["phase"], "restored")
        self.assertIsNone(coordinator.state["pending"])
        self.assertIn("legalFailure", coordinator.state)
        self.assertIn("legalReleasePending", coordinator.state)
        self.assertEqual(coordinator.adb.deadline, 999.0)

    def test_unfinished_or_failed_legal_restore_allows_only_collect_on_resume(self):
        for index, fields in enumerate(({}, {"legalReleasePending": {"request": 2}},
                                        {"legalFailure": {"error": "timeout"}},
                                        {"pending": {"label": "snapshot"}})):
            with self.subTest(fields=fields):
                output = "blocked-" + str(index)
                coordinator = self.coordinator(output=output)
                coordinator.state.update(phase="restored", **fields)
                coordinator.save()
                coordinator.close()
                for mode in ("snapshot", "action", "restore", "validate"):
                    with self.assertRaises(probe.EvidenceError):
                        self.coordinator(mode=mode, output=output, scenario=None)
                collected = self.coordinator(mode="collect", output=output, scenario=None)
                self.assertEqual(collected.state["phase"], "restored")
                collected.close()

    def test_validate_requires_completed_held_barrier_before_snapshot(self):
        coordinator = self.coordinator()
        coordinator.state["phase"] = "restored"
        with mock.patch.object(coordinator, "snapshot") as snapshot:
            with self.assertRaisesRegex(probe.EvidenceError, "completed held-reference"):
                coordinator.validate()
            snapshot.assert_not_called()

    def test_recorded_samples_bind_top_scrolled_and_held_to_ack_events_and_bytes(self):
        coordinator = self.coordinator()
        coordinator.state["expectedKv"] = dict(support.fixtures.BASELINE)
        for phase in ("top", "scrolled", "held"):
            with self.subTest(phase=phase):
                sample, events, ident = self.recorded_sample(coordinator, phase)
                self.assertEqual(coordinator.legal_recorded_sample(sample, events, phase, ident), events[0])

    def test_recorded_sample_rejects_cache_changes_missing_journal_and_wrong_process(self):
        coordinator = self.coordinator()
        coordinator.state["expectedKv"] = dict(support.fixtures.BASELINE)
        for kind in ("checkpoint", "geometry", "bodyReceipt", "bodyBytes", "journal", "identity", "kv"):
            with self.subTest(kind=kind):
                sample, events, ident = self.recorded_sample(coordinator)
                if kind == "checkpoint":
                    sample["checkpoint"]["state"]["reloadKey"] += 1
                elif kind == "geometry":
                    sample["geometry"] = {}
                elif kind == "bodyReceipt":
                    sample["body"]["bytes"] += 1
                elif kind == "bodyBytes":
                    (coordinator.root / sample["body"]["artifact"]).write_bytes(legal.BODY + b"corrupt")
                elif kind == "journal":
                    events = []
                elif kind == "identity":
                    ident = (ident[0], ident[1] + 1, ident[2])
                else:
                    path = coordinator.root / sample["snapshot"]
                    value = json.loads(path.read_text())
                    value["value"]["persistentKv"]["bytes"] += 1
                    path.write_bytes(device.encoded(value))
                with self.assertRaises(probe.EvidenceError):
                    coordinator.legal_recorded_sample(sample, events, "top", ident)

    def test_recorded_held_sample_rejects_document_branch_even_with_loading_state(self):
        coordinator = self.coordinator()
        coordinator.state["expectedKv"] = dict(support.fixtures.BASELINE)
        sample, events, ident = self.recorded_sample(coordinator, "held")
        path = coordinator.root / sample["snapshot"]
        value = json.loads(path.read_text())
        value["value"]["tree"] = legal.snapshot()["value"]["tree"]
        path.write_bytes(device.encoded(value))
        with self.assertRaisesRegex(probe.EvidenceError, "document branch"):
            coordinator.legal_recorded_sample(sample, events, "held", ident)

    def test_http_proof_binds_held_bracket_marker_receipt_and_completion_order(self):
        coordinator = self.coordinator()
        completed, receipt = self.http_sample(coordinator)
        result = coordinator.legal_http_proof(completed)
        self.assertTrue(result["sameIndependentServerVerified"])
        self.assertTrue(result["heldBeforeReleaseVerified"])
        self.assertEqual(result["additionalRequests"], 1)
        self.assertEqual(result["requestMethod"], "GET")
        self.assertEqual(result["requestPath"], self.manifest["requestPath"])
        self.assertEqual(result["countScope"], "exact-legal-endpoint")
        self.assertEqual(result["release"], receipt)

    def test_http_proof_rejects_bracket_receipt_marker_and_timing_tampering(self):
        coordinator = self.coordinator()
        kinds = ("server nonce", "server pid", "failed response", "bracket nonce", "first changed",
                 "request changed", "already completed", "receipt copy", "receipt hash", "manifest hash",
                 "body hash", "receipt schema", "bool request", "bool timestamp", "marker bool",
                 "capture early", "publish early", "complete early", "publish at deadline", "missing receipt")
        for kind in kinds:
            with self.subTest(kind=kind):
                completed, receipt = self.http_sample(coordinator)
                held = coordinator.state["legalHeld"]
                if kind == "server nonce":
                    completed["nonce"] = "b" * 32
                elif kind == "server pid":
                    completed["pid"] += 1
                elif kind == "failed response":
                    completed["requests"][1]["httpStatus"] = 503
                elif kind == "bracket nonce":
                    held["serverBefore"]["nonce"] = "b" * 32
                elif kind == "first changed":
                    held["serverAfter"]["requests"][0]["receivedMonotonicNs"] += 1
                elif kind == "request changed":
                    held["serverAfter"]["requests"][1]["receivedMonotonicNs"] += 1
                elif kind == "already completed":
                    held["serverBefore"]["requests"][1]["completedMonotonicNs"] = 101_000_000_000
                elif kind == "receipt copy":
                    receipt["publishedAt"] = "another receipt"
                elif kind == "receipt hash":
                    receipt["sha256"] = "f" * 64
                elif kind == "manifest hash":
                    receipt["manifestSha256"] = "f" * 64
                elif kind == "body hash":
                    receipt["bodySha256"] = "f" * 64
                elif kind == "receipt schema":
                    receipt["unexpected"] = True
                elif kind == "bool request":
                    receipt["version"] = True
                elif kind == "bool timestamp":
                    held["capturedMonotonicNs"] = True
                elif kind == "marker bool":
                    marker = device.encoded({"version": True, "nonce": self.manifest["nonce"], "request": 2})
                    (self.server_directory / "release-2.json").write_bytes(marker)
                    receipt.update(bytes=len(marker), sha256=device.digest(marker))
                elif kind == "capture early":
                    held["capturedMonotonicNs"] = 99_000_000_000
                elif kind == "publish early":
                    receipt["publishedMonotonicNs"] = 101_000_000_000
                elif kind == "complete early":
                    completed["requests"][1]["completedMonotonicNs"] = 102_000_000_000
                elif kind == "publish at deadline":
                    receipt["publishedMonotonicNs"] = 110_000_000_000
                    completed["requests"][1]["completedMonotonicNs"] = 111_000_000_000
                elif kind == "missing receipt":
                    coordinator.state["legalRelease"] = "does-not-exist.json"
                (self.server_directory / "release-2.receipt.json").write_bytes(device.encoded(receipt))
                if kind not in ("receipt copy", "missing receipt"):
                    (coordinator.root / coordinator.state["legalRelease"]).write_bytes(device.encoded(receipt))
                with self.assertRaises((probe.EvidenceError, FileNotFoundError)):
                    coordinator.legal_http_proof(completed)

    def test_adb_deadline_prevents_call_and_clips_command_timeout(self):
        adb = device.Adb("offline-serial", 0, self.directory)
        adb.deadline = self.clock
        with self.assertRaisesRegex(probe.EvidenceError, "deadline expired"):
            adb.run(["am", "start", "--user", "0", "example"])
        device.subprocess.run.assert_not_called()
        self.assertEqual(adb.sequence, 0)
        adb.deadline = self.clock + .75
        with mock.patch.object(device.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            self.assertEqual(adb.run(["getprop", "ro.build.version.sdk"]), b"")
            self.assertEqual(run.call_args.kwargs["timeout"], .75)


if __name__ == "__main__":
    unittest.main()
