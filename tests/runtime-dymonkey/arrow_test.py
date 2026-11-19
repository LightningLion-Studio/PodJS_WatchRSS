"""Verify the production detail arrow in the offline retained renderer."""
import argparse
import json
from math import cos, radians, sin
from pathlib import Path
from statistics import mean

from host import Host, SIZE
from monkey import rotated


class ArrowHost(Host):
    video_rotation = 0.0

    def service(self, request):
        if request["method"] == "video.setTransform":
            self.video_rotation = request["args"]["rotationDeg"]
        super().service(request)


def arrow_points(host, angle):
    """Measure the chevron in picture coordinates from the actual rendered pixels."""
    host.sample()
    center = SIZE / 2
    theta = radians(angle)
    cosine, sine = cos(theta), sin(theta)
    cx, cy = rotated((215, 116), angle)
    middle, ends = [], []
    for y in range(max(0, cy - 14), min(SIZE, cy + 15)):
        for x in range(max(0, cx - 14), min(SIZE, cx + 15)):
            index = 4 * (y * SIZE + x)
            if min(host.pixels[index:index + 3]) < 185:
                continue
            dx, dy = x + .5 - center, y + .5 - center
            picture_x = center + dx * cosine + dy * sine
            picture_y = -dx * sine + dy * cosine
            if not 207 < picture_x < 223:
                continue
            if abs(picture_y) < 1.5:
                middle.append(picture_x)
            elif 2.5 < abs(picture_y) < 6:
                ends.append(picture_x)
    # A left chevron has its point closer to the picture centre than its arms.
    return len(middle) >= 2 and len(ends) >= 2 and mean(middle) + 1.5 < mean(ends)


def dismiss(host):
    if host.state["panel"]:
        host.back()
        host.wait(20)


def rotate_step(host, current):
    host.tap(*rotated((163, 29), current))
    host.wait(3)
    sampled_angle = host.video_rotation
    matches = current < sampled_angle < current + 90 and arrow_points(host, sampled_angle)
    host.wait(20)
    return {"videoAngle": sampled_angle, "matchesArrow": matches}


def check_angle(library, package, angle):
    with ArrowHost(library, package) as host:
        host.wait()
        tween_samples = [rotate_step(host, current) for current in range(0, angle, 90)]
        visible = host.state["rotation"] == angle and arrow_points(host, angle)
        target = rotated((208, 116), angle)
        host.tap(*target)
        host.wait(20)
        tap = bool(host.state["panel"])
        dismiss(host)

        host.touch_path([rotated((171, 116), angle), rotated((116, 116), angle),
                         rotated((61, 116), angle)])
        host.wait(20)
        swipe = bool(host.state["panel"])
        dismiss(host)

        before = host.state["index"]
        host.touch_path([rotated((116, 170), angle), rotated((116, 116), angle),
                         rotated((116, 63), angle)])
        host.wait(35)
        retained = (host.state["index"] != before and host.state["rotation"] == angle
                    and arrow_points(host, angle))
        # Use the transparent part of the touch target after switching sources.
        host.tap(*rotated((198, 116), angle))
        host.wait(20)
        retained_hit = bool(host.state["panel"])
        dismiss(host)

        host.tap(*rotated((227, 116), angle))
        host.wait(20)
        rim_hit = bool(host.state["panel"])
        dismiss(host)

        stale_hit = False
        if angle:
            host.tap(208, 116)
            host.wait(20)
            stale_hit = bool(host.state["panel"])
            dismiss(host)

        full_turn = None
        if angle == 270:
            tween_samples.append(rotate_step(host, angle))
            full_turn = host.state["rotation"] == 0 and arrow_points(host, 0)
        return {"angle": angle, "positionAndDirection": visible, "tap": tap,
                "pictureLeftSwipe": swipe, "retainedAfterPaging": retained,
                "retainedHit": retained_hit, "rimHit": rim_hit, "staleHit": stale_hit,
                "tweenSamples": tween_samples, **({"fullTurn": full_turn} if angle == 270 else {})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lib", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    args = parser.parse_args()
    cases = [check_angle(args.lib, args.package, angle) for angle in (0, 90, 180, 270)]
    print(json.dumps(cases, indent=2))
    return int(not all(case["positionAndDirection"] and case["tap"] and case["pictureLeftSwipe"]
                       and case["retainedAfterPaging"] and case["retainedHit"] and not case["staleHit"]
                       and not case["rimHit"] and case.get("fullTurn", True)
                       and all(sample["matchesArrow"] for sample in case["tweenSamples"])
                       for case in cases))


if __name__ == "__main__":
    raise SystemExit(main())
