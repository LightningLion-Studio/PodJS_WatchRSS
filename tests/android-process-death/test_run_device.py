"""Offline coordinator regressions: synthetic evidence and an in-memory ADB double.

These tests never start ADB, connect to a device, or prove actual process death.
"""

import argparse
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent
FIXTURE_SPEC = importlib.util.spec_from_file_location("coordinator_probe_fixtures", ROOT / "test_probe.py")
fixtures = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(fixtures)
RUN_SPEC = importlib.util.spec_from_file_location("coordinator_under_test", ROOT / "run_device.py")
device = importlib.util.module_from_spec(RUN_SPEC)
with mock.patch.dict(sys.modules, {"probe": fixtures.probe}):
    RUN_SPEC.loader.exec_module(device)
probe = device.probe

HASHES = {package: digit * 64 for package, digit in zip(device.PACKAGES, "abcd")}
ORIGINAL_KV = b'{"existingArticles":["keep me"],"revision":23}\n'


def ownership_receipt():
    return {"packages": {name: HASHES[name] for name in (device.PACKAGE, device.TEST_PACKAGE)},
            "formalBefore": {name: HASHES[name] for name in device.FORMAL}}


class FakeAdb:
    """Only known reads and private publications are modeled; unknown calls fail."""

    def __init__(self, serial, user, log_dir):
        self.serial, self.user, self.log_dir = serial, user, Path(log_dir)
        self.hashes = dict(HASHES)
        self.uid = user * 100000 + 10123
        self.files = {device.KV_PATH: ORIGINAL_KV, "files/untouched.bin": b"preserve-other-data"}
        self.process_lists = ["PID UID NAME\n"]
        self.instrumentation_dump = "ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)\n"
        self.calls = []
        self.writes = []
        self.on_write = None
        self.on_run = None
        self.after_backup = None
        self.on_command = None
        self.fail_write = False
        self.invalid_backup = False

    def apk_path(self, package):
        return "/data/app/~~fixture/" + package + "-fixture/base.apk"

    def run(self, argv, *, data=None, allowed=(0,), backup=False):
        self.calls.append(("run", list(argv)))
        if self.on_run is not None:
            self.on_run(self, argv)
        if argv == ["getprop", "ro.build.version.sdk"]:
            return b"30\n"
        if argv == ["am", "get-current-user"]:
            return str(self.user).encode() + b"\n"
        if argv == ["dumpsys", "activity", "-a", "processes", device.PACKAGE]:
            return self.instrumentation_dump.encode()
        if argv[:3] == ["pm", "path", "--user"]:
            assert argv[3] == str(self.user) and argv[4] in device.PACKAGES
            return ("package:" + self.apk_path(argv[4]) + "\n").encode()
        if argv[0] == "sha256sum":
            package = next(name for name in device.PACKAGES if self.apk_path(name) == argv[1])
            return (self.hashes[package] + "  " + argv[1] + "\n").encode()
        if argv == ["ps", "-A", "-o", "PID,UID,NAME"]:
            result = self.process_lists[0]
            if len(self.process_lists) > 1:
                self.process_lists.pop(0)
            return result.encode()
        if argv == ["dumpsys", "activity", "-a", device.COMPONENT]:
            return fixtures.dump().encode()
        raise AssertionError("Unexpected or mutating ADB argv in offline test: " + repr(argv))

    def shell(self, script, *arguments, data=None, backup=False):
        self.calls.append(("shell", script, arguments, data, backup))
        if script == "id -u":
            return str(self.uid).encode() + b"\n"
        if backup:
            archive = self.log_dir / ("fake-backup-" + str(len(self.calls)) + ".tar")
            if self.invalid_backup:
                archive.write_bytes(b"not a tar archive")
            else:
                with tarfile.open(archive, "w") as output:
                    for name, raw in self.files.items():
                        member = tarfile.TarInfo(name)
                        member.size = len(raw)
                        output.addfile(member, io.BytesIO(raw))
            if self.after_backup is not None:
                self.after_backup(self)
            return str(archive).encode()
        if data is not None:
            if len(arguments) == 2 and arguments[0].startswith(device.CONTROL + "/command-"):
                assert arguments[1].startswith(device.CONTROL + "/acks/")
                assert self.on_command is not None, "A command fixture must supply a deterministic acknowledgement"
                self.writes.append((device.CONTROL + "/command.json", data))
                self.on_command(self, json.loads(data))
                return b""
            assert len(arguments) == 3, "Only prepare publications are modeled here"
            destination = arguments[0]
            assert destination in (device.KV_PATH, device.CONTROL + "/config.json")
            if self.on_write is not None:
                self.on_write(self, destination, data)
            self.writes.append((destination, data))
            self.files[destination] = data
            if self.fail_write:
                raise probe.EvidenceError("Injected response loss after private write; outcome unknown")
            return b""
        if arguments and "PRESENT" in script and "ABSENT" in script:
            raw = self.files.get(arguments[0])
            return b"ABSENT\n" if raw is None else b"PRESENT\n" + raw
        if script == 'test ! -e "$1" && test ! -L "$1"' and arguments == (device.CONTROL,):
            if any(name.startswith(device.CONTROL + "/") for name in self.files):
                raise probe.EvidenceError("Control directory already exists")
            return b""
        raise AssertionError("Unexpected private shell call in offline test: " + repr((script, arguments)))


class CoordinatorOfflineTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="watchrss-coordinator-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.receipt = self.directory / "ownership.json"
        self.receipt.write_bytes(device.encoded(ownership_receipt()))
        self.transport = []
        lock_patch = mock.patch.object(device, "LOCK_ROOT", self.directory / "shared-device-locks")
        lock_patch.start()
        self.addCleanup(lock_patch.stop)
        # An omitted test double or an accidental subprocess call must fail locally.
        subprocess_patch = mock.patch.object(device.subprocess, "run", side_effect=AssertionError("Real subprocess forbidden in offline tests"))
        subprocess_patch.start()
        self.addCleanup(subprocess_patch.stop)

    def args(self, mode="prepare", output="run"):
        return argparse.Namespace(serial="offline-serial", user=0, receipt=str(self.receipt),
                                  out=str(self.directory / output), mode=mode)

    def factory(self, *arguments):
        transport = FakeAdb(*arguments)
        self.transport.append(transport)
        return transport

    def coordinator(self, mode="prepare", output="run"):
        result = device.Coordinator(self.args(mode, output), adb_factory=self.factory)
        self.addCleanup(result.close)
        return result

    def running_fixture(self, coordinator, status="ok", change_payload=None):
        """Supply a resumed synthetic guest, then acknowledge its first command."""
        events = copy.deepcopy(fixtures.fixture()["events"][:4])
        for event in events:
            event["runNonce"] = coordinator.state["runNonce"]
        config = device.encoded({"version": 1, "packageName": device.PACKAGE,
                                 "runNonce": coordinator.state["runNonce"]})
        (coordinator.root / "config.json").write_bytes(config)
        coordinator.adb.files[device.CONTROL + "/config.json"] = config
        coordinator.adb.files[device.KV_PATH] = b"{}"
        coordinator.adb.files[device.CONTROL + "/lifecycle.jsonl"] = b"".join(map(device.encoded, events))
        coordinator.adb.process_lists = [f"PID UID NAME\n101 10123 {device.PACKAGE}\n"]
        coordinator.state.update(phase="running", expectedKv=dict(fixtures.BASELINE),
                                 initialIdentity=[coordinator.state["runNonce"], 101, fixtures.OLD])
        coordinator.save()

        def respond(transport, command):
            ack = fixtures.receipt(command["op"], command["id"])
            ack.update(runNonce=command["runNonce"], status=status)
            if status != "ok":
                ack.pop("value")
                ack["error"] = "Synthetic durable failure; effect is not proven absent"
            elif change_payload is not None:
                change_payload(ack["value"])
            transport.files[device.CONTROL + "/claims/" + command["id"] + ".json"] = device.encoded(command)
            transport.files[device.CONTROL + "/acks/" + command["id"] + ".json"] = device.encoded(ack)
            events.append(fixtures.event("commandAcknowledged", 5, id=command["id"], op=command["op"],
                                         status=status, runNonce=command["runNonce"]))
            transport.files[device.CONTROL + "/lifecycle.jsonl"] = b"".join(map(device.encoded, events))

        coordinator.adb.on_command = respond
        return events

    def test_receipt_requires_all_four_exact_packages_and_rejects_main_before(self):
        incomplete = ownership_receipt()
        del incomplete["packages"][device.TEST_PACKAGE]
        legacy = ownership_receipt()
        legacy["mainBefore"] = legacy.pop("formalBefore")
        missing_formal = ownership_receipt()
        del missing_formal["formalBefore"][device.FORMAL[1]]
        extra = ownership_receipt()
        extra["packages"]["unrelated.package"] = "f" * 64
        for index, value in enumerate((incomplete, legacy, missing_formal, extra)):
            with self.subTest(index=index):
                self.receipt.write_bytes(device.encoded(value))
                factory = mock.Mock(side_effect=AssertionError("Invalid receipt reached transport construction"))
                with self.assertRaises(probe.EvidenceError):
                    device.Coordinator(self.args(output=str(index)), adb_factory=factory)
                factory.assert_not_called()
                self.assertFalse((self.directory / str(index)).exists())

    def test_receipt_normalizes_sha_lines_and_current_wrapper_without_fallback(self):
        value = ownership_receipt()
        for section in ("packages", "formalBefore"):
            for package in value[section]:
                value[section][package] += "  /data/app/~~fixture/" + package + "/base.apk"
        self.assertEqual(device.receipt_hashes(value), HASHES)
        self.assertEqual(device.receipt_hashes({"current": value}), HASHES)
        invalid = ownership_receipt()
        invalid["current"] = {}
        with self.assertRaises(probe.EvidenceError):
            device.receipt_hashes(invalid)
        for bad_hash in ("a" * 63, "a" * 65, "A" * 64, {"sha256": "a" * 64},
                         "a" * 64 + " /data/app/test/base.apk", "a" * 64 + "  /data/app/test/split.apk"):
            with self.subTest(hash=bad_hash):
                invalid = ownership_receipt()
                invalid["packages"][device.PACKAGE] = bad_hash
                with self.assertRaises(probe.EvidenceError):
                    device.receipt_hashes(invalid)

    def test_each_installed_package_hash_mismatch_prevents_every_mutation(self):
        for index, package in enumerate(device.PACKAGES):
            with self.subTest(package=package), contextlib.closing(self.coordinator(output="mismatch-" + str(index))) as coordinator:
                coordinator.adb.hashes[package] = "f" * 64
                effect = mock.Mock()
                proof = mock.Mock()
                with self.assertRaisesRegex(probe.EvidenceError, "SHA-256 mismatch"):
                    coordinator.mutate("must-never-run", effect, proof)
                effect.assert_not_called()
                proof.assert_not_called()
                self.assertEqual(coordinator.adb.writes, [])
                self.assertIsNone(coordinator.state["pending"])
                self.assertIsNone(json.loads((coordinator.root / "run.json").read_text())["pending"])

    def test_prepare_refuses_existing_output_without_touching_it(self):
        output = self.directory / "existing"
        output.mkdir()
        marker = output / "keep.bin"
        marker.write_bytes(b"original output")
        with self.assertRaisesRegex(probe.EvidenceError, "existing output"):
            device.Coordinator(self.args(output="existing"), adb_factory=self.factory)
        self.assertEqual(marker.read_bytes(), b"original output")
        self.assertEqual(sorted(path.name for path in output.iterdir()), ["keep.bin"])
        self.assertEqual(self.transport, [])

    def test_receipt_changed_during_step_is_rejected_before_transport_reads(self):
        coordinator = self.coordinator()
        self.receipt.write_bytes(self.receipt.read_bytes() + b"\n")
        with self.assertRaisesRegex(probe.EvidenceError, "receipt changed"):
            coordinator.ownership()
        self.assertEqual(coordinator.adb.calls, [])
        self.assertEqual(coordinator.adb.writes, [])

    def test_same_device_user_cannot_open_a_second_output_until_lock_is_released(self):
        first = self.coordinator(output="first")
        with self.assertRaisesRegex(probe.EvidenceError, "run or device/user lock"):
            device.Coordinator(self.args(output="competing"), adb_factory=self.factory)
        self.assertEqual(len(self.transport), 1)
        first.close()
        following = self.coordinator(output="after-release")
        self.assertEqual(len(self.transport), 2)
        self.assertEqual(following.adb.writes, [])

    def test_active_instrumentation_or_unknown_dump_prevents_effect(self):
        for index, dump in enumerate(("unknown ActivityManager response\n",
                "ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)\nActive instrumentation:\n")):
            with self.subTest(dump=dump), contextlib.closing(self.coordinator(output="instrumentation-" + str(index))) as coordinator:
                coordinator.adb.instrumentation_dump = dump
                effect = mock.Mock()
                with self.assertRaisesRegex(probe.EvidenceError, "instrumentation"):
                    coordinator.mutate("blocked-by-instrumentation", effect, mock.Mock())
                effect.assert_not_called()
                self.assertIsNone(coordinator.state["pending"])
                self.assertEqual(coordinator.adb.writes, [])

    def test_rejected_changed_receipt_releases_lock_for_read_only_reopen(self):
        original = self.receipt.read_bytes()
        first = device.Coordinator(self.args(), adb_factory=self.factory)
        first.close()
        self.receipt.write_bytes(original + b"\n")
        transport_count = len(self.transport)
        with self.assertRaisesRegex(probe.EvidenceError, "ownership receipt changed"):
            device.Coordinator(self.args("collect"), adb_factory=self.factory)
        self.assertEqual(len(self.transport), transport_count)
        self.receipt.write_bytes(original)
        reopened = self.coordinator("collect")
        self.assertEqual(reopened.state["receiptSha256"], device.digest(original))
        self.assertEqual(reopened.adb.writes, [])

    def test_uncertain_effect_keeps_durable_pending_and_cannot_replay(self):
        coordinator = self.coordinator()
        calls = []
        proof = mock.Mock()

        def effect():
            pending = json.loads((coordinator.root / "run.json").read_text())["pending"]
            self.assertEqual(pending["label"], "uncertain-write")
            self.assertEqual(set(pending["ownership"]["packages"]), set(device.PACKAGES))
            calls.append("effect")
            raise probe.EvidenceError("Injected failure after effect may have occurred")

        with self.assertRaisesRegex(probe.EvidenceError, "Injected failure"):
            coordinator.mutate("uncertain-write", effect, proof)
        proof.assert_not_called()
        self.assertEqual(calls, ["effect"])
        self.assertEqual(coordinator.state["pending"]["outcome"], "unknown-until-proof")
        reads_before_retry = len(coordinator.adb.calls)
        with self.assertRaisesRegex(probe.EvidenceError, "already pending"):
            coordinator.mutate("uncertain-write", effect, proof)
        self.assertEqual(len(coordinator.adb.calls), reads_before_retry)
        self.assertEqual(calls, ["effect"])

    def test_failed_proof_does_not_clear_pending_or_repeat_effect(self):
        coordinator = self.coordinator()
        effect = mock.Mock()
        proof = mock.Mock(side_effect=probe.EvidenceError("Cannot prove durable completion"))
        with self.assertRaisesRegex(probe.EvidenceError, "Cannot prove"):
            coordinator.mutate("write-with-missing-ack", effect, proof)
        self.assertEqual(effect.call_count, 1)
        self.assertEqual(proof.call_count, 1)
        self.assertEqual(json.loads((coordinator.root / "run.json").read_text())["pending"]["label"],
                         "write-with-missing-ack")
        with self.assertRaises(probe.EvidenceError):
            coordinator.mutate("write-with-missing-ack", effect, proof)
        self.assertEqual(effect.call_count, 1)

    def test_durable_error_or_interrupted_ack_is_saved_without_retry_or_pending_clear(self):
        for status in ("error", "interrupted"):
            with self.subTest(status=status), contextlib.closing(self.coordinator(output="terminal-" + status)) as coordinator:
                events = self.running_fixture(coordinator, status=status)
                command = probe.command(events, "snapshot")
                on_success = mock.Mock()
                with mock.patch.object(device.time, "monotonic", return_value=0), \
                        mock.patch.object(device.time, "sleep", side_effect=AssertionError("Terminal ack was retried")) as sleep:
                    with self.assertRaisesRegex(device.TerminalCommandError, "Durable " + status):
                        coordinator.submit(command, on_success)
                sleep.assert_not_called()
                on_success.assert_not_called()
                ack_path = device.CONTROL + "/acks/" + command["id"] + ".json"
                reads = [call for call in coordinator.adb.calls
                         if call[0] == "shell" and call[2] == (ack_path,) and call[3] is None]
                self.assertEqual(len(reads), 1)
                self.assertEqual(len(coordinator.adb.writes), 1)
                durable = json.loads((coordinator.root / "run.json").read_text())
                self.assertEqual(durable["pending"]["outcome"], "terminal-error-effect-unverified")
                self.assertEqual(durable["latestCommand"], command)
                stored_ack = json.loads((coordinator.root / durable["latestAck"]).read_text())
                self.assertEqual(stored_ack["status"], status)
                self.assertEqual(stored_ack["id"], command["id"])
                claim_files = list(coordinator.step.glob("*-claim.json"))
                self.assertEqual(len(claim_files), 1)
                self.assertEqual(json.loads(claim_files[0].read_text()), command)
                self.assertEqual(list(coordinator.step.glob("*-mutation-completed.json")), [])
                self.assertNotIn("latestSnapshot", durable)
                with self.assertRaisesRegex(probe.EvidenceError, "already pending"):
                    coordinator.submit(command, on_success)
                self.assertEqual(len(coordinator.adb.writes), 1)

    def test_missing_or_invalid_snapshot_token_cannot_commit_snapshot_success(self):
        for label, change in (("missing", lambda value: value.pop("snapshotToken")),
                              ("invalid", lambda value: value.update(snapshotToken="NOT-A-VALID-TOKEN"))):
            with self.subTest(token=label), contextlib.closing(self.coordinator(output="snapshot-token-" + label)) as coordinator:
                self.running_fixture(coordinator, change_payload=change)
                with mock.patch.object(device.time, "monotonic", side_effect=[0, 16]), \
                        mock.patch.object(device.time, "sleep", side_effect=AssertionError("Offline deadline should already have expired")) as sleep:
                    with self.assertRaisesRegex(probe.EvidenceError, "snapshotToken"):
                        coordinator.snapshot()
                sleep.assert_not_called()
                self.assertEqual(len(coordinator.adb.writes), 1)
                durable = json.loads((coordinator.root / "run.json").read_text())
                self.assertIsNotNone(durable["pending"])
                self.assertEqual(durable["pending"]["outcome"], "unknown-until-proof")
                self.assertEqual(durable["phase"], "running")
                self.assertNotIn("latestSnapshot", coordinator.state)
                self.assertNotIn("latestSnapshot", durable)
                self.assertEqual(len(list(coordinator.step.glob("*-ack.json"))), 1)
                self.assertEqual(list(coordinator.step.glob("*-mutation-completed.json")), [])

        # A well-formed response reaches the success callback and durable commit.
        with contextlib.closing(self.coordinator(output="snapshot-token-valid")) as coordinator:
            self.running_fixture(coordinator)
            with mock.patch.object(device.time, "sleep", side_effect=AssertionError("Valid ack was not accepted")):
                ack, path = coordinator.snapshot()
            durable = json.loads((coordinator.root / "run.json").read_text())
            self.assertEqual(ack["value"]["snapshotToken"], "d" * 32)
            self.assertEqual(durable["latestSnapshot"], path)
            self.assertIsNone(durable["pending"])
            self.assertEqual(len(list(coordinator.step.glob("*-mutation-completed.json"))), 1)

    def test_persisted_pending_refuses_mutating_reopen_but_allows_collect(self):
        first = device.Coordinator(self.args(), adb_factory=self.factory)
        try:
            with self.assertRaises(probe.EvidenceError):
                first.mutate("unresolved", mock.Mock(side_effect=probe.EvidenceError("lost response")), mock.Mock())
            pending = copy.deepcopy(first.state["pending"])
        finally:
            first.close()
        transports_before = len(self.transport)
        with self.assertRaisesRegex(probe.EvidenceError, "only collect"):
            device.Coordinator(self.args("start"), adb_factory=self.factory)
        self.assertEqual(len(self.transport), transports_before)
        collector = self.coordinator("collect")
        result = collector.collect()
        self.assertEqual(result["status"], "collected-read-only")
        self.assertEqual(result["pending"], pending)
        self.assertEqual(collector.state["pending"], pending)
        self.assertEqual(collector.adb.writes, [])

    def test_prepare_backs_up_whole_private_data_and_original_kv_before_writes(self):
        coordinator = self.coordinator()
        checked_writes = []

        def before_write(transport, destination, raw):
            durable = json.loads((coordinator.root / "run.json").read_text())
            backup = durable["backup"]
            archive = coordinator.root / backup["path"]
            self.assertEqual(device.digest(archive.read_bytes()), backup["sha256"])
            with tarfile.open(archive, "r:") as content:
                self.assertEqual(content.extractfile(device.KV_PATH).read(), ORIGINAL_KV)
                self.assertEqual(content.extractfile("files/untouched.bin").read(), b"preserve-other-data")
            self.assertEqual((coordinator.root / "original-kv.json").read_bytes(), ORIGINAL_KV)
            self.assertEqual(durable["originalKv"], device.observation(ORIGINAL_KV))
            self.assertIsNotNone(durable["pending"])
            checked_writes.append(destination)

        coordinator.adb.on_write = before_write
        result = coordinator.prepare()
        self.assertEqual(result["status"], "prepared")
        self.assertEqual(checked_writes, [device.KV_PATH, device.CONTROL + "/config.json"])
        self.assertEqual(coordinator.adb.files["files/untouched.bin"], b"preserve-other-data")
        self.assertEqual(result["expectedKv"], device.observation(coordinator.adb.files[device.KV_PATH]))
        self.assertIsNone(coordinator.state["pending"])
        durable = json.loads((coordinator.root / "run.json").read_text())
        self.assertEqual(durable["phase"], "prepared")
        self.assertIsNone(durable["pending"])
        self.assertEqual(json.loads(coordinator.adb.files[device.CONTROL + "/config.json"])["runNonce"],
                         coordinator.state["runNonce"])

    def test_prepare_refuses_running_target_or_test_before_backup_and_writes(self):
        for index, name in enumerate((device.PACKAGE, device.TEST_PACKAGE + ":runner")):
            with self.subTest(name=name), contextlib.closing(self.coordinator(output="running-" + str(index))) as coordinator:
                coordinator.adb.process_lists = [f"PID UID NAME\n123 10123 {name}\n"]
                with self.assertRaisesRegex(probe.EvidenceError, "running process"):
                    coordinator.prepare()
                self.assertEqual(coordinator.adb.writes, [])
                self.assertNotIn("backup", coordinator.state)
                self.assertIsNone(coordinator.state["pending"])

    def test_prepare_rechecks_process_absence_after_backup_before_first_write(self):
        coordinator = self.coordinator()
        coordinator.adb.process_lists = ["PID UID NAME\n", f"PID UID NAME\n123 10123 {device.PACKAGE}\n"]
        with self.assertRaisesRegex(probe.EvidenceError, "running process"):
            coordinator.prepare()
        self.assertIn("backup", coordinator.state)
        self.assertEqual(coordinator.adb.writes, [])
        self.assertIsNone(coordinator.state["pending"])

    def test_prepare_invalid_backup_or_unknown_write_never_replays(self):
        with contextlib.closing(self.coordinator(output="bad-backup")) as bad_backup:
            bad_backup.adb.invalid_backup = True
            with self.assertRaises(tarfile.TarError):
                bad_backup.prepare()
            self.assertEqual(bad_backup.adb.writes, [])

        failed_write = self.coordinator(output="failed-write")
        failed_write.adb.fail_write = True
        with self.assertRaisesRegex(probe.EvidenceError, "outcome unknown"):
            failed_write.prepare()
        self.assertEqual(len(failed_write.adb.writes), 1)
        self.assertEqual(failed_write.adb.writes[0][0], device.KV_PATH)
        self.assertEqual((failed_write.root / "original-kv.json").read_bytes(), ORIGINAL_KV)
        self.assertEqual(failed_write.state["pending"]["label"], "prepare-seed")
        forbidden = mock.Mock()
        with self.assertRaisesRegex(probe.EvidenceError, "already pending"):
            failed_write.mutate("prepare-seed", forbidden, mock.Mock())
        forbidden.assert_not_called()
        self.assertEqual(len(failed_write.adb.writes), 1)

    def test_prepare_rejects_kv_changed_after_backup_or_between_publications(self):
        with contextlib.closing(self.coordinator(output="backup-race")) as coordinator:
            coordinator.adb.after_backup = lambda transport: transport.files.update({device.KV_PATH: b"changed after backup"})
            with self.assertRaisesRegex(probe.EvidenceError, "differs from its verified app-data backup"):
                coordinator.prepare()
            self.assertEqual(coordinator.adb.writes, [])
            self.assertIsNone(coordinator.state["pending"])

        coordinator = self.coordinator(output="between-writes-race")

        def change_between_writes(transport, argv):
            if argv == ["getprop", "ro.build.version.sdk"] and len(transport.writes) == 1:
                transport.files[device.KV_PATH] = b"external change between seed and config"

        coordinator.adb.on_run = change_between_writes
        with self.assertRaisesRegex(probe.EvidenceError, "KV changed"):
            coordinator.prepare()
        self.assertEqual(len(coordinator.adb.writes), 1)
        self.assertNotIn(device.CONTROL + "/config.json", coordinator.adb.files)
        self.assertEqual(coordinator.state["phase"], "seed-written")
        self.assertIsNone(coordinator.state["pending"])

    def test_process_parser_filters_only_exact_names_and_rejects_bad_columns(self):
        text = ("PID UID NAME\n"
                f"101 10123 {device.PACKAGE}\n"
                f"102 10123 {device.PACKAGE}:worker\n"
                f"103 10124 {device.TEST_PACKAGE}\n"
                f"104 10124 {device.TEST_PACKAGE}:runner\n"
                f"105 20123 {device.PACKAGE}.other\n"
                f"106 20124 {device.TEST_PACKAGE}.other\n"
                "107 0 system_server\n")
        self.assertEqual([row["pid"] for row in device.parse_processes(text)], [101, 102, 103, 104])
        self.assertEqual(device.parse_processes("PID UID NAME\n"), [])
        for malformed in ("UID PID NAME\n", "", "PID UID NAME\n1 u0_a123 irrelevant\n",
                          "PID UID NAME\n1 123 name unexpected\n", "PID UID NAME\n-1 123 name\n",
                          "PID UID NAME\n0 123 name\n", "PID UID NAME\n² 123 name\n",
                          "PID UID NAME\n1 ² name\n", "PID UID NAME\n2147483648 123 name\n",
                          "PID UID NAME\n1 2147483648 name\n"):
            with self.subTest(raw=malformed), self.assertRaises(probe.EvidenceError):
                device.parse_processes(malformed)

    def test_live_process_requires_exact_single_pid_uid_and_default_process(self):
        coordinator = self.coordinator()
        ident = (fixtures.NONCE, 101, fixtures.OLD)
        coordinator.adb.process_lists = [f"PID UID NAME\n101 10123 {device.PACKAGE}\n"]
        coordinator.live_process(ident, 10123)
        for rows in ("", f"102 10123 {device.PACKAGE}\n", f"101 10124 {device.PACKAGE}\n",
                     f"101 10123 {device.PACKAGE}:worker\n", f"101 10123 {device.TEST_PACKAGE}\n",
                     f"101 10123 {device.PACKAGE}\n101 10123 {device.PACKAGE}\n",
                     f"101 10123 {device.PACKAGE}\n102 10124 {device.TEST_PACKAGE}:runner\n"):
            with self.subTest(rows=rows):
                coordinator.adb.process_lists = ["PID UID NAME\n" + rows]
                with self.assertRaisesRegex(probe.EvidenceError, "exactly the owned"):
                    coordinator.live_process(ident, 10123)

    def test_adb_quotes_android_shell_once_and_passes_binary_stdin_separately(self):
        logs = self.directory / "quoted-adb"
        logs.mkdir()
        adb = device.Adb("offline-serial", 7, logs)
        script = 'set -eu\ncat > "$1"\nprintf "%s" "$2"'
        arguments = ("files/a b'c;$(echo never)", '`do-not-run`\\$value')
        payload = b"private\x00bytes\n$(not-shell-code)'\n"
        seen = []

        def fake_subprocess(argv, **options):
            seen.append((argv, options))
            self.assertIs(options["input"], payload)
            self.assertFalse(options.get("shell", False))
            self.assertEqual(argv[:5], ["adb", "-s", "offline-serial", "shell", "-T"])
            self.assertEqual(shlex.split(argv[5]), ["run-as", device.PACKAGE, "--user", "7", "/system/bin/sh",
                                                  "-c", script, "process-death", *arguments])
            self.assertNotIn(payload.decode("utf-8"), " ".join(argv))
            options["stdout"].write(b"received\x00exactly")
            return SimpleNamespace(returncode=0)

        with mock.patch.object(device.subprocess, "run", side_effect=fake_subprocess):
            self.assertEqual(adb.shell(script, *arguments, data=payload), b"received\x00exactly")
        self.assertEqual(len(seen), 1)
        intent = json.loads((logs / "adb-0001.intent.json").read_text())
        self.assertEqual(intent["stdin"], device.observation(payload))
        self.assertEqual(json.loads((logs / "adb-0001.outcome.json").read_text())["returnCode"], 0)

    def test_adb_timeout_records_unknown_outcome_without_retry(self):
        logs = self.directory / "timed-out-adb"
        logs.mkdir()
        adb = device.Adb("offline-serial", 0, logs)
        with mock.patch.object(device.subprocess, "run", side_effect=subprocess.TimeoutExpired("fake adb", 20)) as call:
            with self.assertRaisesRegex(probe.EvidenceError, "do not retry"):
                adb.run(["only-a-fake-command"], data=b"test payload")
        self.assertEqual(call.call_count, 1)
        self.assertEqual(json.loads((logs / "adb-0001.outcome.json").read_text())["outcome"], "timeout-unknown")

    def test_dead_record_requires_same_saved_nonrunning_activity(self):
        value = fixtures.fixture()
        ready = probe.barrier(value["events"], value["background_ack"], value["before"], value["expected_kv"])
        for state in ("STOPPED", "DESTROYED"):
            dead = {**value["dead"], "state": state}
            device.dead_record(dead, ready)
        for field, wrong in (("taskId", 18), ("systemRecord", "other"), ("pid", 101), ("notRunning", False),
                             ("finishing", "true"), ("state", "RESUMED"), ("mHaveState", "false"), ("mIcicle", "null")):
            with self.subTest(field=field), self.assertRaises(probe.EvidenceError):
                device.dead_record({**value["dead"], field: wrong}, ready)

    def test_restored_preboot_accepts_cross_process_activity_hash_reuse(self):
        value = fixtures.fixture()
        ready = probe.barrier(value["events"], value["background_ack"], value["before"], value["expected_kv"])
        self.assertEqual(device.restored_preboot(value["events"], ready, value["recovered"]),
                         (fixtures.NONCE, 201, fixtures.NEW))

    def test_restored_preboot_rejects_incomplete_or_contradictory_proof(self):
        changes = {
            "same PID": lambda value: [event.update(pid=101) for event in value["events"] if event["processInstance"] == fixtures.NEW],
            "wrong task": lambda value: value["events"][10].update(taskId=18),
            "nonconfiguration state": lambda value: value["events"][10].update(lastNonConfigurationPresent=True),
            "different valid Bundle": lambda value: value["events"][10].update(bundle=fixtures.saved_bundle("{}")),
            "guest booted": lambda value: value["events"][11].update(hostBooted=True),
            "saved not restored": lambda value: value["events"][11]["hostState"].update(savedJson="{}"),
            "retained survived": lambda value: value["events"][11]["hostState"].update(retainedJson=fixtures.STATE["retainedJson"]),
            "missing resume": lambda value: value["events"].pop(12),
            "new system record": lambda value: value["recovered"].update(systemRecord="other"),
            "no Activity identity": lambda value: [event.pop("activityInstance", None) for event in value["events"] if event["processInstance"] == fixtures.NEW],
            "extra intermediate process": lambda value: value["events"].insert(9, fixtures.event(
                "processStarted", 1, pid=151, processInstance="d" * 32, uptimeMillis=1500)),
        }
        for label, change in changes.items():
            with self.subTest(label=label):
                value = fixtures.fixture()
                ready = probe.barrier(value["events"], value["background_ack"], value["before"], value["expected_kv"])
                change(value)
                with self.assertRaises(probe.EvidenceError):
                    device.restored_preboot(value["events"], ready, value["recovered"])


if __name__ == "__main__":
    unittest.main()
