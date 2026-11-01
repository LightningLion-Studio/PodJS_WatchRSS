"""PTS-based screenrecord observations; image change is NOT decoded-first-frame proof."""
from __future__ import annotations
import json
import subprocess
from pathlib import Path


def rect(image, box):
    if len(box) != 4 or not (0 <= box[0] < box[2] <= 1 and 0 <= box[1] < box[3] <= 1):
        raise ValueError('ROI must be normalized x0,y0,x1,y1 inside the video content')
    w, h = image.size
    return image.crop(tuple(round(v * (w if i % 2 == 0 else h)) for i,v in enumerate(box)))


def mae(a, b):
    from PIL import ImageChops, ImageStat
    return sum(ImageStat.Stat(ImageChops.difference(a.convert('RGB'), b.convert('RGB').resize(a.size))).mean)/3


def analyze_frames(frames, calibration, *, template=None, previous=None, incoming=None, offsets=None):
    """offsets: {frame_index: upward translation / viewport height}, hand-verified.

    For reverse drags swap references/rotate both video and references 180 degrees.
    Empty/missing reference evidence is never a zero-incident acceptance result.
    """
    roi = calibration['content_roi']
    spinner_roi = calibration['spinner_roi']
    first = None
    first_changed = None
    black = spinner = strip_bad = strip_tested = count = 0
    longest = streak = 0
    spinner_variants = ([template.convert('RGB').rotate(a, resample=2) for a in range(0,360,30)]
                        if template is not None else [])
    rows = []
    window=calibration.get('window_ms',[0,float('inf')])
    if len(window)!=2 or not 0 <= window[0] < window[1]:
        raise ValueError('window_ms must delimit one annotated gesture in video PTS')
    for index, (pts_ms, frame) in enumerate(frames):
        if not window[0] <= pts_ms <= window[1]:
            continue
        content = rect(frame.convert('RGB'), roi).resize((64,64))
        if first is None:
            first = content.copy()
        changed = mae(first, content) >= calibration.get('change_mae', 8)
        if first_changed is None and changed:
            first_changed = pts_ms
        pixels = list(content.get_flattened_data()) if hasattr(content,'get_flattened_data') else list(content.getdata())
        dark = sum(max(p) <= calibration.get('black_level',12) for p in pixels)/len(pixels)
        is_black = dark >= calibration.get('black_fraction',.98)
        black += is_black
        streak = streak+1 if is_black else 0
        longest = max(longest, streak)
        spinner_patch = rect(frame.convert('RGB'), spinner_roi).resize((32,32))
        is_spinner = bool(spinner_variants) and min(mae(spinner_patch,t) for t in spinner_variants) <= calibration.get('spinner_mae',12)
        spinner += is_spinner
        strip_error = None
        offset = (offsets or {}).get(str(index))
        if previous is not None and incoming is not None and offset is not None and .05 <= offset <= .95:
            # Build the expected two-strip image, rather than counting any two colors.
            from PIL import Image
            old = rect(previous.convert('RGB'),roi).resize((64,64))
            new = rect(incoming.convert('RGB'),roi).resize((64,64))
            shift = round(offset*64)
            expected = Image.new('RGB',(64,64))
            expected.paste(old.crop((0,shift,64,64)),(0,0))
            expected.paste(new.crop((0,0,64,shift)),(0,64-shift))
            strip_error = mae(content,expected)
            strip_tested += 1
            strip_bad += strip_error > calibration.get('strip_mae',18)
        rows.append({'frame':index,'pts_ms':pts_ms,'black_fraction':round(dark,4),
                     'spinner':is_spinner,'strip_mae':strip_error})
        count += 1
    qualified = (bool(calibration.get('human_reviewed')) and count > 1 and template is not None
                 and strip_tested > 0 and calibration.get('sync_error_ms',float('inf')) <= 20
                 and 'window_ms' in calibration)
    return {'frames':count,'first_changed_pts_ms':first_changed,'black_gap_frames':black,
            'longest_black_gap_frames':longest,'spinner_frames':spinner,'strip_fail_frames':strip_bad,
            'strip_tested_frames':strip_tested,'calibrated':qualified,
            'sync_error_ms':calibration.get('sync_error_ms'),'seq':calibration.get('seq'),
            'first_frame_proof':'PENDING: changed pixels can be a cover/overlay; use generation-bound host event',
            'frame_stats':rows}


def decode_frames(path):
    """Use actual variable-rate PTS, no invented fixed 30/60 fps timestamps."""
    info = subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries',
                           'frame=best_effort_timestamp_time','-of','json',str(path)],check=True,capture_output=True,text=True)
    stamps = [float(f['best_effort_timestamp_time'])*1000 for f in json.loads(info.stdout)['frames']]
    if len(stamps) > 12000:
        raise ValueError('clip too large; split into <=180 second clips')
    from PIL import Image
    proc = subprocess.Popen(['ffmpeg','-v','error','-i',str(path),'-vf','scale=128:128','-fps_mode','passthrough',
                             '-f','rawvideo','-pix_fmt','rgb24','pipe:1'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        for stamp in stamps:
            data = proc.stdout.read(128*128*3)
            if len(data) != 128*128*3:
                raise ValueError('decoded frame count differs from ffprobe')
            yield stamp, Image.frombytes('RGB',(128,128),data)
        if proc.stdout.read(1):
            raise ValueError('unexpected extra decoded frames')
        if proc.wait(timeout=15) != 0:
            raise ValueError('ffmpeg decode failed')
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def analyze_clip(path, calibration_path):
    from PIL import Image
    config_path = Path(calibration_path)
    config = json.loads(config_path.read_text())
    def load(name):
        file = config.get(name)
        return Image.open(config_path.parent/file).convert('RGB') if file else None
    return analyze_frames(decode_frames(path),config,template=load('template'),previous=load('previous'),
                          incoming=load('incoming'),offsets=config.get('offsets'))
