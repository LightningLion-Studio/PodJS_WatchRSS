"""Exercise consecutive quarter turns, paging and detail on a mock feed."""
import argparse
import json
from pathlib import Path

from arrow_test import ArrowHost, arrow_points
from monkey import rotated
from panel_rotation_test import ink, ink_match, raster

ROTATE_BUTTON = (163, 29)


class CycleHost(ArrowHost):
    def __init__(self, library, bundle):
        super().__init__(library, bundle)
        self.bounds_calls = []
        self.prepared_angles = []
        self.transform_angles = []

    def service(self, request):
        method = request["method"]
        args = request.get("args", {})
        if method == "video.setBounds":
            self.bounds_calls.append((args.get("translateX", 0), args.get("translateY", 0)))
        if method == "video.prepare":
            self.prepared_angles.append(args.get("transform", {}).get("rotationDeg"))
        if method == "video.setTransform":
            self.transform_angles.append(args["rotationDeg"])
        super().service(request)

    def turn(self, angle, direction):
        point = rotated(ROTATE_BUTTON, angle)
        start = len(self.transform_angles)
        self.command("point", x=point[0], y=point[1])
        for _ in range(35 if direction < 0 else 1):
            self.frame(point=point)
        self.frame()
        self.wait(24)
        angles = [angle, *self.transform_angles[start:]]
        deltas = [(b - a + 180) % 360 - 180 for a, b in zip(angles, angles[1:])]
        return bool(deltas) and all(delta * direction >= -1e-6 for delta in deltas) and abs(sum(deltas) - 90 * direction) < 1e-6

    def page(self, angle, direction):
        # Observe video bounds while the finger is down, before resolving the
        # mock neighbour. Keep the end of each motion inside the touch circle.
        points = [(116, 169), (116, 116), (116, 63)]
        if direction < 0:
            points.reverse()
        points = [rotated(point, angle) for point in points]
        for x, y in points:
            self.command("point", x=x, y=y)
        start = len(self.bounds_calls)
        before = self.state["index"]
        for point in points:
            self.frame(point=point)
        self.frame(point=points[-1])
        moves = self.bounds_calls[start:]
        self.frame()
        self.wait(36)
        last = next((movement for movement in reversed(moves) if any(movement)), None)
        dx, dy = (points[-1][axis] - points[0][axis] for axis in (0, 1))
        return {"selected": self.state["index"] == (before + direction) % 8,
                "alongFinger": last is not None and last[0] * dx + last[1] * dy > 0
                and abs(last[0] * dy - last[1] * dx) < 1e-4,
                "bounds": last,
                "preparedAngle": self.prepared_angles[-1],
                "angleAfter": self.state["rotation"]}


def detail(host, angle, reference):
    arrow = arrow_points(host, angle)
    host.tap(*rotated((208, 116), angle))
    host.wait(20)
    shown = bool(host.state["panel"])
    match = 0
    if shown:
        page = ink(raster(host))
        if reference is None:
            reference = page
        match = ink_match(reference, page, angle)
        host.back()
        host.wait(20)
    return {"arrow": arrow, "panelMatch": match,
            "closedAtAngle": shown and not host.state["panel"] and host.state["rotation"] % 360 == angle}, reference


def cycle(library, bundle, direction):
    with CycleHost(library, bundle) as host:
        host.wait()
        reference = None
        samples = []
        correct_tween = True
        for step in range(5):
            angle = (direction * step * 90) % 360
            before_page = host.state["rotation"]
            sample = {"expected": angle, "actual": before_page, "tweenDirection": correct_tween}
            samples.append(sample)
            if before_page % 360 == angle:
                sample.update(next=host.page(angle, 1), previous=host.page(angle, -1))
                info, reference = detail(host, angle, reference)
                sample.update(info)
            if step < 4:
                try:
                    correct_tween = host.turn(host.state["rotation"], direction)
                except RuntimeError as error:
                    sample["nextTurnError"] = str(error).splitlines()[0]
                    break
        return samples


def passed(samples):
    if len(samples) != 5:
        return False
    for sample in samples:
        angle = sample["expected"]
        if sample["actual"] != angle or not sample["tweenDirection"] or not sample["arrow"] or sample["panelMatch"] < .8 or not sample["closedAtAngle"]:
            return False
        for key in ("next", "previous"):
            page = sample[key]
            if not (page["selected"] and page["alongFinger"] and page["angleAfter"] == angle
                    and page["preparedAngle"] == angle):
                return False
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lib", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    args = parser.parse_args()
    results = {"clockwise": cycle(args.lib, args.package, 1),
               "counterclockwise": cycle(args.lib, args.package, -1)}
    print(json.dumps(results, indent=2))
    return int(not all(passed(samples) for samples in results.values()))


if __name__ == "__main__":
    raise SystemExit(main())
