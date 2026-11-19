"""Check the rotated detail page with native drawing and touch input."""
import argparse
import json
from pathlib import Path

from arrow_test import ArrowHost, arrow_points, rotate_step
from host import SIZE
from monkey import rotated

ANGLES = (0, 90, 180, 270)
CORNERS = ((5, 5), (227, 5), (5, 227), (227, 227))


def raster(host):
    host.sample()
    return bytes(host.pixels)


def rgb(frame, x, y):
    offset = 4 * (y * SIZE + x)
    return frame[offset:offset + 3]


def ink(frame):
    center = (SIZE - 1) / 2
    return {(x, y) for y in range(SIZE) for x in range(SIZE)
            if (x - center) ** 2 + (y - center) ** 2 < (center - 8) ** 2
            and min(rgb(frame, x, y)) > 100}


def ink_match(expected, actual, angle):
    # Pixel-centre rotations on the 233 by 233 raster are exact permutations.
    last = SIZE - 1
    if angle == 90:
        projected = {(last - y, x) for x, y in expected}
    elif angle == 180:
        projected = {(last - x, last - y) for x, y in expected}
    elif angle == 270:
        projected = {(y, last - x) for x, y in expected}
    else:
        projected = expected
    return round(len(projected & actual) / len(projected | actual), 3)


def picture_swipe(host, angle, points):
    host.touch_path([rotated(point, angle) for point in points])
    host.wait(20)


def check_angle(library, bundle, angle, reference):
    with ArrowHost(library, bundle) as host:
        host.wait()
        for current in range(0, angle, 90):
            rotate_step(host, current)
        before = raster(host)
        target = rotated((208, 116), angle)
        host.tap(*target)
        host.wait(20)
        assert host.state["panel"], f"failed to open the panel at {angle}°"
        opened = raster(host)
        picture_swipe(host, angle, [(116, 170), (104, 160), (104, 78)])
        scrolled = raster(host)
        frames = [ink(opened), ink(scrolled)]
        if reference is None:
            reference = frames

        # Place the first progress row at a known offset independently of the
        # preceding drag, then tap its production forward stepper.
        host.frame(crown=-250000)
        host.wait()
        host.frame(crown=41000)
        host.wait()
        host.tap(*rotated((198, 119), angle))
        host.wait()
        seek = host.media["positionMs"]

        # The pill falls inside the former bottom fade, but inside the round screen.
        host.frame(crown=-250000)
        host.wait()
        host.frame(crown=17250)
        host.wait()
        host.tap(*rotated((116, 214), angle))
        host.wait()
        host.frame(crown=4000)
        host.wait()
        edge_seek = host.media["positionMs"]

        picture_swipe(host, angle, [(61, 116), (116, 116), (171, 116)])
        swipe_back = not host.state["panel"]
        kept_angle = (swipe_back and host.state["rotation"] == angle
                      and arrow_points(host, angle))

        if swipe_back:
            host.tap(*target)
            host.wait(20)
        reopened = bool(host.state["panel"])
        host.back()
        host.wait(20)
        system_back = reopened and not host.state["panel"] and host.state["rotation"] == angle

        return {"angle": angle, "openedInkMatch": ink_match(reference[0], frames[0], angle),
                "scrolledInkMatch": ink_match(reference[1], frames[1], angle),
                "scrollChangedInk": frames[0] != frames[1], "seekMs": seek, "edgeSeekMs": edge_seek,
                "swipeBack": swipe_back, "keptAngle": kept_angle, "systemBack": system_back,
                "circleCorners": all(rgb(before, *point) == rgb(opened, *point)
                                     and rgb(before, *point) == rgb(scrolled, *point)
                                     for point in CORNERS)}, reference


def check_large_viewport(library, bundle, angle):
    with ArrowHost(library, bundle, size=466) as host:
        def point(x, y, turn=angle):
            return tuple(coordinate * 2 for coordinate in rotated((x, y), turn))

        host.wait()
        for current in range(0, angle, 90):
            host.tap(*point(163, 29, current))
            host.wait()
        assert host.state["rotation"] == angle, f"rotate button missed at {angle}°"
        host.tap(*point(208, 116))
        host.wait()
        assert host.state["panel"], f"scaled arrow missed at {angle}°"
        host.frame(crown=41000)
        host.wait()
        host.tap(*point(198, 119))
        host.wait()
        assert host.media["positionMs"] == 4000, f"scaled stepper missed at {angle}°"
        host.touch_path([point(x, 116) for x in (61, 116, 171)])
        host.wait()
        assert not host.state["panel"] and host.state["rotation"] == angle
        return {"angle": angle, "size": host.size, "arrowHit": True,
                "seekMs": host.media["positionMs"], "swipeBack": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lib", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--large-viewport", action="store_true")
    args = parser.parse_args()
    if args.large_viewport:
        print(json.dumps([check_large_viewport(args.lib, args.package, angle) for angle in ANGLES], indent=2))
        return 0
    results, reference = [], None
    for angle in ANGLES:
        result, reference = check_angle(args.lib, args.package, angle, reference)
        results.append(result)
    print(json.dumps(results, indent=2))
    return int(not all(result["openedInkMatch"] >= .8 and result["scrolledInkMatch"] >= .8
                       and result["scrollChangedInk"] and result["seekMs"] == 4000 and result["edgeSeekMs"] == 5000
                       and result["swipeBack"] and result["keptAngle"] and result["systemBack"]
                       and result["circleCorners"] for result in results))


if __name__ == "__main__":
    raise SystemExit(main())
