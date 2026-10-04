#!/usr/bin/env python3
"""Stepwise, receipt-gated coordinator for the isolated process-death harness.

This file CAN execute ADB. Importing it does nothing. There is deliberately no
run-all, install, instrumentation, physical-input, force-stop, or cleanup mode.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
import sys
import tarfile
import time
from typing import Any, Callable

import probe

PACKAGE = probe.PACKAGE
COMPONENT = probe.COMPONENT
TEST_PACKAGE = PACKAGE + ".test"
FORMAL = ("com.lightningstudio.watchrss.podjs", "com.lightningstudio.watchrss")
PACKAGES = (PACKAGE, TEST_PACKAGE, *FORMAL)
CONTROL = "files/process-death"
KV_PATH = "files/podjs/podjs-kv.json"
MAX_BACKUP = 1024 * 1024 * 1024
LOCK_ROOT = Path("/tmp") / ("watchrss-process-death-locks-" + str(os.getuid()))
require = probe.require


class TerminalCommandError(probe.EvidenceError):
    """A durable failure receipt exists; its contract does not exclude an effect."""


def encoded(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def observation(raw: bytes | None) -> dict[str, Any]:
    return {"exists": raw is not None, "bytes": len(raw) if raw is not None else 0,
            "sha256": digest(raw) if raw is not None else None}


def safe_local(path: Path, *, existing: bool = True) -> Path:
    path = Path(os.path.abspath(path))
    for entry in (path, *path.parents):
        if entry.exists() or entry.is_symlink():
            info = entry.lstat()
            require(not stat.S_ISLNK(info.st_mode), f"Local symlink is not allowed: {entry}")
            if entry == path and stat.S_ISREG(info.st_mode):
                require(info.st_nlink == 1, f"Local hard-linked file is not allowed: {entry}")
    require(not existing or path.exists(), f"Missing local path: {path}")
    return path


def create_file(path: Path, raw: bytes) -> None:
    safe_local(path, existing=False)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def acquire_lock(path: Path) -> int:
    safe_local(path, existing=False)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid(),
                "Coordinator lock must be an owned regular file with one link")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise probe.EvidenceError("Another coordinator holds the run or device/user lock") from error
        return fd
    except BaseException:
        os.close(fd)
        raise


def receipt_hashes(value: dict[str, Any]) -> dict[str, str]:
    if "current" in value:
        value = probe.object_value(value["current"], "receipt.current")
    owned = probe.object_value(value.get("packages"), "receipt.packages")
    formal = probe.object_value(value.get("formalBefore"), "receipt.formalBefore")
    require(set(owned) == {PACKAGE, TEST_PACKAGE}, "Receipt must name exactly the isolated target and test packages")
    require(set(formal) == set(FORMAL), "Receipt must contain both exact formalBefore packages")
    result: dict[str, str] = {}
    for package in PACKAGES:
        raw = owned[package] if package in owned else formal[package]
        require(isinstance(raw, str), f"Receipt has no string SHA-256 for {package}")
        match = re.fullmatch(r"([0-9a-f]{64})(?:  (/data/app/[^\s]+/base\.apk))?", raw)
        require(match is not None, f"Receipt has an invalid APK hash for {package}")
        result[package] = match[1]
    return result


def parse_processes(raw: str) -> list[dict[str, Any]]:
    lines = raw.splitlines()
    require(bool(lines) and lines[0].split() == ["PID", "UID", "NAME"], "Unsupported process-list columns")
    result = []
    for line in lines[1:]:
        fields = line.split()
        require(len(fields) == 3 and re.fullmatch(r"[0-9]+", fields[0]) is not None and
                re.fullmatch(r"[0-9]+", fields[1]) is not None, "Invalid process-list row")
        require(0 < int(fields[0]) < 2**31 and int(fields[1]) < 2**31, "Invalid process-list PID/UID")
        name = fields[2]
        if name in (PACKAGE, TEST_PACKAGE) or name.startswith(PACKAGE + ":") or name.startswith(TEST_PACKAGE + ":"):
            result.append({"pid": int(fields[0]), "uid": int(fields[1]), "name": name})
    return result


def dead_record(dead: dict[str, Any], ready: dict[str, Any]) -> None:
    require(dead["taskId"] == ready["taskId"] and dead["systemRecord"] == ready["systemRecord"],
            "The original task/ActivityRecord disappeared or was replaced")
    require(dead["notRunning"] and dead["pid"] is None and dead["finishing"] == "false" and
            dead["state"] in ("STOPPED", "DESTROYED") and dead["mHaveState"] == "true" and
            dead["mIcicle"].startswith("Bundle["), "Dead Activity record does not retain the saved Bundle")


def restored_preboot(events: list[dict[str, Any]], ready: dict[str, Any],
                     recovered: dict[str, Any]) -> tuple[str, int, str]:
    ident = probe.latest_identity(events)
    old = tuple(ready["identity"])
    require(ident[0] == old[0] and ident[1] != old[1] and ident[2] != old[2],
            "Restore did not produce a new process in the same run")
    require({probe.identity(event, "lifecycle event") for event in events} == {old, ident},
            "An extra process instance appeared outside the single controlled death/restore boundary")
    selected = probe.activity_events(events, ident)
    probe.process_started(selected)
    creates = [event for event in selected if event["event"] == "preCreate"]
    require(len(creates) == 1, "Restore needs exactly one preCreate")
    incoming = creates[0]
    new_activity = incoming.get("activityInstance")
    require(isinstance(new_activity, str) and probe.ACTIVITY_ID.fullmatch(new_activity) is not None,
            "Restored Activity lacks a valid instance identity")
    require(incoming.get("taskId") == ready["taskId"] and
            incoming.get("lastNonConfigurationPresent") is False and
            incoming.get("finishing") is False and incoming.get("changingConfigurations") is False,
            "Restore lifecycle is not a fresh non-retained Activity in the original task")
    previous = probe.bundle(ready["save"]["bundle"], "prior saved Bundle")
    require(probe.bundle(incoming.get("bundle"), "actual incoming Bundle") == previous,
            "Actual incoming system Bundle does not match the old saved Bundle")
    require(incoming["uptimeMillis"] >= max(ready["stop"]["uptimeMillis"], ready["save"]["uptimeMillis"]),
            "Incoming process predates the stopped/save barrier")
    posts = [event for event in selected if event["event"] == "postCreate" and
             event.get("activityInstance") == incoming.get("activityInstance")]
    require(len(posts) == 1, "Restore needs exactly one matching postCreate")
    post = posts[0]
    require(post.get("taskId") == ready["taskId"] and post["eventSeq"] > incoming["eventSeq"] and
            post.get("hostBooted") is False, "Restore lacks the pre-guest host observation")
    host = probe.host_state(post.get("hostState"), "pre-guest restored host")
    require(host["savedJson"] == previous["savedJson"] and probe.parse_json(host["retainedJson"], "retained") == {},
            "Saved/retained channels do not match process-death restoration")
    require(any(event["event"] == "postResume" and event.get("taskId") == ready["taskId"] and
                event.get("activityInstance") == incoming.get("activityInstance") and
                event["eventSeq"] > post["eventSeq"] for event in selected), "Restored Activity has not resumed")
    require(recovered["taskId"] == ready["taskId"] and recovered["systemRecord"] == ready["systemRecord"] and
            recovered["pid"] == ident[1] and not recovered["notRunning"] and
            recovered["state"] == "RESUMED" and recovered["stopped"] == "false" and
            recovered["finishing"] == "false", "Restore replaced the original Activity/task or did not resume it")
    return ident


class Adb:
    """No shell=True; quote once for the separate Android shell parser."""
    def __init__(self, serial: str, user: int, log_dir: Path):
        self.serial, self.user, self.log_dir = serial, user, log_dir
        self.sequence = 0
        self.deadline: float | None = None

    def run(self, argv: list[str], *, data: bytes | None = None, allowed: tuple[int, ...] = (0,),
            backup: bool = False) -> bytes:
        timeout = 40 if backup else 20
        if self.deadline is not None:
            remaining = self.deadline - time.monotonic()
            require(remaining > 0, "Legal held-response capture deadline expired")
            timeout = min(timeout, remaining)
        self.sequence += 1
        stem = self.log_dir / f"adb-{self.sequence:04d}"
        command = ["adb", "-s", self.serial, "shell", "-T", shlex.join(argv)]
        intent = {"at": now(), "argv": command, "stdin": observation(data)}
        create_file(stem.with_suffix(".intent.json"), encoded(intent))
        out_path = stem.with_suffix(".stdout")
        err_path = stem.with_suffix(".stderr")
        with open(out_path, "xb") as stdout, open(err_path, "xb") as stderr:
            try:
                result = subprocess.run(command, input=data, stdout=stdout, stderr=stderr,
                                        timeout=timeout, check=False)
                code = result.returncode
            except subprocess.TimeoutExpired:
                create_file(stem.with_suffix(".outcome.json"), encoded({"at": now(), "outcome": "timeout-unknown"}))
                raise probe.EvidenceError("ADB timed out; preserve pending evidence and inspect, do not retry the mutation")
            stdout.flush()
            os.fsync(stdout.fileno())
            stderr.flush()
            os.fsync(stderr.fileno())
        size = out_path.stat().st_size
        with out_path.open("rb") as stream:
            stdout_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        create_file(stem.with_suffix(".outcome.json"), encoded({"at": now(), "returnCode": code,
                    "stdout": {"bytes": size, "sha256": stdout_hash}, "stderr": observation(err_path.read_bytes())}))
        require(size <= (MAX_BACKUP if backup else probe.MAX_INPUT_BYTES), "ADB output exceeded its limit")
        require(code in allowed, f"ADB returned {code}; inspect {err_path}")
        if backup:
            # Backup is kept on disk; callers must not load a whole app archive into memory.
            return str(out_path).encode("utf-8")
        return out_path.read_bytes()

    def shell(self, script: str, *arguments: str, data: bytes | None = None,
              backup: bool = False) -> bytes:
        return self.run(["run-as", PACKAGE, "--user", str(self.user), "/system/bin/sh", "-c",
                         script, "process-death", *arguments], data=data, backup=backup)


class Coordinator:
    def __init__(self, args: argparse.Namespace, adb_factory: Callable[..., Adb] = Adb):
        self.args = args
        require(bool(re.fullmatch(r"[A-Za-z0-9_.:\[\]-]{1,128}", args.serial)), "An explicit valid device serial is required")
        require(type(args.user) is int and 0 <= args.user <= 999999, "Android user must be a nonnegative integer")
        self.receipt_path = safe_local(Path(args.receipt))
        self.receipt_raw = self.receipt_path.read_bytes()
        self.hashes = receipt_hashes(probe.object_value(probe.parse_json(self.receipt_raw.decode("utf-8"), "receipt"), "receipt"))
        self.root = safe_local(Path(args.out), existing=args.mode != "prepare")
        if args.mode == "prepare":
            require(not self.root.exists(), "Prepare refuses an existing output directory")
            self.root.mkdir(mode=0o700)
        require(self.root.is_dir() and self.root.stat().st_uid == os.getuid(), "Output must be an owned directory")
        os.chmod(self.root, 0o700)
        self.locks: list[int] = []
        try:
            self.locks.append(acquire_lock(self.root / ".lock"))
            # This must not vary with TMPDIR/TEMP/TMP between coordinator invocations.
            shared = safe_local(LOCK_ROOT, existing=False)
            shared.mkdir(mode=0o700, exist_ok=True)
            require(shared.is_dir() and shared.stat().st_uid == os.getuid() and
                    stat.S_IMODE(shared.stat().st_mode) == 0o700, "Shared lock directory must be owned and private")
            key = digest(encoded([args.serial, args.user, PACKAGE]))
            self.locks.append(acquire_lock(shared / (key + ".lock")))
            if args.mode == "prepare":
                selected_scenario = getattr(args, "scenario", None)
                scenario = "custom" if selected_scenario is None else selected_scenario
                require(scenario in ("custom", "legal"), "Unknown process-death scenario")
                self.state = {"version": 1, "packageName": PACKAGE, "component": COMPONENT,
                              "serial": args.serial, "user": args.user, "runNonce": secrets.token_hex(16),
                              "receiptSha256": digest(self.receipt_raw), "hashes": self.hashes,
                              "phase": "unprepared", "pending": None, "createdAt": now(), "scenario": scenario}
                if scenario == "legal":
                    import legal_server
                    base_url = getattr(args, "legal_base_url", None)
                    require(isinstance(base_url, str) and re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})", base_url)
                            is not None and int(base_url.rsplit(":", 1)[1]) <= 65535,
                            "Legal scenario requires a canonical loopback --legal-base-url")
                    server_arg = getattr(args, "legal_server", None)
                    require(isinstance(server_arg, str), "Legal scenario requires --legal-server directory")
                    directory = safe_local(Path(server_arg))
                    manifest = legal_server.read_manifest(directory)
                    server_state = legal_server.read_state(directory, manifest)
                    require(server_state["requestCount"] == 0 and server_state["failure"] is None,
                            "Legal server must be a fresh independent fixture with no requests")
                    self.state["runNonce"] = manifest["nonce"]
                    raw_manifest = safe_local(directory / "manifest.json").read_bytes()
                    raw_body = safe_local(directory / "body.utf8").read_bytes()
                    self.state["legal"] = {"baseUrl": base_url, "url": base_url + manifest["requestPath"],
                                           "serverDirectory": str(directory), "manifest": manifest,
                                           "manifestSha256": digest(raw_manifest), "bodySha256": digest(raw_body)}
                    create_file(self.root / "legal-server-manifest.json", raw_manifest)
                    create_file(self.root / "legal-body.utf8", raw_body)
                else:
                    require(getattr(args, "legal_base_url", None) is None and getattr(args, "legal_server", None) is None,
                            "Legal fixture options require the explicit legal scenario")
                scenario_raw = encoded({"scenario": scenario, "legal": self.state.get("legal")})
                create_file(self.root / "scenario.json", scenario_raw)
                self.state["scenarioSha256"] = digest(scenario_raw)
                create_file(self.root / "owned-packages.json", self.receipt_raw)
                self.save()
            else:
                self.state = probe.read_json(safe_local(self.root / "run.json"))
                require(self.state.get("version") == 1 and self.state.get("packageName") == PACKAGE and
                        self.state.get("component") == COMPONENT and self.state.get("serial") == args.serial and
                        self.state.get("user") == args.user and self.state.get("receiptSha256") == digest(self.receipt_raw) and
                        self.state.get("hashes") == self.hashes, "Run identity, serial/user, or supplied ownership receipt changed")
                probe.hex32(self.state.get("runNonce"), "run.runNonce")
                scenario = self.state.get("scenario", "custom")
                require(scenario in ("custom", "legal"), "Run has an unknown scenario")
                requested = getattr(args, "scenario", None)
                require(requested is None or requested == scenario, "Scenario cannot change during a run")
                if "scenarioSha256" in self.state:
                    scenario_raw = safe_local(self.root / "scenario.json").read_bytes()
                    require(digest(scenario_raw) == self.state["scenarioSha256"] and
                            probe.parse_json(scenario_raw.decode(), "scenario") ==
                            {"scenario": scenario, "legal": self.state.get("legal")}, "Immutable scenario configuration changed")
                else:
                    require(scenario == "custom" and "legal" not in self.state, "Legacy runs support only the custom scenario")
                for argument, field in (("legal_base_url", "baseUrl"), ("legal_server", "serverDirectory")):
                    value = getattr(args, argument, None)
                    require(value is None or scenario == "legal" and value == self.state["legal"][field],
                            "Legal fixture configuration cannot change during a run")
                require(self.state.get("pending") is None or args.mode == "collect",
                        "Prior mutation outcome is unresolved; only collect is allowed, with no automatic replay")
                require(self.state.get("legalFailure") is None or args.mode == "collect",
                        "Legal held-response proof failed; only collect is allowed, without replay")
                require((self.state.get("legalReleasePending") is None and
                         not (scenario == "legal" and self.state["phase"] == "restored" and
                              "legalRelease" not in self.state)) or args.mode == "collect",
                        "Legal restore/release was interrupted; only collect is allowed, without replay")
            self.step = self.root / (dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + args.mode + "-" + secrets.token_hex(4))
            self.step.mkdir(mode=0o700)
            self.adb = adb_factory(args.serial, args.user, self.step)
            self.artifact_seq = 0
            create_file(self.step / "step.json", encoded({"at": now(), "mode": args.mode, "serial": args.serial,
                        "user": args.user, "runNonce": self.state["runNonce"], "receiptSha256": digest(self.receipt_raw)}))
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        while self.locks:
            os.close(self.locks.pop())

    def save(self) -> None:
        target = safe_local(self.root / "run.json", existing=False)
        temporary = self.root / (".run-" + secrets.token_hex(8) + ".tmp")
        create_file(temporary, encoded(self.state))
        os.replace(temporary, target)
        directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def artifact(self, label: str, value: bytes | Any) -> str:
        self.artifact_seq += 1
        path = self.step / f"{self.artifact_seq:04d}-{label}"
        raw = value if isinstance(value, bytes) else encoded(value)
        create_file(path, raw)
        create_file(path.with_name(path.name + ".sha256.json"), encoded({"at": now(), **observation(raw)}))
        return str(path.relative_to(self.root))

    def path(self, key: str) -> Path:
        relative = self.state.get(key)
        require(isinstance(relative, str) and not Path(relative).is_absolute() and ".." not in Path(relative).parts,
                f"Missing or invalid run evidence reference: {key}")
        return safe_local(self.root / relative)

    def ownership(self) -> dict[str, Any]:
        require(self.receipt_path.read_bytes() == self.receipt_raw, "Ownership receipt changed during this step")
        sdk = self.adb.run(["getprop", "ro.build.version.sdk"]).decode().strip()
        user = self.adb.run(["am", "get-current-user"]).decode().strip()
        require(sdk == "30", "This coordinator's Bundle/system-record proof is limited to Android API 30")
        require(user == str(self.args.user), "Requested Android user is not the current user")
        process_dump = self.adb.run(["dumpsys", "activity", "-a", "processes", PACKAGE]).decode()
        require("ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)" in process_dump,
                "Unsupported ActivityManager process dump; cannot exclude target instrumentation")
        require("Active instrumentation:" not in process_dump, "Target instrumentation is active")
        current = {}
        for package in PACKAGES:
            paths = self.adb.run(["pm", "path", "--user", str(self.args.user), package]).decode().splitlines()
            require(len(paths) == 1 and paths[0].startswith("package:"), f"Expected one installed base APK for {package}; split APKs are unsupported")
            path = paths[0][8:]
            require(bool(re.fullmatch(r"/data/app/[A-Za-z0-9_+=./~-]+/base\.apk", path)), "Unexpected APK path")
            line = self.adb.run(["sha256sum", path]).decode().strip()
            require(line == self.hashes[package] + "  " + path, f"Installed APK SHA-256 mismatch for {package}")
            current[package] = {"sha256": self.hashes[package], "path": path}
        uid = self.adb.shell("id -u").decode().strip()
        require(re.fullmatch(r"[0-9]+", uid) is not None and int(uid) // 100000 == self.args.user and int(uid) % 100000 >= 10000,
                "run-as UID does not identify an app in the requested Android user")
        result = {"at": now(), "serial": self.args.serial, "user": self.args.user, "sdkInt": 30,
                  "runNonce": self.state["runNonce"], "targetUid": int(uid), "packages": current,
                  "receiptSha256": digest(self.receipt_raw)}
        self.artifact("ownership.json", result)
        return result

    def processes(self) -> list[dict[str, Any]]:
        raw = self.adb.run(["ps", "-A", "-o", "PID,UID,NAME"])
        self.artifact("processes.txt", raw)
        return parse_processes(raw.decode())

    def no_processes(self) -> None:
        require(not self.processes(), "The target or test package has a running process; prepare/start/restore will not stop it")

    def old_pid_absent(self, pid: int) -> None:
        require(type(pid) is int and pid > 0, "Invalid captured old PID")
        raw = self.adb.run(["ps", "-A", "-o", "PID,UID,NAME"])
        self.artifact("old-pid-absence.txt", raw)
        parse_processes(raw.decode())  # validate every row before consulting the unfiltered PID column.
        require(all(int(line.split()[0]) != pid for line in raw.decode().splitlines()[1:]),
                "The old PID is still present in the process table")

    def live_process(self, ident: tuple[str, int, str], uid: int) -> None:
        rows = self.processes()
        require(rows == [{"pid": ident[1], "uid": uid, "name": PACKAGE}],
                "Process list does not identify exactly the owned default target process")

    def read_private(self, path: str, *, optional: bool = False) -> bytes | None:
        require(path.startswith("files/") and ".." not in path.split("/") and "\n" not in path, "Invalid private read path")
        # Check every parent; cat must never follow a private symlink/hard link.
        script = '''set -eu
p="$1"
q="$p"
while [ "$q" != . ]; do
  test ! -L "$q"
  case "$q" in */*) q=${q%/*} ;; *) q=. ;; esac
done
if [ -e "$p" ]; then
  test -f "$p"
  test "$(stat -c %h "$p")" = 1
  printf 'PRESENT\\n'
  cat "$p"
else
  printf 'ABSENT\\n'
fi'''
        raw = self.adb.shell(script, path)
        if raw == b"ABSENT\n":
            require(optional, f"Missing device file: {path}")
            return None
        require(raw.startswith(b"PRESENT\n"), f"Invalid private-file read response: {path}")
        return raw[len(b"PRESENT\n"):]

    def config(self) -> None:
        raw = self.read_private(CONTROL + "/config.json")
        require(raw == safe_local(self.root / "config.json").read_bytes(), "Device control configuration differs from this run")

    def events(self) -> tuple[list[dict[str, Any]], str]:
        raw = self.read_private(CONTROL + "/lifecycle.jsonl")
        relative = self.artifact("lifecycle.jsonl", raw)
        events = probe.read_events(self.root / relative)
        require(events[-1]["runNonce"] == self.state["runNonce"], "Lifecycle belongs to another run")
        return events, relative

    def kv_read(self) -> dict[str, Any]:
        raw = self.read_private(KV_PATH, optional=True)
        self.artifact("persistent-kv.json" if raw is not None else "persistent-kv-absent.json", raw if raw is not None else observation(None))
        value = observation(raw)
        require(value == self.state["expectedKv"], "Persistent KV changed from the seeded baseline")
        return value

    def dump(self) -> tuple[dict[str, Any], str]:
        raw = self.adb.run(["dumpsys", "activity", "-a", COMPONENT])
        relative = self.artifact("activity-dump.txt", raw)
        return probe.scoped_dump(raw.decode()), relative

    def poll(self, operation: Callable[[], Any], label: str, seconds: float = 15) -> Any:
        deadline = time.monotonic() + seconds
        last: Exception | None = None
        while True:
            try:
                return operation()
            except TerminalCommandError:
                raise
            except probe.EvidenceError as error:
                last = error
            if time.monotonic() >= deadline:
                raise probe.EvidenceError(f"Timed out observing {label}: {last}")
            time.sleep(0.25)

    def mutate(self, label: str, effect: Callable[[], Any], proof: Callable[[dict[str, Any]], Any],
               preflight: Callable[[dict[str, Any]], None] | None = None) -> Any:
        require(self.state.get("pending") is None, "A mutation is already pending")
        ownership = self.ownership()
        if preflight is not None:
            preflight(ownership)
        self.state["pending"] = {"at": now(), "label": label, "step": str(self.step.relative_to(self.root)),
                                 "ownership": ownership, "outcome": "unknown-until-proof"}
        self.save()
        effect()
        try:
            result = proof(ownership)
        except TerminalCommandError as error:
            self.state["pending"]["outcome"] = "terminal-error-effect-unverified"
            self.state["pending"]["error"] = str(error)
            self.save()
            raise
        self.artifact("mutation-completed.json", {"at": now(), "label": label, "ownership": ownership})
        self.state["pending"] = None
        self.save()
        return result

    def legal_context(self) -> tuple[Path, dict[str, Any], bytes]:
        import legal_server
        require(self.state.get("scenario") == "legal", "This operation requires the explicit legal scenario")
        config = self.state["legal"]
        directory = safe_local(Path(config["serverDirectory"]))
        raw = safe_local(directory / "manifest.json").read_bytes()
        require(digest(raw) == config["manifestSha256"] and
                raw == safe_local(self.root / "legal-server-manifest.json").read_bytes(),
                "Legal server manifest changed")
        manifest = legal_server.read_manifest(directory)
        require(manifest == config["manifest"] and manifest["nonce"] == self.state["runNonce"],
                "Legal server identity changed")
        body = safe_local(self.root / "legal-body.utf8").read_bytes()
        require(digest(body) == config["bodySha256"] == manifest["bodySha256"] and
                body == safe_local(directory / "body.utf8").read_bytes(), "Legal fixture body changed")
        return directory, manifest, body

    def legal_server_state(self, count: int | None = None, last_status: str | None = None) -> dict[str, Any]:
        import legal_server
        directory, manifest, _ = self.legal_context()
        value = legal_server.read_state(directory, manifest)
        self.artifact("legal-server-state.json", value)
        self.artifact("legal-server-root-probes.json", legal_server.read_probes(directory, manifest))
        require(value["failure"] is None, "Independent legal server reported failure")
        if count is not None:
            require(value["requestCount"] == count, "Unexpected legal request count")
        if last_status is not None:
            require(bool(value["requests"]) and value["requests"][-1]["status"] == last_status,
                    "Legal request is not in the required state")
        return value

    def fixture_checkpoint(self, state: dict[str, str], phase: str = "scrolled") -> dict[str, Any]:
        if self.state.get("scenario", "custom") == "custom":
            return probe.onboarding_draft(state)
        import legal_probe
        return legal_probe.checkpoint(state, self.state["legal"]["url"], phase)

    def legal_body(self, checkpoint: dict[str, Any], label: str) -> dict[str, Any]:
        import legal_probe
        _, _, expected = self.legal_context()
        # checkpoint() has already validated the exact owner/hash/token path.
        reference = checkpoint["reference"]
        raw = self.read_private("files/podjs/files/" + reference["path"])
        result = legal_probe.body(reference, raw, self.state["legal"]["url"], expected)
        result["artifact"] = self.artifact(label + ".utf8", raw)
        self.artifact(label + "-proof.json", result)
        return result

    def legal_recorded_sample(self, sample: dict[str, Any], events: list[dict[str, Any]],
                              phase: str, ident: tuple[str, int, str]) -> dict[str, Any]:
        """Bind cached legal observations back to durable harness acknowledgements."""
        import legal_probe
        _, _, expected = self.legal_context()
        def recorded(relative: str) -> bytes:
            require(isinstance(relative, str) and not Path(relative).is_absolute() and
                    ".." not in Path(relative).parts, "Invalid legal evidence artifact path")
            return safe_local(self.root / relative).read_bytes()
        snapshot = probe.object_value(probe.parse_json(recorded(sample["snapshot"]).decode("utf-8"), "legal snapshot"), "legal snapshot")
        require(probe.identity(snapshot, "recorded legal snapshot") == ident,
                "Legal baseline or held snapshot belongs to another process")
        event = probe.acknowledged_event(events, snapshot)
        value = probe.ack(snapshot, "snapshot")
        probe.hex32(value.get("snapshotToken"), "recorded legal snapshot token")
        require(probe.kv(value.get("persistentKv"), "recorded legal KV") == self.state["expectedKv"],
                "Recorded legal snapshot changed persistent KV")
        point = self.fixture_checkpoint(probe.host_state(value.get("hostState"), "recorded legal host state"), phase)
        require(point == sample["checkpoint"], "Cached legal checkpoint differs from its actual acknowledgement")
        raw_body = recorded(sample["body"]["artifact"])
        checked_body = legal_probe.body(point["reference"], raw_body, self.state["legal"]["url"], expected)
        require(all(sample["body"].get(key) == item for key, item in checked_body.items()),
                "Recorded legal body receipt differs from its actual bytes")
        if phase == "held":
            require(not any(node.get("label") == "协议正文" for node in probe.nodes_from_snapshot(value).values()),
                    "Recorded held snapshot still exposes the document branch")
        else:
            geometry = legal_probe.geometry(snapshot, expected.decode("utf-8").split("\n", 1)[0] if phase == "top" else None)
            require(geometry == sample["geometry"], "Cached semantic geometry differs from its actual snapshot")
        return event

    def legal_http_proof(self, completed: dict[str, Any]) -> dict[str, Any]:
        """Recheck held/marker timing from retained evidence after response completion."""
        directory, manifest, expected_body = self.legal_context()
        held = self.state["legalHeld"]
        require(completed["nonce"] == manifest["nonce"] and completed["pid"] == manifest["pid"] and
                completed["requestCount"] == 2 and completed["failure"] is None,
                "Completed HTTP evidence belongs to another server or request sequence")
        second = completed["requests"][1]
        require(all(request["status"] == "complete" and request["httpStatus"] == 200 for request in completed["requests"]),
                "Both legal responses must complete successfully")
        for name in ("serverBefore", "serverAfter"):
            observed = held[name]
            require(observed["nonce"] == manifest["nonce"] and observed["pid"] == manifest["pid"] and
                    observed["requestCount"] == 2 and len(observed["requests"]) == 2 and observed["failure"] is None,
                    "Held server observation changed identity or request sequence")
            require(observed["requests"][0] == completed["requests"][0], "Initial request changed across process death")
            request = observed["requests"][1]
            require(request["status"] == "held" and
                    all(request[key] is None for key in ("completedMonotonicNs", "completedAt", "httpStatus", "error")) and
                    all(request[key] == second[key] for key in ("number", "method", "path", "receivedMonotonicNs", "receivedAt")),
                    "Held bracket does not describe the actual second request before its response")
        receipt = probe.read_json(self.path("legalRelease"))
        actual_receipt = probe.read_json(safe_local(directory / "release-2.receipt.json"))
        require(receipt == actual_receipt, "Server release receipt differs from the coordinator's durable copy")
        require(set(receipt) == {"version", "nonce", "pid", "request", "path", "bytes", "sha256",
                                 "manifestSha256", "bodySha256", "publishedMonotonicNs", "publishedAt"} and
                all(type(receipt[key]) is int for key in ("version", "pid", "request", "bytes", "publishedMonotonicNs")) and
                isinstance(receipt["publishedAt"], str), "Invalid legal release receipt schema")
        marker_raw = safe_local(directory / "release-2.json").read_bytes()
        marker = probe.parse_json(marker_raw.decode("utf-8"), "release marker")
        require(marker == {"version": 1, "nonce": manifest["nonce"], "request": 2} and
                type(marker["version"]) is int and type(marker["request"]) is int, "Release marker has another request identity")
        require(receipt.get("version") == 1 and receipt.get("nonce") == manifest["nonce"] and
                receipt.get("pid") == manifest["pid"] and receipt.get("request") == 2 and
                receipt.get("path") == "release-2.json" and receipt.get("bytes") == len(marker_raw) and
                receipt.get("sha256") == digest(marker_raw) and receipt.get("manifestSha256") == self.state["legal"]["manifestSha256"] and
                receipt.get("bodySha256") == digest(expected_body), "Release receipt does not bind the manifest, body and exact marker")
        captured, published = held.get("capturedMonotonicNs"), receipt.get("publishedMonotonicNs")
        require(type(captured) is int and type(published) is int and
                second["receivedMonotonicNs"] <= captured <= published <= second["completedMonotonicNs"] and
                published < second["receivedMonotonicNs"] + manifest["holdTimeoutMs"] * 1_000_000,
                "Held checkpoint was not durably released inside the actual second request's hold window")
        return {"serverNonce": manifest["nonce"], "serverPid": manifest["pid"], "requestsBefore": 1,
                "requestsAfter": 2, "additionalRequests": 1, "sameIndependentServerVerified": True,
                "requestMethod": "GET", "requestPath": manifest["requestPath"],
                "countScope": "exact-legal-endpoint",
                "heldBeforeReleaseVerified": True, "receivedMonotonicNs": second["receivedMonotonicNs"],
                "capturedMonotonicNs": captured, "publishedMonotonicNs": published,
                "completedMonotonicNs": second["completedMonotonicNs"], "release": receipt}

    def legal_baseline(self) -> dict[str, Any]:
        import legal_probe
        require(self.state.get("scenario") == "legal" and self.state["phase"] == "running",
                "Legal baseline requires the initial legal process")
        require("legalTop" not in self.state, "Initial legal top baseline cannot be replaced")
        _, _, expected = self.legal_context()
        marker = expected.decode("utf-8").split("\n", 1)[0]
        previous: dict[str, Any] | None = None
        def ready() -> dict[str, Any]:
            nonlocal previous
            self.legal_server_state(1, "complete")
            snapshot, path = self.snapshot()
            point = self.fixture_checkpoint(probe.host_state(probe.ack(snapshot, "snapshot")["hostState"], "legal top"), "top")
            geometry = legal_probe.geometry(snapshot, marker)
            sample = {"snapshot": path, "checkpoint": point, "geometry": geometry}
            same = previous is not None and point == previous["checkpoint"] and legal_probe.compare_geometry(previous["geometry"], geometry)
            previous = sample
            require(same, "Initial legal top state/semantics need a second stable observation")
            sample["body"] = self.legal_body(point, "legal-top-body")
            self.legal_server_state(1, "complete")
            return sample
        sample = self.poll(ready, "initial legal top state and semantic geometry")
        self.state["legalTop"] = sample
        self.save()
        return {"status": "legal-top-baseline-collected", **sample, "pixelParityVerified": False}

    def legal_hold_release(self) -> dict[str, Any]:
        import legal_probe
        import legal_server
        require(self.state.get("scenario") == "legal" and self.state["phase"] == "restored" and
                "legalHeld" not in self.state and "legalReleasePending" not in self.state,
                "Legal held-response capture cannot be replayed")
        directory, manifest, _ = self.legal_context()
        old_deadline = getattr(self.adb, "deadline", None)
        try:
            server_before = self.poll(lambda: self.legal_server_state(2, "held"),
                                      "new-process legal request 2", seconds=5)
            request = server_before["requests"][-1]
            # Both processes use the host's monotonic clock. Reserve time for
            # durable evidence and release before the server's hard deadline.
            deadline = request["receivedMonotonicNs"] / 1_000_000_000 + manifest["holdTimeoutMs"] / 1000 - .5
            require(time.monotonic() < deadline, "Legal request 2 held window already expired")
            self.adb.deadline = deadline
            last_error: Exception | None = None
            while True:
                require(time.monotonic() < deadline, f"Legal held checkpoint deadline expired: {last_error}")
                bracket_before = self.legal_server_state(2, "held")
                require(bracket_before["requests"][-1]["receivedMonotonicNs"] == request["receivedMonotonicNs"],
                        "Held request identity changed")
                snapshot, path = self.snapshot()
                try:
                    point = self.fixture_checkpoint(probe.host_state(probe.ack(snapshot, "snapshot")["hostState"], "held legal state"), "held")
                    legal_probe.validate_held(self.state["legalBefore"]["checkpoint"], point)
                    require(not any(node.get("label") == "协议正文" for node in
                                    probe.nodes_from_snapshot(probe.ack(snapshot, "snapshot")).values()),
                            "Held response has not committed the loading branch")
                except probe.EvidenceError as error:
                    last_error = error
                    self.legal_server_state(2, "held")
                    time.sleep(min(.05, max(0, deadline - time.monotonic())))
                    continue
                body = self.legal_body(point, "legal-held-body")
                bracket_after = self.legal_server_state(2, "held")
                require(bracket_after["requests"][-1]["receivedMonotonicNs"] == request["receivedMonotonicNs"] and
                        time.monotonic() < deadline, "Response was no longer held around the body/snapshot observation")
                held = {"snapshot": path, "checkpoint": point, "body": body,
                        "serverBefore": bracket_before, "serverAfter": bracket_after,
                        "capturedAt": now(), "capturedMonotonicNs": time.monotonic_ns()}
                self.state["legalHeld"] = held
                self.state["legalReleasePending"] = {"at": now(), "request": 2, "nonce": manifest["nonce"]}
                self.save()
                self.legal_server_state(2, "held")
                require(time.monotonic() < deadline, "Held response expired while persisting its evidence")
                release = legal_server.release_second(directory, manifest)
                self.state["legalRelease"] = self.artifact("legal-release.json", release)
                del self.state["legalReleasePending"]
                self.save()
                return {"heldCheckpoint": held, "release": release}
        except Exception as error:
            self.state["legalFailure"] = {"at": now(), "error": str(error), "stage": "held-response-capture"}
            self.save()
            raise
        finally:
            self.adb.deadline = old_deadline

    def prepare(self) -> dict[str, Any]:
        self.ownership()
        self.no_processes()
        require(self.read_private(CONTROL + "/config.json", optional=True) is None, "A previous device run configuration exists")
        # Refuse even an empty pre-existing controller directory, before backing up or writing.
        self.adb.shell('test ! -e "$1" && test ! -L "$1"', CONTROL)
        archive_path = Path(self.adb.shell("tar -cf - .", backup=True).decode())
        require(archive_path.stat().st_size > 0, "Empty app-data backup")
        archived_kv = None
        with tarfile.open(archive_path, mode="r:") as archive:
            for member in archive:
                require(not member.name.startswith("/") and ".." not in Path(member.name).parts,
                        "Backup contains an unsafe archive member name")
                if member.name.removeprefix("./") == KV_PATH:
                    require(member.isfile() and member.size <= probe.MAX_INPUT_BYTES,
                            "Backed-up KV is not a bounded regular file")
                    stream = archive.extractfile(member)
                    require(stream is not None, "Backed-up KV cannot be read")
                    with stream:
                        archived_kv = stream.read()
        with archive_path.open("rb") as stream:
            backup_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        self.state["backup"] = {"path": str(archive_path.relative_to(self.root)), "sha256": backup_hash,
                                "bytes": archive_path.stat().st_size, "scope": "whole run-as app-data directory; never automatically extracted"}
        original = self.read_private(KV_PATH, optional=True)
        require(original == archived_kv, "Current KV differs from its verified app-data backup")
        self.no_processes()
        self.state["originalKv"] = observation(original)
        if original is not None:
            create_file(self.root / "original-kv.json", original)
        seed_value = {"startup-content-mounts": 0, "watchrss.onboarding": {
            "oobeSeenVersion": 0, "privacyPolicyAgreedVersion": 0,
            "futureField": "process-death-" + self.state["runNonce"]},
            "preserved-fixture-data": {"articles": ["kept"], "revision": 23,
                                       "runNonce": self.state["runNonce"]}}
        if self.state.get("scenario") == "legal":
            self.legal_server_state(0)
            seed_value["watchrss.onboarding"]["oobeSeenVersion"] = 3
            seed_value["startup-legal-base-url"] = self.state["legal"]["baseUrl"]
            seed_value["legal-restoration-events"] = False
        seed = encoded(seed_value)
        config = encoded({"version": 1, "packageName": PACKAGE, "runNonce": self.state["runNonce"]})
        create_file(self.root / "seed-kv.json", seed)
        create_file(self.root / "config.json", config)
        self.state["expectedKv"] = observation(seed)
        create_file(self.root / "expected-kv.json", encoded(self.state["expectedKv"]))
        self.save()
        def publish(path: str, raw: bytes, create_control: bool) -> None:
            script = '''set -eu
umask 077
test ! -L files
test ! -L files/podjs
test ! -L files/process-death
test ! -e files/process-death/command.json
test ! -e files/process-death/inflight.json
if [ "$3" = control ]; then
  test ! -e files/process-death
  mkdir files/process-death
else
  mkdir -p files/podjs
fi
test ! -L "$1"
if [ -e "$1" ]; then test -f "$1"; test "$(stat -c %h "$1")" = 1; fi
set -C
cat > "$2"
mv "$2" "$1"'''
            def preflight(_: dict[str, Any]) -> None:
                self.no_processes()
                expected = seed if create_control else original
                require(self.read_private(KV_PATH, optional=True) == expected,
                        "KV changed after backup or between the seed/config writes")
            def proof(_: dict[str, Any]) -> None:
                require(self.read_private(path) == raw, "Published fixture did not read back exactly")
                self.state["phase"] = "prepared" if create_control else "seed-written"
            self.mutate("prepare-config" if create_control else "prepare-seed",
                        lambda: self.adb.shell(script, path, path + "." + self.state["runNonce"] + ".tmp",
                                               "control" if create_control else "seed", data=raw),
                        proof, preflight)
        publish(KV_PATH, seed, False)
        publish(CONTROL + "/config.json", config, True)
        return {"status": "prepared", "backup": self.state["backup"], "expectedKv": self.state["expectedKv"]}

    def launch_argv(self, task: int | None = None) -> list[str]:
        command = ["am", "start", "-W", "--user", str(self.args.user)]
        if task is not None:
            require(type(task) is int and task >= 0, "Invalid captured task ID")
            command += ["--task", str(task), "--activity-reorder-to-front"]
        return command + ["-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", COMPONENT]

    def start(self) -> dict[str, Any]:
        require(self.state["phase"] == "prepared", "Start requires a freshly prepared run")
        def preflight(_: dict[str, Any]) -> None:
            self.config()
            self.kv_read()
            self.no_processes()
            # Existing stopped tasks could supply an old Bundle at the first launch.
            raw = self.adb.run(["dumpsys", "activity", "-a", COMPONENT])
            self.artifact("before-start-dump.txt", raw)
            require(not re.search(rb"^\s*ACTIVITY\s+" + re.escape(COMPONENT.encode()) + rb"\s", raw, re.M),
                    "An existing target Activity/task must be resolved manually before initial launch")
        def proof(owned: dict[str, Any]) -> dict[str, Any]:
            def ready() -> dict[str, Any]:
                events, event_path = self.events()
                ident = probe.latest_identity(events)
                probe.process_started(probe.activity_events(events, ident))
                probe.command(events, "snapshot")  # validates resumed; does not submit.
                self.live_process(ident, owned["targetUid"])
                dump, dump_path = self.dump()
                require(dump["pid"] == ident[1] and dump["state"] == "RESUMED", "Initial target has not resumed")
                creates = [event for event in events if event["event"] == "preCreate"]
                require(len(creates) == 1 and creates[0].get("bundle", {}).get("present") is False,
                        "Initial launch unexpectedly received a saved Bundle")
                self.state.update(initialIdentity=list(ident), initialTask=dump["taskId"], initialRecord=dump["systemRecord"],
                                  latestEvents=event_path, initialDump=dump_path, phase="running")
                return {"identity": ident, "taskId": dump["taskId"], "systemRecord": dump["systemRecord"]}
            return self.poll(ready, "initial resumed Activity")
        return self.mutate("initial-launch", lambda: self.adb.run(self.launch_argv()), proof, preflight)

    def healthy_events(self) -> list[dict[str, Any]]:
        self.config()
        events, relative = self.events()
        ident = probe.latest_identity(events)
        probe.process_started(probe.activity_events(events, ident))
        self.state["latestEvents"] = relative
        expected = self.state.get("restoredIdentity", self.state.get("initialIdentity"))
        require(list(ident) == expected, "Target process changed outside the controlled kill/restore steps")
        return events

    def submit(self, command: dict[str, Any],
               on_success: Callable[[dict[str, Any], str], None] | None = None) -> tuple[dict[str, Any], str]:
        raw = encoded(command)
        self.artifact("command.json", raw)
        ident = probe.identity(command, "command")
        def preflight(owned: dict[str, Any]) -> None:
            events = self.healthy_events()
            require(probe.latest_identity(events) == ident, "Command process became stale")
            probe.command(events, command["op"])
            self.live_process(ident, owned["targetUid"])
            self.kv_read()
        script = '''set -eu
umask 077
test ! -L files
test ! -L files/process-death
test -d files/process-death
test ! -e files/process-death/command.json
test ! -L files/process-death/command.json
test ! -e files/process-death/inflight.json
test ! -L files/process-death/inflight.json
test ! -e "$2"
test ! -L "$2"
set -C
cat > "$1"
mv "$1" files/process-death/command.json'''
        def receipt(_: dict[str, Any]) -> tuple[dict[str, Any], str]:
            def ready() -> tuple[dict[str, Any], str]:
                ack_raw = self.read_private(CONTROL + "/acks/" + command["id"] + ".json", optional=True)
                require(ack_raw is not None, "Command acknowledgement is not published yet")
                value = probe.object_value(probe.parse_json(ack_raw.decode(), "acknowledgement"), "acknowledgement")
                require(probe.identity(value, "acknowledgement") == ident and value.get("id") == command["id"],
                        "Acknowledgement identity does not match the submitted command")
                require(value.get("op") == command["op"] and value.get("status") in ("ok", "error", "interrupted"),
                        "Acknowledgement operation/status is invalid")
                events, event_path = self.events()
                self.state["latestEvents"] = event_path
                claim = self.read_private(CONTROL + "/claims/" + command["id"] + ".json")
                require(probe.parse_json(claim.decode(), "durable claim") == command, "Durable claim differs from submitted command")
                self.artifact("claim.json", claim)
                path = self.artifact("ack.json", ack_raw)
                self.state.update(latestAck=path, latestCommand=command)
                if value["status"] != "ok":
                    raise TerminalCommandError(f"Durable {value['status']} acknowledgement: {path}; effect remains unverified")
                probe.ack(value, command["op"])
                probe.acknowledged_event(events, value)
                self.kv_read()
                if on_success is not None:
                    on_success(value, path)
                return value, path
            return self.poll(ready, "durable command acknowledgement")
        return self.mutate(command["op"] + "-" + command["id"],
                           lambda: self.adb.shell(script, CONTROL + "/command-" + command["id"] + ".tmp",
                                                  CONTROL + "/acks/" + command["id"] + ".json", data=raw),
                           receipt, preflight)

    def snapshot(self) -> tuple[dict[str, Any], str]:
        require(self.state["phase"] in ("running", "restored", "validated"), "Snapshot requires a running initial or restored Activity")
        def commit(value: dict[str, Any], path: str) -> None:
            payload = probe.ack(value, "snapshot")
            probe.hex32(payload.get("snapshotToken"), "snapshotToken")
            probe.nodes_from_snapshot(payload)
            probe.host_state(payload.get("hostState"), "snapshot host")
            require(probe.kv(payload.get("persistentKv"), "snapshot KV") == self.state["expectedKv"], "Snapshot KV changed")
            self.state["latestSnapshot"] = path
        return self.submit(probe.command(self.healthy_events(), "snapshot"), commit)

    def action(self) -> dict[str, Any]:
        before, _ = self.snapshot()
        command = probe.action_command(self.healthy_events(), before, self.args.label, self.args.action)
        result, ack_path = self.submit(command)
        require(probe.ack(result, "action").get("accepted") is True, "Semantic action was not accepted")
        _, after_path = self.snapshot()
        return {"status": "action-acknowledged", "actionAck": ack_path, "afterSnapshot": after_path,
                "guestEffectVerified": False, "note": "Inspect the snapshot; accepted proves queued delivery only."}

    def background(self) -> dict[str, Any]:
        require(self.state["phase"] == "running", "Background is allowed once in the initial process")
        snapshot, path = self.snapshot()
        point = self.fixture_checkpoint(probe.host_state(probe.ack(snapshot, "snapshot").get("hostState"), "before background"))
        if self.state.get("scenario") == "legal":
            import legal_probe
            require("legalTop" in self.state, "Collect legal-baseline before scrolling and backgrounding")
            self.legal_server_state(1, "complete")
            geometry = legal_probe.geometry(snapshot)
            require(not legal_probe.compare_geometry(self.state["legalTop"]["geometry"], geometry),
                    "Scrolled legal semantics are indistinguishable from the initial top")
            body = self.legal_body(point, "legal-before-body")
            require(point["reference"] == self.state["legalTop"]["checkpoint"]["reference"],
                    "Scrolling replaced the initial immutable legal body reference")
            self.state["legalBefore"] = {"snapshot": path, "checkpoint": point, "geometry": geometry, "body": body}
        self.state["beforeSnapshot"] = path
        def commit(ack: dict[str, Any], ack_path: str) -> None:
            require(probe.ack(ack, "background").get("moved") is True, "Task did not move to background")
            self.state.update(backgroundAck=ack_path, phase="background")
        _, ack_path = self.submit(probe.command(self.healthy_events(), "background"), commit)
        return {"status": "background-acknowledged", "backgroundAck": ack_path, "processDeathVerified": False}

    def barrier(self) -> dict[str, Any]:
        require(self.state["phase"] in ("background", "barrier"), "Barrier requires the acknowledged background step")
        self.config()
        owned = self.ownership()
        def ready() -> dict[str, Any]:
            events, event_path = self.events()
            before, before_path = self.dump()
            result = probe.barrier(events, probe.read_json(self.path("backgroundAck")), before, self.state["expectedKv"])
            require(result["identity"] == probe.latest_identity(events) and list(result["identity"]) == self.state["initialIdentity"],
                    "Barrier does not belong to the current original process")
            require(result["taskId"] == self.state["initialTask"] and result["systemRecord"] == self.state["initialRecord"],
                    "Barrier replaced the initial task/ActivityRecord")
            self.live_process(result["identity"], owned["targetUid"])
            self.kv_read()
            snapshot = probe.read_json(self.path("beforeSnapshot"))
            value = probe.ack(snapshot, "snapshot")
            probe.hex32(value.get("snapshotToken"), "before snapshot token")
            probe.nodes_from_snapshot(value)
            require(probe.identity(snapshot, "before snapshot") == result["identity"], "Before snapshot has a stale process identity")
            snapshot_event = probe.acknowledged_event(events, snapshot)
            background_event = probe.acknowledged_event(events, probe.read_json(self.path("backgroundAck")))
            require(snapshot_event["eventSeq"] < background_event["eventSeq"] and
                    snapshot_event.get("activityInstance") == result["activityInstance"],
                    "Before snapshot is not a durable observation before backgrounding this Activity")
            require(probe.kv(value.get("persistentKv"), "before snapshot KV") == self.state["expectedKv"], "Before snapshot KV changed")
            require(probe.host_state(value["hostState"], "before snapshot") == result["state"],
                    "Activity draft changed after the before snapshot")
            point = self.fixture_checkpoint(result["state"])
            if self.state.get("scenario") == "legal":
                require(point == self.state["legalBefore"]["checkpoint"], "Legal state changed before the system barrier")
                self.legal_body(point, "legal-barrier-body")
                self.legal_server_state(1, "complete")
            self.state.update(latestEvents=event_path, beforeDump=before_path, ready=result)
            return result
        result = self.poll(ready, "system-side saved Bundle barrier")
        self.state["phase"] = "barrier"
        self.state["barrierProof"] = self.artifact("barrier.json", result)
        self.save()
        return result

    def kill(self) -> dict[str, Any]:
        require(self.state["phase"] == "barrier", "Kill requires a separately reviewed successful barrier step")
        # Recollect everything, including system-side Bundle, immediately before am kill.
        ready = self.barrier()
        def preflight(owned: dict[str, Any]) -> None:
            events, event_path = self.events()
            before, before_path = self.dump()
            fresh = probe.barrier(events, probe.read_json(self.path("backgroundAck")), before, self.state["expectedKv"])
            require(fresh["identity"] == probe.latest_identity(events) and fresh == ready, "Barrier changed before kill")
            self.live_process(tuple(ready["identity"]), owned["targetUid"])
            self.kv_read()
            self.state.update(latestEvents=event_path, beforeDump=before_path)
        def proof(_: dict[str, Any]) -> dict[str, Any]:
            def gone() -> dict[str, Any]:
                self.no_processes()
                self.old_pid_absent(ready["identity"][1])
                dead, path = self.dump()
                dead_record(dead, ready)
                self.kv_read()
                if self.state.get("scenario") == "legal":
                    self.state["legalDeadBody"] = self.legal_body(self.state["legalBefore"]["checkpoint"], "legal-dead-body")
                    self.legal_server_state(1, "complete")
                self.state.update(deadDump=path, phase="dead")
                return dead
            return self.poll(gone, "old process disappearance and preserved system record")
        result = self.mutate("am-kill-owned-background-package",
                             lambda: self.adb.run(["am", "kill", "--user", str(self.args.user), PACKAGE]), proof, preflight)
        return {"status": "process-death-observed", "dead": result, "actualLowMemoryKillerVerified": False}

    def restore(self) -> dict[str, Any]:
        require(self.state["phase"] == "dead", "Restore requires independently observed process death")
        ready = self.state["ready"]
        self.config()
        def preflight(_: dict[str, Any]) -> None:
            self.no_processes()
            self.old_pid_absent(ready["identity"][1])
            dead, _ = self.dump()
            dead_record(dead, ready)
            self.kv_read()
            if self.state.get("scenario") == "legal":
                self.legal_server_state(1, "complete")
                self.legal_body(self.state["legalBefore"]["checkpoint"], "legal-prerestore-body")
        def proof(owned: dict[str, Any]) -> dict[str, Any]:
            def resumed() -> dict[str, Any]:
                events, event_path = self.events()
                recovered, dump_path = self.dump()
                ident = restored_preboot(events, ready, recovered)
                self.live_process(ident, owned["targetUid"])
                self.kv_read()
                self.state.update(restoredIdentity=list(ident), recoveredDump=dump_path, latestEvents=event_path, phase="restored")
                return {"identity": ident, "actualIncomingBundleVerified": True,
                        "savedRestoredBeforeGuestBoot": True, "retainedAbsentBeforeGuestBoot": True}
            return self.poll(resumed, "restored Activity and actual incoming system Bundle")
        result = self.mutate("restore-captured-task", lambda: self.adb.run(self.launch_argv(ready["taskId"])), proof, preflight)
        if self.state.get("scenario") == "legal":
            result["legalHeldResponse"] = self.legal_hold_release()
        return result

    def validate(self) -> dict[str, Any]:
        require(self.state["phase"] in ("restored", "validated"), "Validate requires successful restoration")
        legal_result = None
        if self.state.get("scenario") == "legal":
            import legal_probe
            require("legalHeld" in self.state and "legalRelease" in self.state and
                    self.state.get("legalReleasePending") is None and self.state.get("legalFailure") is None,
                    "Legal validation requires the completed held-reference barrier and release")
            _, manifest, expected = self.legal_context()
            marker = expected.decode("utf-8").split("\n", 1)[0]
            previous: dict[str, Any] | None = None
            def loaded() -> tuple[dict[str, Any], str, dict[str, Any]]:
                nonlocal previous
                server = self.legal_server_state(2, "complete")
                require(all(request["status"] == "complete" and request["httpStatus"] == 200
                            for request in server["requests"]), "Legal requests did not both complete successfully")
                snapshot, snapshot_path = self.snapshot()
                point = self.fixture_checkpoint(probe.host_state(probe.ack(snapshot, "snapshot")["hostState"], "restored legal state"), "loaded")
                geometry = legal_probe.geometry(snapshot, marker)
                sample = {"snapshot": snapshot_path, "checkpoint": point, "geometry": geometry}
                same = previous is not None and point == previous["checkpoint"] and legal_probe.compare_geometry(previous["geometry"], geometry)
                previous = sample
                require(same, "Restored legal state/semantics need a second stable observation")
                result = legal_probe.validate_restored(self.state["legalTop"]["checkpoint"], self.state["legalBefore"]["checkpoint"],
                                                      self.state["legalHeld"]["checkpoint"], point,
                                                      self.state["legalTop"]["geometry"], self.state["legalBefore"]["geometry"], geometry)
                result.update(body=self.legal_body(point, "legal-restored-body"), server=server,
                              requestsBefore=1, requestsAfter=2, additionalRequests=1,
                              requestMethod="GET", requestPath=manifest["requestPath"],
                              countScope="exact-legal-endpoint",
                              eventOrderingInternalsVerified=False, pixelParityVerified=False)
                result["http"] = self.legal_http_proof(server)
                self.legal_server_state(2, "complete")
                return snapshot, snapshot_path, result
            after, path, legal_result = self.poll(loaded, "restored legal top and request count")
        else:
            after, path = self.snapshot()
        events, event_path = self.events()
        recovered, dump_path = self.dump()
        proof = probe.validate(events, probe.read_json(self.path("backgroundAck")),
                               probe.read_json(self.path("beforeSnapshot")), after,
                               probe.scoped_dump(probe.read_text(self.path("beforeDump"))),
                               probe.scoped_dump(probe.read_text(self.path("deadDump"))), recovered,
                               self.state["expectedKv"], scenario=self.state.get("scenario", "custom"),
                               legal_url=self.state.get("legal", {}).get("url"))
        self.kv_read()
        if legal_result is not None:
            old = tuple(self.state["initialIdentity"])
            new = probe.identity(after, "after snapshot")
            top_event = self.legal_recorded_sample(self.state["legalTop"], events, "top", old)
            before_event = self.legal_recorded_sample(self.state["legalBefore"], events, "scrolled", old)
            held_event = self.legal_recorded_sample(self.state["legalHeld"], events, "held", new)
            background_event = probe.acknowledged_event(events, probe.read_json(self.path("backgroundAck")))
            after_event = probe.acknowledged_event(events, after)
            require(top_event["eventSeq"] < before_event["eventSeq"] < background_event["eventSeq"] and
                    top_event.get("activityInstance") == before_event.get("activityInstance") == background_event.get("activityInstance"),
                    "Legal top/scrolled observations were not captured before backgrounding the same original Activity")
            require(held_event["eventSeq"] < after_event["eventSeq"] and
                    held_event.get("activityInstance") == after_event.get("activityInstance"),
                    "Held and loaded observations do not follow the restored Activity in order")
            proof.update(legalBodyFilesVerified=True, legalBranchOutcomeVerified=True, legal=legal_result)
        proof["scope"] = "Device evidence collected by the stepwise coordinator and checked with the offline validator. Physical/UI acceptance remains separate."
        proof["serial"] = self.args.serial
        proof["user"] = self.args.user
        self.state.update(afterSnapshot=path, latestEvents=event_path, recoveredDump=dump_path,
                          validation=self.artifact("validation.json", proof), phase="validated")
        self.save()
        return proof

    def collect(self) -> dict[str, Any]:
        # Read-only recovery/diagnosis. It never clears an unresolved intent.
        self.ownership()
        self.processes()
        self.artifact("activity-dump.txt", self.adb.run(["dumpsys", "activity", "-a", COMPONENT]))
        for path in (CONTROL + "/config.json", CONTROL + "/lifecycle.jsonl", CONTROL + "/command.json", CONTROL + "/inflight.json", KV_PATH):
            raw = self.read_private(path, optional=True)
            self.artifact(path.replace("/", "-") + ".evidence", raw if raw is not None else observation(None))
        protocol = Path(self.adb.shell('test ! -L "$1" && tar -cf - "$1"', CONTROL, backup=True).decode())
        return {"status": "collected-read-only", "protocolArchive": str(protocol.relative_to(self.root)),
                "phase": self.state["phase"], "pending": self.state["pending"]}

    def execute(self) -> dict[str, Any]:
        if self.args.mode == "snapshot":
            _, path = self.snapshot()
            result = {"status": "snapshot-collected", "snapshot": path}
        else:
            result = getattr(self, self.args.mode.replace("-", "_"))()
        output = {"at": now(), "runNonce": self.state["runNonce"], "step": str(self.step), **result}
        self.artifact("result.json", output)
        return output


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--serial", required=True, help="Explicit ADB serial; never inferred")
    result.add_argument("--user", type=int, required=True, help="Explicit current Android user ID")
    result.add_argument("--receipt", required=True, help="Current owned packages receipt with both formalBefore hashes")
    result.add_argument("--out", required=True, help="New directory for prepare; same owned directory for later steps")
    result.add_argument("--scenario", choices=("custom", "legal"), help="Explicit fixture; stored at prepare and immutable thereafter")
    result.add_argument("--legal-base-url", help="Legal fixture's fixed http://127.0.0.1:DEVICE_PORT base URL")
    result.add_argument("--legal-server", help="Independent legal_server.py evidence directory; legal prepare only")
    sub = result.add_subparsers(dest="mode", required=True)
    for mode in ("prepare", "start", "snapshot", "legal-baseline", "background", "barrier", "kill", "restore", "validate", "collect"):
        sub.add_parser(mode)
    action = sub.add_parser("action")
    action.add_argument("--label", required=True)
    action.add_argument("--action", choices=(1, 2, 4), type=int, required=True)
    return result


def main(argv: list[str] | None = None) -> int:
    instance: Coordinator | None = None
    try:
        instance = Coordinator(parser().parse_args(argv))
        print(json.dumps(instance.execute(), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, tarfile.TarError) as error:
        result = {"status": "rejected", "error": str(error)}
        if instance is not None:
            result["pending"] = instance.state.get("pending")
            instance.artifact("rejected.json", result)
        print(json.dumps(result, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    finally:
        if instance is not None:
            instance.close()


if __name__ == "__main__":
    raise SystemExit(main())
