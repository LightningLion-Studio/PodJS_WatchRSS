"""Local HTTP fixture regressions; no CLI, ADB, Gradle, or device access.

HTTP checks use an ephemeral loopback listener and real response bodies.  These
tests prove fixture behavior only, not Android restoration or visual parity.
"""

import copy
import datetime as dt
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import queue
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("legal_server_under_test", ROOT / "legal_server.py")
legal = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = legal
SPEC.loader.exec_module(legal)

NONCE = "0123456789abcdef0123456789abcdef"
OTHER_NONCE = "fedcba9876543210fedcba9876543210"
REQUEST_PATH = "/functions/v1/legal/watch/privacy-policy"
MANIFEST_KEYS = {
    "version", "nonce", "pid", "host", "port", "requestPath", "bodyFile",
    "bodyBytes", "bodySha256", "holdTimeoutMs",
}
STATE_KEYS = {"version", "nonce", "pid", "requestCount", "requests", "failure"}
REQUEST_KEYS = {
    "number", "method", "path", "status", "receivedMonotonicNs", "receivedAt",
    "completedMonotonicNs", "completedAt", "httpStatus", "error",
}
RELEASE_KEYS = {
    "version", "nonce", "pid", "request", "path", "bytes", "sha256",
    "manifestSha256", "bodySha256", "publishedMonotonicNs", "publishedAt",
}
PROBES_KEYS = {"version", "nonce", "pid", "probeCount", "probes"}
PROBE_KEYS = {
    "number", "method", "path", "peerAddress", "peerPort", "receivedMonotonicNs", "receivedAt",
}


def encoded(value):
    """Compute the wire representation independently of production helpers."""
    return (json.dumps(value, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=False) + "\n").encode("utf-8")


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


class LegalServerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="watchrss-legal-server-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.servers = []
        self.threads = []
        self.addCleanup(self.close_servers)

    def close_servers(self):
        for server in reversed(self.servers):
            server.close()
        for thread in self.threads:
            thread.join(2)
            self.assertFalse(thread.is_alive(), "Fixture thread did not stop during cleanup")

    def server(self, *, start=True, nonce=NONCE, timeout=10000):
        directory = self.root / ("fixture-" + str(len(self.servers)))
        server = legal.LegalServer(directory, nonce, hold_timeout_ms=timeout)
        self.servers.append(server)
        if start:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            self.threads.append(thread)
            thread.start()
        return server, directory

    def request(self, server, method="GET", path=REQUEST_PATH):
        connection = http.client.HTTPConnection(
            server.manifest["host"], server.manifest["port"], timeout=2)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def background_request(self, server):
        result = queue.Queue()

        def run():
            try:
                result.put((True, self.request(server)))
            except BaseException as error:
                result.put((False, error))

        thread = threading.Thread(target=run, daemon=True)
        self.threads.append(thread)
        thread.start()
        return result

    def response(self, result):
        try:
            ok, value = result.get(timeout=2)
        except queue.Empty:
            self.fail("HTTP fixture request did not finish within two seconds")
        if not ok:
            raise value
        return value

    def state(self, directory, server):
        return legal.read_state(directory, server.manifest)

    def wait_state(self, directory, server, predicate):
        deadline = time.monotonic() + 1.5
        while True:
            state = self.state(directory, server)
            if predicate(state):
                return state
            if time.monotonic() >= deadline:
                self.fail("Expected fixture state was not reached: " + repr(state))
            time.sleep(0.005)

    def first_complete(self, directory, server):
        status, body, headers = self.request(server)
        self.assertEqual(status, 200)
        self.assertEqual(body, (directory / "body.utf8").read_bytes())
        self.wait_state(directory, server, lambda state: (
            state["requestCount"] == 1 and state["requests"][0]["status"] == "complete"))
        return body, headers

    def second_held(self, directory, server):
        result = self.background_request(server)
        self.wait_state(directory, server, lambda state: (
            state["requestCount"] == 2 and state["requests"][1]["status"] == "held"))
        self.assertTrue(result.empty(), "The held request already returned a response")
        return result

    def test_manifest_body_and_initial_state_are_canonical_and_deterministic(self):
        server, directory = self.server(start=False)
        manifest = legal.read_manifest(directory)
        self.assertEqual(set(manifest), MANIFEST_KEYS)
        self.assertEqual(manifest, server.manifest)
        self.assertEqual(manifest["version"], 1)
        self.assertEqual(manifest["nonce"], NONCE)
        self.assertEqual(manifest["pid"], os.getpid())
        self.assertEqual(manifest["host"], "127.0.0.1")
        self.assertTrue(1 <= manifest["port"] <= 65535)
        self.assertEqual(manifest["requestPath"], REQUEST_PATH)
        self.assertEqual(manifest["bodyFile"], "body.utf8")
        self.assertEqual(manifest["holdTimeoutMs"], 10000)
        self.assertEqual((directory / "manifest.json").read_bytes(), encoded(manifest))
        body = (directory / "body.utf8").read_bytes()
        text = body.decode("utf-8", errors="strict")
        self.assertEqual(text, text.strip())
        paragraphs = text.split("\n\n")
        self.assertEqual(len(paragraphs), 32)
        self.assertTrue(all(paragraph.strip() for paragraph in paragraphs))
        self.assertEqual(manifest["bodyBytes"], len(body))
        self.assertEqual(manifest["bodySha256"], sha256(body))
        state = self.state(directory, server)
        self.assertEqual(state, {"version": 1, "nonce": NONCE, "pid": os.getpid(),
                                 "requestCount": 0, "requests": [], "failure": None})
        self.assertEqual((directory / "state.json").read_bytes(), encoded(state))
        _, same_directory = self.server(start=False)
        _, other_directory = self.server(start=False, nonce=OTHER_NONCE)
        self.assertEqual((same_directory / "body.utf8").read_bytes(), body)
        self.assertNotEqual((other_directory / "body.utf8").read_bytes(), body)
        server.close()
        server.close()
        self.assertEqual(self.state(directory, server), state)

    def test_second_request_waits_for_release_and_returns_identical_complete_body(self):
        server, directory = self.server()
        first, _ = self.first_complete(directory, server)
        result = self.second_held(directory, server)
        time.sleep(0.03)
        held = self.state(directory, server)
        self.assertEqual(held["requests"][1]["status"], "held")
        self.assertTrue(result.empty())
        receipt = legal.release_second(directory, server.manifest)
        marker = (directory / "release-2.json").read_bytes()
        self.assertEqual(marker, encoded({"version": 1, "nonce": NONCE, "request": 2}))
        self.assertEqual(set(receipt), RELEASE_KEYS)
        self.assertIs(type(receipt["publishedMonotonicNs"]), int)
        self.assertIsInstance(receipt["publishedAt"], str)
        self.assertEqual(dt.datetime.fromisoformat(receipt["publishedAt"]).utcoffset(), dt.timedelta(0))
        self.assertEqual(receipt, {
            "version": 1, "nonce": NONCE, "pid": os.getpid(), "request": 2,
            "path": "release-2.json", "bytes": len(marker), "sha256": sha256(marker),
            "manifestSha256": sha256((directory / "manifest.json").read_bytes()),
            "bodySha256": sha256(first),
            "publishedMonotonicNs": receipt["publishedMonotonicNs"],
            "publishedAt": receipt["publishedAt"],
        })
        self.assertEqual((directory / "release-2.receipt.json").read_bytes(), encoded(receipt))
        status, second, _ = self.response(result)
        self.assertEqual(status, 200)
        self.assertEqual(second, first)
        state = self.wait_state(directory, server, lambda value: (
            value["requestCount"] == 2 and value["requests"][1]["status"] == "complete"))
        self.assertEqual(set(state), STATE_KEYS)
        self.assertIsNone(state["failure"])
        second_request = state["requests"][1]
        self.assertLess(second_request["receivedMonotonicNs"], receipt["publishedMonotonicNs"])
        self.assertLess(receipt["publishedMonotonicNs"], second_request["completedMonotonicNs"])
        self.assertLess(receipt["publishedMonotonicNs"],
                        second_request["receivedMonotonicNs"] + server.manifest["holdTimeoutMs"] * 1000000)
        for number, request in enumerate(state["requests"], 1):
            self.assertEqual(set(request), REQUEST_KEYS)
            self.assertEqual(request["number"], number)
            self.assertEqual(request["method"], "GET")
            self.assertEqual(request["path"], REQUEST_PATH)
            self.assertEqual(request["status"], "complete")
            self.assertEqual(request["httpStatus"], 200)
            self.assertIsNone(request["error"])
            self.assertGreaterEqual(request["completedMonotonicNs"], request["receivedMonotonicNs"])

    def test_root_get_is_audited_without_changing_legal_requests_or_releasing_hold(self):
        server, directory = self.server()
        initial_probes = {"version": 1, "nonce": NONCE, "pid": os.getpid(),
                          "probeCount": 0, "probes": []}
        self.assertEqual(legal.read_probes(directory, server.manifest), initial_probes)
        self.assertEqual((directory / "root-probes.json").read_bytes(), encoded(initial_probes))
        previous_probes = []
        pending = None
        for phase in ("before-legal-request", "while-second-is-held"):
            with self.subTest(phase=phase):
                if phase == "while-second-is-held":
                    first, _ = self.first_complete(directory, server)
                    pending = self.second_held(directory, server)
                before_state = self.state(directory, server)
                before_raw = (directory / "state.json").read_bytes()
                before_stat = (directory / "state.json").stat()
                connection = http.client.HTTPConnection(
                    server.manifest["host"], server.manifest["port"], timeout=2)
                try:
                    connection.connect()
                    client_address, client_port = connection.sock.getsockname()
                    sent_at = time.monotonic_ns()
                    connection.request("GET", "/")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 404)
                    self.assertEqual(response.read(), b"")
                    self.assertEqual(response.getheader("Content-Length"), "0")
                    returned_at = time.monotonic_ns()
                    # The independent audit must already be published when 404 returns.
                    raw_probes = (directory / "root-probes.json").read_bytes()
                    probes = json.loads(raw_probes)
                finally:
                    connection.close()
                self.assertEqual(set(probes), PROBES_KEYS)
                self.assertEqual(raw_probes, encoded(probes))
                self.assertEqual(legal.read_probes(directory, server.manifest), probes)
                self.assertEqual(probes["version"], 1)
                self.assertEqual(probes["nonce"], NONCE)
                self.assertEqual(probes["pid"], os.getpid())
                self.assertEqual(probes["probeCount"], len(previous_probes) + 1)
                self.assertEqual(probes["probes"][:-1], previous_probes)
                probe = probes["probes"][-1]
                self.assertEqual(set(probe), PROBE_KEYS)
                self.assertEqual(probe["number"], probes["probeCount"])
                self.assertEqual(probe["method"], "GET")
                self.assertEqual(probe["path"], "/")
                self.assertEqual(probe["peerAddress"], client_address)
                self.assertEqual(client_address, "127.0.0.1")
                self.assertEqual(probe["peerPort"], client_port)
                self.assertIs(type(probe["receivedMonotonicNs"]), int)
                self.assertLessEqual(sent_at, probe["receivedMonotonicNs"])
                self.assertLessEqual(probe["receivedMonotonicNs"], returned_at)
                self.assertEqual(dt.datetime.fromisoformat(probe["receivedAt"]).utcoffset(),
                                 dt.timedelta(0))
                self.assertEqual(self.state(directory, server), before_state)
                self.assertEqual((directory / "state.json").read_bytes(), before_raw)
                after_stat = (directory / "state.json").stat()
                self.assertEqual((after_stat.st_ino, after_stat.st_mtime_ns),
                                 (before_stat.st_ino, before_stat.st_mtime_ns))
                self.assertFalse((directory / "release-2.json").exists())
                self.assertFalse((directory / "release-2.receipt.json").exists())
                if pending is not None:
                    self.assertTrue(pending.empty(), "GET / released the held legal request")
                else:
                    self.assertEqual(before_state["requestCount"], 0)
                    with self.assertRaises(legal.FixtureError):
                        legal.release_second(directory, server.manifest)
                previous_probes = probes["probes"]
        legal.release_second(directory, server.manifest)
        status, second, _ = self.response(pending)
        self.assertEqual(status, 200)
        self.assertEqual(second, first)
        finished = self.wait_state(directory, server, lambda value: (
            value["requestCount"] == 2 and value["requests"][1]["status"] == "complete"))
        self.assertIsNone(finished["failure"])
        self.assertEqual(legal.read_probes(directory, server.manifest), probes)

    def test_root_probe_publication_failure_is_503_and_keeps_fixture_failed(self):
        server, directory = self.server()
        first, _ = self.first_complete(directory, server)
        pending = self.second_held(directory, server)
        before_probes = (directory / "root-probes.json").read_bytes()
        original_atomic = legal._atomic

        def fail_probe_publication(directory_fd, name, raw, **options):
            if name == "root-probes.json":
                raise OSError("Injected root-probe audit publication failure")
            return original_atomic(directory_fd, name, raw, **options)

        with mock.patch.object(legal, "_atomic", side_effect=fail_probe_publication):
            status, body, _ = self.request(server, path="/")
        self.assertEqual(status, 503)
        self.assertNotEqual(body, b"")
        self.assertNotEqual(body, first)
        self.assertEqual((directory / "root-probes.json").read_bytes(), before_probes)
        self.assertEqual(legal.read_probes(directory, server.manifest)["probeCount"], 0)
        held_status, held_body, _ = self.response(pending)
        self.assertEqual(held_status, 503)
        self.assertNotEqual(held_body, first)
        failed = self.wait_state(directory, server, lambda value: (
            value["requestCount"] == 2 and value["requests"][1]["status"] == "failed"))
        self.assertEqual(failed["failure"], "root_probe_audit_failed")
        self.assertEqual(failed["requests"][0]["status"], "complete")
        self.assertFalse((directory / "release-2.json").exists())
        self.assertFalse((directory / "release-2.receipt.json").exists())
        with self.assertRaises(legal.FixtureError):
            legal.release_second(directory, server.manifest)
        # A later successfully audited root probe cannot erase the sticky failure.
        status, body, _ = self.request(server, path="/")
        self.assertEqual((status, body), (404, b""))
        self.assertEqual(self.state(directory, server), failed)
        self.assertEqual(legal.read_probes(directory, server.manifest)["probeCount"], 1)
        self.assertEqual(self.request(server)[0], 503)
        self.wait_state(directory, server, lambda value: (
            value["requestCount"] == 3 and value["requests"][2]["status"] == "failed"))

    def test_marker_published_at_deadline_is_preserved_without_success_receipt(self):
        """Use a synthetic held state to isolate publication timing without a live clock race."""
        server, directory = self.server(start=False)
        received = 1000000000
        timestamp = "2026-09-20T00:00:00+00:00"
        state = self.state(directory, server)
        state["requestCount"] = 2
        state["requests"] = [
            {"number": 1, "method": "GET", "path": REQUEST_PATH, "status": "complete",
             "receivedMonotonicNs": received - 3, "receivedAt": timestamp,
             "completedMonotonicNs": received - 2, "completedAt": timestamp,
             "httpStatus": 200, "error": None},
            {"number": 2, "method": "GET", "path": REQUEST_PATH, "status": "held",
             "receivedMonotonicNs": received, "receivedAt": timestamp,
             "completedMonotonicNs": None, "completedAt": None,
             "httpStatus": None, "error": None},
        ]
        (directory / "state.json").write_bytes(encoded(state))
        self.assertEqual(self.state(directory, server), state)
        deadline = received + server.manifest["holdTimeoutMs"] * 1000000
        clock = {"now": deadline - 1}
        original_atomic = legal._atomic
        publications = []

        def delayed_atomic(directory_fd, name, raw, **options):
            original_atomic(directory_fd, name, raw, **options)
            publications.append(name)
            if name == "release-2.json":
                clock["now"] = deadline

        with mock.patch.object(legal.time, "monotonic_ns", side_effect=lambda: clock["now"]), \
                mock.patch.object(legal, "_atomic", side_effect=delayed_atomic):
            with self.assertRaisesRegex(legal.FixtureError, "publication exceeded hold deadline"):
                legal.release_second(directory, server.manifest)
        marker = (directory / "release-2.json").read_bytes()
        self.assertEqual(marker, encoded({"version": 1, "nonce": NONCE, "request": 2}))
        self.assertEqual(publications, ["release-2.json"])
        self.assertFalse((directory / "release-2.receipt.json").exists())
        self.assertEqual(self.state(directory, server), state)
        with self.assertRaises(legal.FixtureError):
            legal.release_second(directory, server.manifest)
        self.assertEqual((directory / "release-2.json").read_bytes(), marker)
        self.assertFalse((directory / "release-2.receipt.json").exists())

    def test_release_requires_two_requests_and_a_live_recorded_process(self):
        server, directory = self.server()
        for phase in ("before-first", "after-first"):
            with self.subTest(phase=phase):
                with self.assertRaises(legal.FixtureError):
                    legal.release_second(directory, server.manifest)
                self.assertFalse((directory / "release-2.json").exists())
            if phase == "before-first":
                self.first_complete(directory, server)
        result = self.second_held(directory, server)
        with mock.patch.object(legal.os, "kill", side_effect=ProcessLookupError("No such process")):
            with self.assertRaises(legal.FixtureError):
                legal.release_second(directory, server.manifest)
        self.assertFalse((directory / "release-2.json").exists())
        legal.release_second(directory, server.manifest)
        self.assertEqual(self.response(result)[0], 200)
        self.wait_state(directory, server, lambda state: state["requests"][1]["status"] == "complete")

    def test_expiry_and_shutdown_fail_held_request_with_503_and_prevent_release(self):
        for reason in ("deadline", "shutdown"):
            with self.subTest(reason=reason):
                server, directory = self.server(timeout=150 if reason == "deadline" else 10000)
                self.first_complete(directory, server)
                result = self.second_held(directory, server)
                if reason == "shutdown":
                    server.close()
                status, body, _ = self.response(result)
                self.assertEqual(status, 503)
                self.assertNotEqual(body, (directory / "body.utf8").read_bytes())
                state = self.wait_state(directory, server, lambda value: value["requests"][1]["status"] == "failed")
                self.assertTrue(state["failure"])
                self.assertEqual(state["requests"][1]["httpStatus"], 503)
                self.assertTrue(state["requests"][1]["error"])
                self.assertIsNotNone(state["requests"][1]["completedMonotonicNs"])
                with self.assertRaises(legal.FixtureError):
                    legal.release_second(directory, server.manifest)
                self.assertFalse((directory / "release-2.json").exists())

    def test_unexpected_method_path_or_third_request_causes_sticky_failure(self):
        scenarios = (
            ("wrong-method", "POST", REQUEST_PATH),
            ("wrong-path", "GET", REQUEST_PATH + "?unexpected=1"),
            ("unrelated-path", "GET", "/unexpected"),
            ("root-head", "HEAD", "/"),
            ("root-post", "POST", "/"),
            ("root-query", "GET", "/?unexpected=1"),
            ("double-root", "GET", "//"),
            ("triple-root", "GET", "///"),
            ("double-legal", "GET", "/" + REQUEST_PATH),
            ("third-request", "GET", REQUEST_PATH),
        )
        for scenario, method, path in scenarios:
            with self.subTest(scenario=scenario):
                server, directory = self.server()
                if scenario == "third-request":
                    self.first_complete(directory, server)
                    pending = self.second_held(directory, server)
                    legal.release_second(directory, server.manifest)
                    self.assertEqual(self.response(pending)[0], 200)
                    self.wait_state(directory, server, lambda state: state["requests"][1]["status"] == "complete")
                status, _, _ = self.request(server, method, path)
                self.assertEqual(status, 503)
                failed = self.wait_state(directory, server, lambda state: (
                    bool(state["failure"]) and state["requests"][-1]["status"] == "failed"))
                failure = failed["failure"]
                self.assertEqual(failed["requests"][-1]["status"], "failed")
                self.assertEqual(failed["requests"][-1]["method"], method)
                self.assertEqual(failed["requests"][-1]["path"], path)
                self.assertEqual(self.request(server)[0], 503)
                state = self.wait_state(directory, server, lambda value: value["requests"][-1]["status"] == "failed")
                self.assertEqual(state["failure"], failure)
                with self.assertRaises(legal.FixtureError):
                    legal.release_second(directory, server.manifest)
                self.assertEqual(legal.read_probes(directory, server.manifest)["probeCount"], 0)

    def test_stale_expected_manifest_identity_is_rejected(self):
        server, directory = self.server(start=False)
        for field, value in (("nonce", OTHER_NONCE), ("pid", os.getpid() + 100000),
                             ("holdTimeoutMs", 9999)):
            with self.subTest(field=field):
                expected = dict(server.manifest, **{field: value})
                with self.assertRaises(legal.FixtureError):
                    legal.read_state(directory, expected)
                with self.assertRaises(legal.FixtureError):
                    legal.release_second(directory, expected)
        self.assertFalse((directory / "release-2.json").exists())

    def test_malformed_manifest_is_rejected_by_both_readers(self):
        server, directory = self.server(start=False)
        manifest_file = directory / "manifest.json"
        original = manifest_file.read_bytes()
        missing = dict(server.manifest)
        del missing["port"]
        variants = {
            "invalid-json": b"{\n", "noncanonical": json.dumps(server.manifest).encode(),
            "missing-field": encoded(missing),
            "unknown-field": encoded(dict(server.manifest, unexpected=True)),
            "boolean-port": encoded(dict(server.manifest, port=True)),
            "wrong-host": encoded(dict(server.manifest, host="0.0.0.0")),
            "bad-hash": encoded(dict(server.manifest, bodySha256="0" * 64)),
            "wrong-body-length": encoded(dict(server.manifest, bodyBytes=1)),
        }
        for name, raw in variants.items():
            with self.subTest(case=name):
                manifest_file.write_bytes(raw)
                try:
                    with self.assertRaises(legal.FixtureError):
                        legal.read_manifest(directory)
                    with self.assertRaises(legal.FixtureError):
                        self.state(directory, server)
                finally:
                    manifest_file.write_bytes(original)

    def test_body_changes_and_malformed_state_serialization_are_rejected(self):
        server, directory = self.server(start=False)
        body_file = directory / "body.utf8"
        original_body = body_file.read_bytes()
        for raw in (original_body + b"\n", b"\xff", b""):
            with self.subTest(body_bytes=len(raw)):
                body_file.write_bytes(raw)
                try:
                    with self.assertRaises(legal.FixtureError):
                        legal.read_manifest(directory)
                    with self.assertRaises(legal.FixtureError):
                        self.state(directory, server)
                finally:
                    body_file.write_bytes(original_body)
        manifest_file = directory / "manifest.json"
        original_manifest = manifest_file.read_bytes()
        forged_body = b"Substituted body with a matching declared length and hash"
        body_file.write_bytes(forged_body)
        manifest_file.write_bytes(encoded(dict(server.manifest, bodyBytes=len(forged_body),
                                              bodySha256=sha256(forged_body))))
        try:
            with self.assertRaises(legal.FixtureError):
                legal.read_manifest(directory)
            with self.assertRaises(legal.FixtureError):
                self.state(directory, server)
        finally:
            body_file.write_bytes(original_body)
            manifest_file.write_bytes(original_manifest)
        state_file = directory / "state.json"
        original_state = state_file.read_bytes()
        for raw in (b"{\n", b"[]\n", b"\xff", json.dumps(json.loads(original_state)).encode()):
            with self.subTest(state_bytes=raw[:40]):
                state_file.write_bytes(raw)
                try:
                    with self.assertRaises(legal.FixtureError):
                        self.state(directory, server)
                finally:
                    state_file.write_bytes(original_state)

    def test_manifest_body_and_state_reject_symlinks_and_hardlinks(self):
        server, directory = self.server(start=False)
        for filename in ("manifest.json", "body.utf8", "state.json"):
            path = directory / filename
            original = path.read_bytes()
            target = self.root / ("external-" + filename)
            target.write_bytes(original)
            for kind in ("symlink", "hardlink"):
                with self.subTest(file=filename, link=kind):
                    path.unlink()
                    if kind == "symlink":
                        path.symlink_to(target)
                    else:
                        os.link(target, path)
                    try:
                        if filename != "state.json":
                            with self.assertRaises(legal.FixtureError):
                                legal.read_manifest(directory)
                        with self.assertRaises(legal.FixtureError):
                            self.state(directory, server)
                        with self.assertRaises(legal.FixtureError):
                            legal.release_second(directory, server.manifest)
                        self.assertEqual(target.read_bytes(), original)
                    finally:
                        path.unlink()
                        path.write_bytes(original)

    def test_existing_output_is_untouched_and_invalid_arguments_are_rejected(self):
        directory = self.root / "existing"
        directory.mkdir()
        sentinel = directory / "keep.bin"
        sentinel.write_bytes(b"existing user evidence\x00")
        for candidate in (directory, self.root / "directory-link"):
            if candidate != directory:
                candidate.symlink_to(directory, target_is_directory=True)
            with self.subTest(output=candidate.name):
                with self.assertRaises(legal.FixtureError):
                    legal.LegalServer(candidate, NONCE)
                self.assertEqual(sentinel.read_bytes(), b"existing user evidence\x00")
                self.assertEqual({item.name for item in directory.iterdir()}, {"keep.bin"})
        for index, (nonce, timeout) in enumerate((("not-a-nonce", 10000),
                                                 (NONCE, 0), (NONCE, 10001), (NONCE, True))):
            with self.subTest(nonce=nonce, timeout=timeout):
                with self.assertRaises(legal.FixtureError):
                    legal.LegalServer(self.root / ("invalid-" + str(index)), nonce,
                                      hold_timeout_ms=timeout)

    def test_concurrent_and_duplicate_release_preserve_one_marker(self):
        server, directory = self.server()
        self.first_complete(directory, server)
        pending = self.second_held(directory, server)
        barrier = threading.Barrier(3)
        results = queue.Queue()

        def release():
            barrier.wait(timeout=2)
            try:
                results.put((True, legal.release_second(directory, server.manifest)))
            except BaseException as error:
                results.put((False, error))

        for _ in range(2):
            thread = threading.Thread(target=release, daemon=True)
            self.threads.append(thread)
            thread.start()
        barrier.wait(timeout=2)
        outcomes = [results.get(timeout=2), results.get(timeout=2)]
        self.assertEqual(sum(ok for ok, _ in outcomes), 1, repr(outcomes))
        rejected = next(value for ok, value in outcomes if not ok)
        self.assertIsInstance(rejected, legal.FixtureError)
        marker_file = directory / "release-2.json"
        original = marker_file.read_bytes()
        self.assertEqual(original, encoded({"version": 1, "nonce": NONCE, "request": 2}))
        with self.assertRaises(legal.FixtureError):
            legal.release_second(directory, server.manifest)
        self.assertEqual(marker_file.read_bytes(), original)
        self.assertEqual(self.response(pending)[0], 200)
        self.wait_state(directory, server, lambda state: state["requests"][1]["status"] == "complete")

    def test_state_identity_sequence_and_completion_invariants_are_checked(self):
        server, directory = self.server()
        self.first_complete(directory, server)
        state_file = directory / "state.json"
        state = self.state(directory, server)
        original = state_file.read_bytes()
        variants = []
        for field, value in (("nonce", OTHER_NONCE), ("pid", os.getpid() + 100000),
                             ("requestCount", 2), ("failure", True), ("version", True)):
            candidate = copy.deepcopy(state)
            candidate[field] = value
            variants.append(("state-" + field, candidate))
        request_changes = {
            "number": 2, "status": "held", "httpStatus": True,
            "receivedMonotonicNs": False, "receivedAt": None,
            "completedMonotonicNs": state["requests"][0]["receivedMonotonicNs"] - 1,
            "completedAt": None,
        }
        for field, value in request_changes.items():
            candidate = copy.deepcopy(state)
            candidate["requests"][0][field] = value
            variants.append(("request-" + field, candidate))
        for name, candidate in variants:
            with self.subTest(case=name):
                state_file.write_bytes(encoded(candidate))
                try:
                    with self.assertRaises(legal.FixtureError):
                        self.state(directory, server)
                finally:
                    state_file.write_bytes(original)


if __name__ == "__main__":
    unittest.main()
