#!/usr/bin/env python3
"""Owned loopback legal-document fixture; importing this module starts nothing.

Only the exact legal endpoint's GET request one returns immediately. Request two
requires a nonce-bound private-file release. GET / is audited separately and
returns an empty 404; timeout and every other unexpected request are failures.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time
from typing import Any

REQUEST_PATH = "/functions/v1/legal/watch/privacy-policy"
MAX_HOLD_TIMEOUT_MS = 10000
MAX_FILE_BYTES = 1024 * 1024
MAX_ROOT_PROBES = 256
HEX32 = re.compile(r"[0-9a-f]{32}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
MANIFEST_FIELDS = {"version", "nonce", "pid", "host", "port", "requestPath", "bodyFile",
                   "bodyBytes", "bodySha256", "holdTimeoutMs"}
STATE_FIELDS = {"version", "nonce", "pid", "requestCount", "requests", "failure"}
REQUEST_FIELDS = {"number", "method", "path", "status", "receivedMonotonicNs", "receivedAt",
                  "completedMonotonicNs", "completedAt", "httpStatus", "error"}
PROBES_FIELDS = {"version", "nonce", "pid", "probeCount", "probes"}
PROBE_FIELDS = {"number", "method", "path", "peerAddress", "peerPort",
                "receivedMonotonicNs", "receivedAt"}


class FixtureError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise FixtureError(message)


def _integer(value: Any, low: int = 0, high: int = (1 << 63) - 1) -> bool:
    return type(value) is int and low <= value <= high


def _ipv4(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(ipaddress.IPv4Address(value)) == value
    except ipaddress.AddressValueError:
        return False


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return dt.datetime.fromisoformat(value).utcoffset() == dt.timedelta(0)
    except ValueError:
        return False


def _encoded(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def fixture_body(nonce: str) -> bytes:
    _require(isinstance(nonce, str) and HEX32.fullmatch(nonce) is not None, "Invalid fixture nonce")
    return "\n\n".join(
        f"第 {number:02d} 段｜隐私协议恢复测试 {nonce}。"
        "这是一段仅供本次本地测试使用的协议正文，用于检查页面重建后重新获取内容、滚动位置和返回路径。"
        "本段不代表真实服务条款，不写入同意记录，也不修改已有文章、订阅或设置。"
        for number in range(1, 33)
    ).encode("utf-8")


def _path(directory: Path, *, exists: bool = True) -> Path:
    source = Path(directory)
    _require(".." not in source.parts, "Parent traversal is not allowed")
    result = Path(os.path.abspath(source))
    for entry in (result, *result.parents):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        _require(not stat.S_ISLNK(info.st_mode), f"Symlink path is not allowed: {entry}")
    if exists:
        _require(result.is_dir(), "Fixture directory is missing")
        _require(result.stat().st_uid == os.getuid(), "Fixture directory is not owned by this user")
    return result


def _regular(info: os.stat_result, name: str) -> None:
    _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid(),
             f"Fixture file must be an owned regular file with one link: {name}")


@contextlib.contextmanager
def _directory(directory: Path):
    path = _path(directory)
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        _require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid(), "Fixture directory changed")
        yield descriptor
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def _locked(directory: Path):
    with _directory(directory) as directory_fd:
        try:
            lock_fd = os.open(".control.lock", os.O_RDWR | os.O_NOFOLLOW, dir_fd=directory_fd)
        except OSError as error:
            raise FixtureError("Fixture control lock is unavailable") from error
        try:
            _regular(os.fstat(lock_fd), ".control.lock")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            yield directory_fd
        finally:
            os.close(lock_fd)


def _read(directory_fd: int, name: str, *, optional: bool = False) -> bytes | None:
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    except FileNotFoundError as error:
        if optional:
            return None
        raise FixtureError(f"Missing fixture file: {name}") from error
    except OSError as error:
        raise FixtureError(f"Cannot safely open fixture file: {name}") from error
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        _regular(before, name)
        _require(before.st_size <= MAX_FILE_BYTES, f"Fixture file is oversized: {name}")
        raw = stream.read(MAX_FILE_BYTES + 1)
        after = os.fstat(stream.fileno())
        _regular(after, name)
        _require(len(raw) == before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns,
                 f"Fixture file changed while being read: {name}")
        return raw


def _json(raw: bytes, name: str) -> dict[str, Any]:
    def pairs(values):
        result = {}
        for key, value in values:
            _require(key not in result, f"Duplicate key in {name}: {key}")
            result[key] = value
        return result
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(FixtureError(f"Nonfinite number in {name}")))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise FixtureError(f"Invalid JSON in {name}") from error
    _require(isinstance(value, dict) and _encoded(value) == raw, f"Noncanonical JSON object in {name}")
    return value


def _atomic(directory_fd: int, name: str, raw: bytes, *, exclusive: bool = False) -> None:
    """Publish under the control lock. link/unlink gives exclusive atomic publication."""
    if not exclusive:
        try:
            _regular(os.stat(name, dir_fd=directory_fd, follow_symlinks=False), name)
        except FileNotFoundError:
            pass
    temporary = ".fixture-" + secrets.token_hex(16) + ".tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory_fd)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            try:
                os.link(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd,
                        follow_symlinks=False)
            except FileExistsError as error:
                raise FixtureError(f"Fixture file already exists: {name}") from error
            # Readers also hold .control.lock and cannot see the transient second link.
            os.unlink(temporary, dir_fd=directory_fd)
        else:
            os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError:
            pass


def _validate_manifest(value: dict[str, Any]) -> None:
    _require(isinstance(value, dict) and set(value) == MANIFEST_FIELDS, "Invalid manifest fields")
    _require(type(value["version"]) is int and value["version"] == 1, "Invalid manifest version")
    _require(isinstance(value["nonce"], str) and HEX32.fullmatch(value["nonce"]) is not None, "Invalid manifest nonce")
    _require(_integer(value["pid"], 1, (1 << 31) - 1), "Invalid manifest PID")
    _require(value["host"] == "127.0.0.1" and _integer(value["port"], 1, 65535), "Invalid loopback endpoint")
    _require(value["requestPath"] == REQUEST_PATH and value["bodyFile"] == "body.utf8", "Invalid fixture resource")
    _require(_integer(value["bodyBytes"], 1, MAX_FILE_BYTES) and isinstance(value["bodySha256"], str)
             and SHA256.fullmatch(value["bodySha256"]) is not None, "Invalid body identity")
    _require(_integer(value["holdTimeoutMs"], 1, MAX_HOLD_TIMEOUT_MS), "Invalid hold timeout")


def _manifest(directory_fd: int, expected: dict[str, Any] | None = None):
    raw = _read(directory_fd, "manifest.json")
    value = _json(raw, "manifest.json")
    _validate_manifest(value)
    if expected is not None:
        _validate_manifest(expected)
        _require(value == expected, "Fixture manifest nonce, PID or contents changed")
    body = _read(directory_fd, "body.utf8")
    _require(len(body) == value["bodyBytes"] and _sha(body) == value["bodySha256"], "Fixture body hash or length changed")
    _require(body == fixture_body(value["nonce"]), "Fixture body is not the owned 32-paragraph UTF-8 fixture")
    return value, raw, body


def _probes(directory_fd: int, manifest: dict[str, Any]) -> dict[str, Any]:
    value = _json(_read(directory_fd, "root-probes.json"), "root-probes.json")
    _require(set(value) == PROBES_FIELDS, "Invalid root-probe audit fields")
    _require(type(value["version"]) is int and value["version"] == 1
             and value["nonce"] == manifest["nonce"] and type(value["pid"]) is int
             and value["pid"] == manifest["pid"], "Root-probe audit nonce or PID mismatch")
    probes = value["probes"]
    _require(isinstance(probes, list) and _integer(value["probeCount"], 0, MAX_ROOT_PROBES)
             and value["probeCount"] == len(probes), "Root-probe audit count mismatch")
    previous = 0
    for number, probe in enumerate(probes, 1):
        _require(isinstance(probe, dict) and set(probe) == PROBE_FIELDS, "Invalid root-probe entry fields")
        _require(type(probe["number"]) is int and probe["number"] == number,
                 "Root-probe numbers are not consecutive")
        _require(probe["method"] == "GET" and probe["path"] == "/", "Invalid root-probe identity")
        _require(_ipv4(probe["peerAddress"]) and _integer(probe["peerPort"], 1, 65535),
                 "Invalid root-probe peer")
        received = probe["receivedMonotonicNs"]
        _require(_integer(received, 1) and received >= previous and _timestamp(probe["receivedAt"]),
                 "Invalid root-probe receive timestamp")
        previous = received
    return value


def _state(directory_fd: int, manifest: dict[str, Any]) -> dict[str, Any]:
    # Counter evidence is accepted only alongside its separate, durable root-probe audit.
    _probes(directory_fd, manifest)
    value = _json(_read(directory_fd, "state.json"), "state.json")
    _require(set(value) == STATE_FIELDS, "Invalid state fields")
    _require(type(value["version"]) is int and value["version"] == 1 and value["nonce"] == manifest["nonce"]
             and type(value["pid"]) is int and value["pid"] == manifest["pid"], "State nonce or PID mismatch")
    requests = value["requests"]
    _require(isinstance(requests, list) and _integer(value["requestCount"]) and value["requestCount"] == len(requests),
             "State request count mismatch")
    _require(value["failure"] is None or isinstance(value["failure"], str) and bool(value["failure"]), "Invalid state failure")
    previous = 0
    for number, request in enumerate(requests, 1):
        _require(isinstance(request, dict) and set(request) == REQUEST_FIELDS, "Invalid request record fields")
        _require(type(request["number"]) is int and request["number"] == number, "Request numbers are not consecutive")
        _require(all(isinstance(request[key], str) and bool(request[key]) for key in ("method", "path")), "Invalid request identity")
        received = request["receivedMonotonicNs"]
        _require(_integer(received, 1) and received >= previous and _timestamp(request["receivedAt"]), "Invalid request receive timestamp")
        previous = received
        if request["status"] == "held":
            _require(all(request[key] is None for key in ("completedMonotonicNs", "completedAt", "httpStatus", "error")),
                     "Held request already has a terminal outcome")
        else:
            _require(request["status"] in ("complete", "failed"), "Invalid request status")
            _require(_integer(request["completedMonotonicNs"], received) and _timestamp(request["completedAt"]), "Invalid request completion timestamp")
            if request["status"] == "complete":
                _require(type(request["httpStatus"]) is int and request["httpStatus"] == 200
                         and request["error"] is None and number <= 2
                         and request["method"] == "GET" and request["path"] == REQUEST_PATH, "Invalid successful request")
            else:
                _require(type(request["httpStatus"]) is int and request["httpStatus"] in (200, 503)
                         and isinstance(request["error"], str) and bool(request["error"])
                         and value["failure"] is not None, "Invalid failed request")
    return value


def _release(directory_fd: int, manifest: dict[str, Any]) -> dict[str, Any] | None:
    raw = _read(directory_fd, "release-2.json", optional=True)
    if raw is None:
        return None
    value = _json(raw, "release-2.json")
    _require(set(value) == {"version", "nonce", "request"} and type(value["version"]) is int
             and value["version"] == 1 and value["nonce"] == manifest["nonce"]
             and type(value["request"]) is int and value["request"] == 2, "Invalid second-request release")
    return value


def read_manifest(directory: Path) -> dict[str, Any]:
    with _locked(directory) as descriptor:
        return _manifest(descriptor)[0]


def read_state(directory: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    with _locked(directory) as descriptor:
        actual, _, _ = _manifest(descriptor, manifest)
        return _state(descriptor, actual)


def read_probes(directory: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    with _locked(directory) as descriptor:
        actual, _, _ = _manifest(descriptor, manifest)
        return _probes(descriptor, actual)


def release_second(directory: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """Release once; persist release-2.receipt.json with exact manifest/body/marker hashes."""
    with _locked(directory) as descriptor:
        actual, manifest_raw, body = _manifest(descriptor, manifest)
        state = _state(descriptor, actual)
        _require(_release(descriptor, actual) is None, "Second request was already released")
        _require(_read(descriptor, "release-2.receipt.json", optional=True) is None,
                 "Second request release receipt already exists")
        _require(state["failure"] is None and state["requestCount"] == 2
                 and state["requests"][0]["status"] == "complete"
                 and state["requests"][1]["status"] == "held", "Second request is not currently held after one completed request")
        second = state["requests"][1]
        _require(second["method"] == "GET" and second["path"] == REQUEST_PATH, "Held request identity mismatch")
        deadline = second["receivedMonotonicNs"] + actual["holdTimeoutMs"] * 1000000
        _require(time.monotonic_ns() < deadline,
                 "Second request hold deadline has expired")
        try:
            os.kill(actual["pid"], 0)
        except OSError as error:
            raise FixtureError("Fixture process is not available") from error
        raw = _encoded({"version": 1, "nonce": actual["nonce"], "request": 2})
        receipt = {"version": 1, "nonce": actual["nonce"], "pid": actual["pid"], "request": 2,
                   "path": "release-2.json", "bytes": len(raw), "sha256": _sha(raw),
                   "manifestSha256": _sha(manifest_raw), "bodySha256": _sha(body)}
        _atomic(descriptor, "release-2.json", raw, exclusive=True)
        published_monotonic_ns = time.monotonic_ns()
        published_at = _now()
        _require(published_monotonic_ns < deadline,
                 "Second request release publication exceeded hold deadline; marker preserved")
        receipt.update(publishedMonotonicNs=published_monotonic_ns, publishedAt=published_at)
        _atomic(descriptor, "release-2.receipt.json", _encoded(receipt), exclusive=True)
        return receipt


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        # Bound idle clients as well as response writes so close() can join workers.
        self.request.settimeout(2)
        super().setup()

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self._serve
        raise AttributeError(name)

    def log_message(self, *_arguments):
        pass

    def _serve(self):
        self.close_connection = True
        fixture = self.server.fixture
        number = None
        status = 503
        error = None
        # BaseHTTPRequestHandler normalizes leading // in self.path. The fixture
        # contract binds the original accepted request target, including slashes.
        request_target = self.requestline.split()[1]
        root_probe = self.command == "GET" and request_target == "/"
        try:
            if root_probe:
                fixture._record_root_probe(self.client_address)
            else:
                number, error = fixture._begin(self.command, request_target)
                if error is None and number == 2:
                    error = fixture._wait_second()
        except Exception as failure:
            error = "fixture_failed:" + type(failure).__name__
        status = (404 if root_probe else 200) if error is None else 503
        body = b"" if status == 404 else fixture.body if status == 200 else (error + "\n").encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
                self.wfile.flush()
        except Exception as failure:
            error = error or "response_failed:" + type(failure).__name__
        finally:
            if number is not None:
                fixture._finish(number, status, error)


class LegalServer:
    """Bind and prepare a new fixture. serve_forever is explicit and blocking."""

    def __init__(self, directory: Path, nonce: str, hold_timeout_ms: int = MAX_HOLD_TIMEOUT_MS):
        self.body = fixture_body(nonce)
        _require(_integer(hold_timeout_ms, 1, MAX_HOLD_TIMEOUT_MS), "Invalid hold timeout")
        self.directory = _path(directory, exists=False)
        _require(not self.directory.exists(), "Refusing an existing fixture output directory")
        self.directory.mkdir(mode=0o700)
        self._mutex = threading.RLock()
        self._lifecycle = threading.Lock()
        self._stop = threading.Event()
        self._serving = threading.Event()
        self._closed = False
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = False
        self._server.fixture = self
        self.manifest = {"version": 1, "nonce": nonce, "pid": os.getpid(), "host": "127.0.0.1",
                         "port": self._server.server_address[1], "requestPath": REQUEST_PATH,
                         "bodyFile": "body.utf8", "bodyBytes": len(self.body), "bodySha256": _sha(self.body),
                         "holdTimeoutMs": hold_timeout_ms}
        self._state = {"version": 1, "nonce": nonce, "pid": os.getpid(), "requestCount": 0,
                       "requests": [], "failure": None}
        self._probes = {"version": 1, "nonce": nonce, "pid": os.getpid(), "probeCount": 0, "probes": []}
        try:
            with _directory(self.directory) as descriptor:
                _atomic(descriptor, ".control.lock", b"", exclusive=True)
                _atomic(descriptor, "body.utf8", self.body, exclusive=True)
                _atomic(descriptor, "state.json", _encoded(self._state), exclusive=True)
                _atomic(descriptor, "root-probes.json", _encoded(self._probes), exclusive=True)
                # Publishing readiness is last, after the listening socket and all resources exist.
                _atomic(descriptor, "manifest.json", _encoded(self.manifest), exclusive=True)
        except BaseException:
            self._server.server_close()
            raise

    def _record_root_probe(self, peer):
        with self._mutex, _locked(self.directory) as descriptor:
            try:
                _manifest(descriptor, self.manifest)
                _require(_state(descriptor, self.manifest) == self._state, "Fixture state changed externally")
                _require(_probes(descriptor, self.manifest) == self._probes, "Root-probe audit changed externally")
                _require(self._probes["probeCount"] < MAX_ROOT_PROBES, "Root-probe audit limit exceeded")
                _require(len(peer) == 2 and _ipv4(peer[0]) and _integer(peer[1], 1, 65535),
                         "Invalid root-probe peer")
                number = self._probes["probeCount"] + 1
                entry = {"number": number, "method": "GET", "path": "/", "peerAddress": peer[0],
                         "peerPort": peer[1], "receivedMonotonicNs": time.monotonic_ns(), "receivedAt": _now()}
                updated = {**self._probes, "probeCount": number, "probes": [*self._probes["probes"], entry]}
                _atomic(descriptor, "root-probes.json", _encoded(updated))
                self._probes = updated
            except Exception:
                if self._state["failure"] is None:
                    self._state["failure"] = "root_probe_audit_failed"
                    _atomic(descriptor, "state.json", _encoded(self._state))
                raise

    def _begin(self, method: str, path: str):
        with self._mutex, _locked(self.directory) as descriptor:
            _manifest(descriptor, self.manifest)
            _require(_state(descriptor, self.manifest) == self._state, "Fixture state changed externally")
            _require(_probes(descriptor, self.manifest) == self._probes, "Root-probe audit changed externally")
            number = self._state["requestCount"] + 1
            error = ("unexpected_method" if method != "GET" else "unexpected_path" if path != REQUEST_PATH
                     else "unexpected_extra_request" if number > 2 else self._state["failure"])
            request = {"number": number, "method": method, "path": path, "status": "held",
                       "receivedMonotonicNs": time.monotonic_ns(), "receivedAt": _now(),
                       "completedMonotonicNs": None, "completedAt": None, "httpStatus": None, "error": None}
            self._state["requestCount"] = number
            self._state["requests"].append(request)
            if error is not None and self._state["failure"] is None:
                self._state["failure"] = error
            _atomic(descriptor, "state.json", _encoded(self._state))
            return number, error

    def _terminal(self, request, status, error):
        request.update(status="complete" if error is None else "failed", httpStatus=status, error=error,
                       completedMonotonicNs=time.monotonic_ns(), completedAt=_now())
        if error is not None and self._state["failure"] is None:
            self._state["failure"] = error

    def _finish(self, number, status, error):
        with self._mutex, _locked(self.directory) as descriptor:
            _manifest(descriptor, self.manifest)
            _require(_state(descriptor, self.manifest) == self._state, "Fixture state changed externally")
            _require(_probes(descriptor, self.manifest) == self._probes, "Root-probe audit changed externally")
            request = self._state["requests"][number - 1]
            self._terminal(request, status, error)
            _atomic(descriptor, "state.json", _encoded(self._state))

    def _wait_second(self):
        while True:
            with self._mutex, _locked(self.directory) as descriptor:
                _manifest(descriptor, self.manifest)
                state = _state(descriptor, self.manifest)
                _require(state == self._state, "Fixture state changed externally")
                _require(_probes(descriptor, self.manifest) == self._probes, "Root-probe audit changed externally")
                if state["failure"] is not None:
                    return "fixture_already_failed"
                if self._stop.is_set():
                    return "fixture_closed_while_held"
                deadline = state["requests"][1]["receivedMonotonicNs"] + self.manifest["holdTimeoutMs"] * 1000000
                if time.monotonic_ns() >= deadline:
                    return "second_request_hold_timeout"
                if _release(descriptor, self.manifest) is not None:
                    return None
            self._stop.wait(0.01)

    def serve_forever(self):
        with self._lifecycle:
            _require(not self._closed and not self._serving.is_set(), "Fixture server is closed or already serving")
            self._serving.set()
        try:
            self._server.serve_forever(poll_interval=0.05)
        finally:
            self._serving.clear()

    def close(self):
        with self._lifecycle:
            if self._closed:
                return
            self._closed = True
            self._stop.set()
            serving = self._serving.is_set()
        if serving:
            self._server.shutdown()
        self._server.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--hold-timeout-ms", type=int, default=MAX_HOLD_TIMEOUT_MS)
    arguments = parser.parse_args(argv)
    server = None
    try:
        server = LegalServer(arguments.out, arguments.nonce, arguments.hold_timeout_ms)
        print(json.dumps(server.manifest, sort_keys=True), flush=True)
        server.serve_forever()
        return 0
    except KeyboardInterrupt:
        return 0
    except (FixtureError, OSError) as error:
        parser.exit(2, f"Fixture rejected: {error}\n")
    finally:
        if server is not None:
            server.close()


if __name__ == "__main__":
    raise SystemExit(main())
