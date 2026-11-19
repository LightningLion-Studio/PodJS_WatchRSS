"""Seeded, replayable, fail-closed input for the offline Douyin player fixture."""
import argparse
import json
from math import cos, radians, sin
from pathlib import Path
import random
import selectors
import subprocess
import sys

from host import Host

KINDS = (
    "up", "down", "rotate", "sidebar_open", "sidebar_close", "crown_up",
    "crown_down", "play_pause", "back", "reenter", "screen_cycle", "background_cycle",
)
QUARTERS = {0, 90, 180, 270}
FORBIDDEN = ("like", "follow", "comment", "favorite", "share", "login", "logout")
PROBE_EVERY = 16
STEP_TIMEOUT = 5


def generate(seed, steps):
    rng = random.Random(seed)
    required = [["rotate", 20] for _ in QUARTERS]
    required.extend([["up", 20], ["down", 20], ["play_pause", 0], ["sidebar_open", 15],
                     ["sidebar_close", 20], ["crown_up", 20], ["crown_down", 0],
                     ["screen_cycle", 0], ["background_cycle", 0], ["back", 0],
                     ["reenter", 0], ["up", 0], ["background_cycle", 5]])
    return (required + [[rng.choice(KINDS), rng.choice((0, 0, 1, 2, 4, 10, 20))]
                        for _ in range(max(0, steps - len(required)))])[:steps]


def require(value, message):
    if not value:
        raise RuntimeError(message)


def rotated(point, angle):
    x, y = (v - 116.5 for v in point)
    theta = radians(angle)
    return round(116.5 + x * cos(theta) - y * sin(theta)), round(116.5 + x * sin(theta) + y * cos(theta))


class Monkey:
    def __init__(self, host):
        self.host = host
        self.coverage = set()
        self.angles = set()
        self.interleaved = 0
        self.probes = 0

    def step(self, kind, delay):
        h = self.host
        route, sidebar = h.state["entered"], h.state["sidebar"]
        angle = h.state.get("rotation", 0)
        quarter = round(angle / 90) * 90
        if abs(angle - quarter) < 0.01:
            self.angles.add(quarter % 360)
        busy = h.media["state"] == "buffering" or abs(angle - quarter) >= 0.01
        if kind in ("up", "down") and route:
            points = [(116, 167), (116, 116), (116, 66)]
            if kind == "down":
                points.reverse()
            h.touch_path([rotated(p, angle) for p in points])
        elif kind == "rotate" and route and h.state["arrow"] and abs(angle - quarter) < 0.01:
            h.tap(*rotated((163, 29), angle))
        elif kind == "sidebar_open" and route and h.state["arrow"]:
            h.tap(*rotated((208, 116), angle))
        elif kind == "sidebar_close" and sidebar:
            h.touch_path([rotated(p, angle) for p in [(56, 116), (116, 116), (172, 116)]])
        elif kind in ("crown_up", "crown_down") and route:
            h.frame(crown=10000 if kind == "crown_up" else -10000)
        elif kind == "play_pause" and route and h.state["arrow"] and abs(angle - quarter) < 0.01:
            self.toggle_play(angle)
        elif kind == "back" and route:
            h.back()
        elif kind == "reenter" and not route:
            h.command("enter")
        elif kind in ("screen_cycle", "background_cycle"):
            inactive = 1 if kind == "screen_cycle" else 2
            if inactive == 1:
                h.event(t="checkpoint", reason="screen-off")
            h.check(h.lifecycle(h.runtime, inactive), "suspend")
            h.frame()
            h.check(h.lifecycle(h.runtime, 0), "resume")
            h.frame()
        else:
            h.wait(delay)
            return
        self.coverage.add(kind)
        self.interleaved += int(busy)
        h.wait(delay)

    def toggle_play(self, angle):
        self.host.tap(*rotated((116, 205), angle))

    def probe(self):
        h = self.host
        h.wait(90)  # Settle the crown capsule before targeting the detail arrow.
        if not h.state["entered"]:
            h.command("enter")
            h.wait(25)
        if h.state["sidebar"]:
            h.back()
            h.wait(15)
        require(h.state["entered"] and not h.state["sidebar"], "back did not return from detail")
        if not h.state["arrow"]:
            h.tap(116, 116)
            h.wait(20)
        require(h.state["arrow"], "detail arrow unavailable")
        h.tap(*rotated((208, 116), h.state["rotation"]))
        h.wait(15)
        require(h.state["sidebar"], "detail did not open")
        require(h.media["state"] in ("playing", "paused", "ready") and h.media["hasRenderedFirstFrame"], "media not ready behind detail")
        before = h.sample()
        h.touch_path([rotated(p, h.state["rotation"]) for p in [(116, 166), (116, 116), (116, 66)]])
        h.wait(5)
        require(h.sample() != before and h.state["sidebar"], "detail did not scroll")
        h.back()
        h.wait(15)
        require(h.state["entered"] and not h.state["sidebar"], "detail did not dismiss")
        previous = h.media["state"]
        angle = h.state["rotation"]
        self.toggle_play(angle)
        h.wait(5)
        require(h.media["state"] == ("paused" if previous == "playing" else "playing"),
                "play/pause stopped responding")
        volume = h.counters["setVolume"]
        h.frame(crown=-10000 if h.media["volumeIndex"] > 6 else 10000)
        h.wait(8)
        require(h.counters["setVolume"] > volume, "crown volume stopped responding")
        h.sample()
        self.probes += 1

    def result(self):
        h = self.host
        return dict(coverage=sorted(self.coverage), angles=sorted(self.angles),
                    interleaved=self.interleaved, probes=self.probes, media=h.counters,
                    pssKiB=h.max_pss_kib, mockDecoders=h.max_decoders, rasterSamples=h.samples,
                    maxFrameMs=round(h.max_frame_ms, 2))


def emit(kind, **kwargs):
    print(json.dumps(dict(kind=kind, **kwargs)), flush=True)


def guard_checks(config):
    for index, action in enumerate(FORBIDDEN):
        with Host(config.lib, config.package) as host:
            host.wait()
            host.back()
            host.wait()
            before = host.touch_frames
            try:
                host.tap(210, 48 + index * 22)
            except RuntimeError as error:
                require(f"forbidden Monkey input: {action}" in str(error), str(error))
                require(host.touch_frames == before, "forbidden point advanced to native input")
            else:
                raise RuntimeError(f"forbidden point was approved: {action}")
        with Host(config.lib, config.package) as host:
            host.wait()
            try:
                host.command(action)
            except RuntimeError as error:
                require(f"forbidden Monkey input: {action}" in str(error), str(error))
            else:
                raise RuntimeError(f"forbidden action was approved: {action}")
    emit("result", coordinates=len(FORBIDDEN), actions=len(FORBIDDEN))


def worker(config):
    actions = json.load(sys.stdin)
    index = -1
    stage = "startup"
    try:
        if config.guards:
            guard_checks(config)
            return
        with Host(config.lib, config.package) as host:
            host.wait()
            monkey = Monkey(host)
            if not actions:
                stage = "probe"
                monkey.probe()
            for index, (kind, delay) in enumerate(actions):
                stage = kind
                emit("step", index=index, action=kind, frames=delay, state=host.state,
                     mediaState=host.media["state"])
                require(kind in KINDS and type(delay) is int and 0 <= delay <= 20, "action outside input allowlist")
                monkey.step(kind, delay)
                stage = "sample"
                host.sample()
                if (index + 1) % PROBE_EVERY == 0 or index + 1 == len(actions):
                    stage = "probe"
                    monkey.probe()
            emit("result", **monkey.result())
    except RuntimeError as error:
        emit("failure", stage=stage, index=index, error=str(error))
        raise SystemExit(1)


def execute(config, actions):
    cmd = [sys.executable, "-B", __file__, "--worker", "--lib", str(config.lib),
           "--package", str(config.package)]
    if config.guards:
        cmd.append("--guards")
    with subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0) as child:
        child.stdin.write(json.dumps(actions).encode())
        child.stdin.close()
        events = []
        buffer = b""
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.select(STEP_TIMEOUT):
                chunk = child.stdout.read(65536)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    events.append(json.loads(line))
            else:
                child.kill()
                events.append(dict(kind="failure", stage="watchdog", error="no step progress in 5 seconds",
                                   index=events[-1]["index"] if events else -1))
        code = child.wait(timeout=STEP_TIMEOUT)
    if not events or events[-1]["kind"] not in ("result", "failure") or code and events[-1]["kind"] == "result":
        events.append(dict(kind="failure", stage="process", error=f"worker exit {code}",
                           index=events[-1]["index"] if events else -1))
    return events


def minimize(actions, reproduce):
    """Remove chunks, then individual steps until no single deletion reproduces."""
    granularity = 2
    while actions:
        stride = (len(actions) + granularity - 1) // granularity
        for start in range(0, len(actions), stride):
            proposal = actions[:start] + actions[start + stride:]
            if reproduce(proposal):
                actions = proposal
                granularity = max(2, granularity - 1)
                break
        else:
            if stride == 1:
                return actions
            granularity *= 2
    return actions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lib", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--seed", type=int, default=50641)
    parser.add_argument("--steps", type=int, default=400)
    parser.add_argument("--replay", type=Path, help="Replay the minimized failure from a saved JSON result")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--guards", action="store_true")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    config = parser.parse_args()
    if config.worker:
        worker(config)
        return
    if not config.out:
        parser.error("--out is required")
    if not 0 <= config.steps <= 10000:
        parser.error("--steps must be in 0..10000")
    case = json.loads(config.replay.read_text()) if config.replay else None
    seed = case["seed"] if case else config.seed
    actions = case["minimal"] if case else [] if config.guards else generate(seed, config.steps)
    events = execute(config, actions)
    result = dict(seed=seed, actions=actions, events=events)
    failure = events[-1]
    config.out.write_text(json.dumps(result, indent=2) + "\n")
    if "forbidden Monkey input:" in failure.get("error", ""):
        result["minimal"] = actions[:failure["index"] + 1]
        config.out.write_text(json.dumps(result, indent=2) + "\n")
    elif failure["kind"] == "failure" and not config.guards:
        def signature(event):
            error = event.get("error", "")
            if error.startswith("guest frame exceeded 1000 ms:"):
                error = "guest frame exceeded 1000 ms"
            return event["kind"], event.get("stage"), error

        def matches(candidate):
            return signature(execute(config, candidate)[-1]) == signature(failure)
        prefix = actions[:failure["index"] + 1]
        result["minimal"] = minimize(prefix, matches) if matches(prefix) else prefix
        result["reproduced"] = matches(result["minimal"])
        config.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(dict(seed=seed, **failure)), flush=True)
    return int(failure["kind"] == "failure")


if __name__ == "__main__":
    sys.exit(main())
