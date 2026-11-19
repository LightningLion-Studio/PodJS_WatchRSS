"""Run the production QuickJS/retained UI runtime with a closed mock media port."""
import ctypes as c
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic, sleep

SIZE = 233
PSS_LIMIT_KIB = 250_000
FONT_METRICS = c.CFUNCTYPE(c.c_int, c.c_size_t, c.c_float, c.c_uint32, c.c_uint32,
                          c.POINTER(c.c_uint32))
FONT_GLYPH = c.CFUNCTYPE(c.c_int, c.c_size_t, c.POINTER(c.c_uint16), c.c_size_t, c.c_float,
                        c.c_uint32, c.c_uint32, c.c_uint32, c.c_uint32, c.c_uint32,
                        c.POINTER(c.c_float), c.POINTER(c.c_float), c.POINTER(c.c_float),
                        c.c_void_p, c.c_size_t)


@FONT_METRICS
def font_metrics(_, size, _bold, _density, result):
    cell = int(size + 4)
    for i, value in enumerate((cell, cell, cell - 3, cell)):
        result[i] = value
    return 0


@FONT_GLYPH
def font_glyph(_, text, length, size, _bold, width, height, _baseline, density,
               advance, xoff, yoff, pixels, _length):
    # Model a cold device font cache. Use one synthetic monochrome glyph.
    if length and (0x4E00 <= text[0] < 0x4E00 + 3600 or 0xA000 <= text[0] < 0xA000 + 1100):
        sleep(0.0005)
    advance[0], xoff[0], yoff[0] = size, 0, 0
    row_bytes = width * density * 4
    for y in range(1, min(height * density, int(size * density))):
        c.memset(pixels + y * row_bytes + 4, 255, min(row_bytes - 4, int(size * density) * 4))
    return 0

ALLOWED_CAPABILITIES = [
    "input.touch", "input.rotary", "data.kv", "media.video", "media.audio",
    "runtime.timer", "host.lifecycle",
]


class Config(c.Structure):
    _fields_ = [
        ("size", c.c_uint32), ("target", c.c_char_p), ("abi", c.c_uint32),
        ("raster_density", c.c_uint32), ("width", c.c_uint32), ("height", c.c_uint32),
        ("density", c.c_float), ("shape", c.c_uint32), ("top", c.c_float),
        ("right", c.c_float), ("bottom", c.c_float), ("left", c.c_float),
        ("root", c.c_char_p), ("capabilities", c.c_char_p),
    ]


class Touch(c.Structure):
    _fields_ = [("id", c.c_uint32), ("x", c.c_float), ("y", c.c_float)]


class Frame(c.Structure):
    _fields_ = [
        ("size", c.c_uint32), ("buttons", c.c_uint32), ("analog", c.c_uint32),
        ("touches", c.POINTER(Touch)), ("count", c.c_uint32),
        ("primary", c.c_int32), ("secondary", c.c_int32),
    ]


class DrawList(c.Structure):
    _fields_ = [
        ("words", c.c_void_p), ("count", c.c_size_t), ("hash", c.c_uint64),
        ("number", c.c_uint64), ("changed", c.c_int32),
    ]


class Host:
    prepare_ms = 136

    def __init__(self, library, package, size=SIZE):
        self.lib = c.CDLL(str(library))
        ptr, string, length = c.c_void_p, c.c_char_p, c.c_size_t
        self.create = self.bind("create", ptr, c.POINTER(Config))
        self.destroy = self.bind("destroy", None, ptr)
        self.load_pak = self.bind("load_pak", c.c_int, ptr, string, length)
        self.validate = self.bind("validate_package", c.c_int, ptr, string)
        self.eval = self.bind("eval_bundle", c.c_int, ptr, string, length, string)
        self.snapshot = self.bind("snapshot", c.c_int, ptr, c.POINTER(DrawList))
        self.raster = self.bind("render_rgba", c.c_int, ptr, c.c_uint32, ptr, length)
        self.next_effect = self.bind("poll_effect", string, ptr)
        self.post = self.bind("post_event", c.c_int, ptr, string)
        self.advance = self.bind("frame", c.c_int, ptr, c.POINTER(Frame))
        self.lifecycle = self.bind("set_lifecycle", c.c_int, ptr, c.c_uint32)
        self.error = self.bind("last_error", string)
        self.package = Path(package)
        self.runtime = None
        self.directory = TemporaryDirectory(prefix="dymonkey-")
        self.now = 1000
        self.state = {}
        self.approvals = []
        self.pending = {}
        self.media = dict(ok=True, state="idle", width=180, height=320, speed=1,
                          durationMs=20000, positionMs=0, volume=7 / 15, volumeMax=15, volumeIndex=7,
                          hasRenderedFirstFrame=False, buffered=True)
        self.counters = {name: 0 for name in ("prepare", "play", "pause", "setVolume")}
        self.touch_frames = 0
        self.max_frame_ms = 0
        self.max_decoders = 0
        self.max_pss_kib = 0
        self.samples = 0
        self.size = size
        self.pixels = (c.c_ubyte * (size * size * 4))()

    def bind(self, name, result, *args):
        fn = getattr(self.lib, "pod_runtime_" + name)
        fn.restype, fn.argtypes = result, args
        return fn

    def __enter__(self):
        try:
            return self.open()
        except BaseException:
            self.__exit__()
            raise

    def open(self):
        config = Config(c.sizeof(Config), b"android-watch", 4, 2, self.size * 2, self.size * 2,
                        2, 0, 0, 0, 0, 0, self.directory.name.encode(),
                        json.dumps(ALLOWED_CAPABILITIES).encode())
        self.runtime = self.create(c.byref(config))
        if not self.runtime:
            raise RuntimeError(self.error().decode())
        install_metrics = self.bind("set_system_font_metrics", c.c_int, c.c_void_p, FONT_METRICS, c.c_size_t)
        install_glyph = self.bind("set_system_font_fallback", c.c_int, c.c_void_p, FONT_GLYPH, c.c_size_t)
        self.check(install_metrics(self.runtime, font_metrics, 0), "install fixture font metrics")
        self.check(install_glyph(self.runtime, font_glyph, 0), "install fixture glyphs")
        pak = (self.package / "main.pak").read_bytes()
        manifest = json.loads((self.package / "pod.manifest.json").read_text())
        self.check(self.load_pak(self.runtime, pak, len(pak)), "load pak")
        # The fixture intentionally grants fewer capabilities than the target
        # profile and uses the source bundle for descriptive stack traces.
        manifest.update(capabilities=ALLOWED_CAPABILITIES, bytecode=None)
        self.check(self.validate(self.runtime, json.dumps(manifest).encode()), "validate package")
        bundle = (self.package / "main.js").read_bytes()
        self.check(self.eval(self.runtime, bundle, len(bundle), b"DYMONKEY"), "evaluate fixture")
        self.drain()
        return self

    def __exit__(self, *_):
        if self.runtime:
            self.destroy(self.runtime)
        self.directory.cleanup()

    def check(self, result, operation, accepted=(0,)):
        if result not in accepted:
            raise RuntimeError(f"{operation} ({result}): {self.error().decode()}")

    def event(self, **event):
        self.check(self.post(self.runtime, json.dumps(event).encode()), f"post {event['t']}")

    def result(self, request_id, value):
        self.event(t="service.result", id=request_id, ok=True, value=value)

    def service(self, request):
        method, ident = request["method"], request["id"]
        args = request.get("args", {})
        if method == "runtime.delay":
            self.pending[ident] = (self.now + args["milliseconds"], False)
        elif method == "runtime.afterPaint":
            self.result(ident, {"committed": True})
        elif method == "audio.volumeState":
            self.result(ident, self.media)
        elif method == "video.prepare":
            url = args.get("url", "")
            if url not in {f"file:///fixture-{i}.mp4" for i in range(8)}:
                raise RuntimeError("unexpected media source")
            self.counters["prepare"] += 1
            self.media.update(state="buffering", hasRenderedFirstFrame=False, positionMs=0)
            self.pending[ident] = (self.now + self.prepare_ms, True)
            self.max_decoders = max(self.max_decoders, 1)  # legacy synthetic port
        elif method in ("video.play", "video.pause", "video.retire", "video.stop"):
            action = method.split(".")[1]
            if action in self.counters:
                self.counters[action] += 1
            self.media.update(state={"play": "playing", "pause": "paused", "retire": "paused", "stop": "stopped"}[action])
            self.result(ident, self.media)
        elif method == "video.seek":
            self.media["positionMs"] = args["positionMs"]
            self.result(ident, self.media)
        elif method == "video.setVolume":
            self.counters["setVolume"] += 1
            delta = args.get("crownDirection", 0)
            index = max(0, min(15, self.media["volumeIndex"] + delta))
            self.media.update(volumeIndex=index, volume=index / 15)
            self.result(ident, self.media)
        elif method in ("video.state", "video.setBounds", "video.setTransform", "video.setLoop", "video.frame.clear"):
            self.result(ident, self.media)
        else:
            raise RuntimeError(f"service outside the offline allowlist: {method}")

    def drain(self):
        for _ in range(2048):
            raw = self.next_effect(self.runtime)
            if not raw:
                return
            effect = json.loads(raw)
            kind = effect["t"]
            if kind == "dymonkey.state":
                self.state = effect
            elif kind == "dymonkey.approved":
                self.approvals.append(effect["op"])
            elif kind == "service.request":
                self.service(effect)
            elif kind == "service.cancel":
                self.pending.pop(effect["id"], None)
            elif kind not in ("navigation", "log"):
                raise RuntimeError(f"unexpected host effect: {kind}")
        raise RuntimeError("host effect queue did not drain")

    def frame(self, point=None, crown=0):
        self.now += 17
        self.event(t="dymonkey.input", op="tick")
        for ident, (when, prepare) in list(self.pending.items()):
            if when <= self.now:
                del self.pending[ident]
                if prepare:
                    self.media.update(state="ready", hasRenderedFirstFrame=True)
                self.result(ident, self.media if prepare else None)
        touch = Touch(1, *point) if point else None
        native = Frame(c.sizeof(Frame), 0, 0, c.pointer(touch) if touch else None,
                       int(touch is not None), crown, 0)
        self.touch_frames += int(touch is not None)
        began = monotonic()
        self.check(self.advance(self.runtime, c.byref(native)), "guest frame", (0, 1))
        elapsed = (monotonic() - began) * 1000
        self.max_frame_ms = max(self.max_frame_ms, elapsed)
        if elapsed >= 1000:
            raise RuntimeError(f"guest frame exceeded 1000 ms: {elapsed:.1f}")
        self.drain()

    def command(self, op, **args):
        self.approvals.clear()
        self.event(t="dymonkey.input", op=op, **args)
        self.frame()
        if op not in self.approvals:
            raise RuntimeError(f"missing guest approval: {op}")

    def wait(self, frames=20):
        for _ in range(frames):
            self.frame()

    def tap(self, x, y):
        self.touch_path([(x, y)])

    def approve_path(self, points):
        # Approve the full path before emitting a contact. The fixture rejects
        # on both a reserved rectangle and the live render-tree hit.
        for x, y in points:
            self.command("point", x=x, y=y)

    def touch_path(self, points):
        self.approve_path(points)
        for point in points:
            self.frame(point=point)
        self.frame()

    def back(self):
        self.event(t="back")
        self.frame()

    def sample(self):
        draw = DrawList()
        self.check(self.snapshot(self.runtime, c.byref(draw)), "snapshot")
        self.check(self.raster(self.runtime, 1, self.pixels, len(self.pixels)), "raster")
        if not any(max(self.pixels[i:i + 3]) > 16 for i in range(0, len(self.pixels), 4)):
            raise RuntimeError("black host raster")
        pss = next(int(line.split()[1]) for line in Path("/proc/self/smaps_rollup").read_text().splitlines()
                   if line.startswith("Pss:"))
        self.max_pss_kib = max(pss, self.max_pss_kib)
        self.samples += 1
        if pss > PSS_LIMIT_KIB or self.max_decoders > 3:
            raise RuntimeError(f"resource budget exceeded: pss={pss}, decoders={self.max_decoders}")
        return draw.hash
