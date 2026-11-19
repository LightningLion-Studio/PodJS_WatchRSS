"""Measure and check the real QuickJS detail panel with a long offline description."""
import argparse
import ctypes as c
import json
from pathlib import Path

from host import Host
from monkey import require

SCROLL = [(116, y) for y in (168, 159, 150, 141, 132, 123, 114, 105, 97)]


class Perf(c.Structure):
    _fields_ = [(name, c.c_uint32) for name in
                ("size", "fonts", "pending_fonts", "last_font", "async_font", "images")]
    _fields_ += [(name, c.c_uint64) for name in
                 ("frame", "guest", "surface", "snapshot", "generation", "font_total",
                  "font_last", "image_total", "image_last")]


class ProfileHost(Host):
    def __init__(self, library, package):
        super().__init__(library, package)
        self.perf = self.bind("perf_stats", c.c_int, c.c_void_p, c.POINTER(Perf))
        self.frames = []

    def frame(self, point=None, crown=0):
        super().frame(point, crown)
        timing = Perf()
        self.check(self.perf(self.runtime, c.byref(timing)), "frame statistics")
        self.frames.append((timing.guest / 1000, (timing.guest + timing.surface) / 1000))

    def phase(self):
        guest, total = map(sorted, zip(*self.frames))
        result = {"frames": len(guest)}
        for key, values in (("jsMs", guest), ("jsAndSurfaceMs", total)):
            result[key] = {name: values[round((len(values) - 1) * q)]
                           for name, q in (("p50", .50), ("p95", .95), ("max", 1))}
        self.frames.clear()
        return result


def counts(host):
    return host.state["gestures"]


def assert_released(host, expected_recognizers):
    resources = counts(host)
    require(resources["contacts"] == resources["contactOwners"] == resources["velocitySamples"] == 0,
            "a released touch still owns gesture resources")
    require(resources["recognizers"] == expected_recognizers, "detail recognizer survived teardown")


def run(library, package):
    with ProfileHost(library, package) as host:
        host.wait(25)
        host.command("profile")
        host.wait(20)
        player_recognizers = counts(host)["recognizers"]
        host.frames.clear()
        host.touch_path([(171, 116), (116, 116), (61, 116)])
        host.wait(15)
        require(host.state["panel"], "long description panel did not open")
        entry = host.phase()

        host.touch_path(SCROLL)
        host.wait(4)
        early_lines = host.state["detailLines"]
        host.phase()
        # Keep the finger down across Back, then deliver the late move/up.
        host.approve_path(SCROLL[:4])
        for point in SCROLL[:3]:
            host.frame(point=point)
        require(counts(host)["contacts"] == 1, "Back case missed the held contact")
        host.event(t="back")
        host.frame(point=SCROLL[3])
        host.frame()
        host.wait(16)
        require(host.state["entered"] and not host.state["panel"], "Back did not restore the player")
        assert_released(host, player_recognizers)

        host.tap(208, 116)
        host.wait(20)
        host.phase()
        # Profile a full wrap on versions that lay out the whole document.
        host.wait(1000)
        idle = host.phase()

        changed = 0
        max_lines = 0
        visible_lines = []
        before = host.sample()
        for _ in range(30):
            host.touch_path(SCROLL)
            host.wait(8)
            after = host.sample()
            changed += int(after != before)
            before = after
            resources = counts(host)
            require(resources["contacts"] == resources["contactOwners"] == 0,
                    "scroll release left a gesture active")
            lines = host.state["detailLines"]
            visible_lines.append(lines)
            max_lines = max(max_lines, lines)
        scroll = host.phase()

        host.back()
        host.wait(16)
        assert_released(host, player_recognizers)
        host.tap(116, 205)
        host.wait(8)
        require(host.media["state"] == "paused", "play/pause was blocked after leaving detail")
        return dict(entry=entry, settle=idle, scroll=scroll, earlyLines=early_lines,
                    renderedScrolls=changed, visibleLines=visible_lines, maxVisibleLines=max_lines,
                    gesturesAfterBack=counts(host), pssKiB=host.max_pss_kib)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lib", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    result = run(args.lib, args.package)
    print(json.dumps(result, indent=2))
    if args.check:
        require(result["earlyLines"] > 0, "description remained hidden during the first scroll")
        require(result["renderedScrolls"] >= 25, "detail render failed to follow repeated scroll")
        require(result["maxVisibleLines"] <= 14, "detail mounted more than one viewport of lines")


if __name__ == "__main__":
    main()
