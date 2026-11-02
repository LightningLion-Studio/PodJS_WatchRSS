"""Offline, fail-closed analyzers. Times are epoch milliseconds unless noted."""
from __future__ import annotations
import csv
import io
import math
import re
import json
from pathlib import Path
from collections import Counter

BROWSER_CODES = set('requested opened page_started page_finished qr_ready completed cancelled service_closed unavailable invalid_argument busy browser_script_error webview_renderer_gone webview_unavailable browser_auth_timeout browser_qr_timeout'.split())
# Proposed contract, not evidence that the shipping app emits these codes.
CODES = set('startup_stage home_first_frame entry_start first_card home_entry refresh_start refresh_done gesture_down gesture_release previous_audio_stopped incoming_first_frame spinner_shown snap_back fling_done mute_changed player_audio_applied mixer_match login_entry scan_accepted auth_persisted logout_start logout_feedback needs_login refreshing login_tap auth_cleared restore_state qr_ready renderer_process auth_state player_visible prewarm_requested prewarm_ready prewarm_evicted prewarm_policy background_gate error_page error'.split())
ENUMS = {'startup_stage':set('stock_saved process_start home_mounted home_tap entry_mounted play_tap headers_ready preview_start preview_ready source_ready persist_start persist_done backdrop_start backdrop_done player_mounted prepare_start decoder_configured decoded_first_frame'.split()), 'state': {'running', 'idle', 'unknown', 'present', 'absent', 'paused'}, 'direction': {'next', 'prev', 'cancel', 'fling'},
         'muted': {'true', 'false'}, 'prewarmed': {'true', 'false'}, 'network_stalled': {'true', 'false'}, 'kind': {'on', 'off'},
         'reason': {'stale','capacity','release','failure','bidirectional','single_neighbour','foreground_media','media_stopped','timeout','candidate_retry','exhausted','hidden','network_stalled'}, 'backend': {'mixer', 'player'}}
NUMBERS = {'duration_ms', 'seq', 'attempt', 'delta', 'generation', 'pid', 'mono_ms', 'active_tracks', 'source_generation', 'buffered_ms', 'slots'}
_PLAYER_ERRORS=json.loads((Path(__file__).parent/'player-error-schema.json').read_text())
ENUMS.update({key:set(values)for key,values in _PLAYER_ERRORS['enums'].items()})
NUMBERS.update(_PLAYER_ERRORS['numbers'])
_VISIBILITY={'visibility_reason':set(['ready', 'inactive', 'route_offset', 'lifecycle', 'player_error', 'network_prompt', 'native_hidden', 'native_unfocused']),'player_state':set(['idle', 'preparing', 'buffering', 'ready', 'playing', 'paused', 'ended', 'stopped', 'error', 'unknown']),'has_frame':{'true','false'},'audio_track':{'true','false'},'system_muted':{'true','false'}}
ENUMS.update(_VISIBILITY)
NUMBERS.update({'offset_abs_milli','audio_gain_milli','system_index','system_max'})
EPOCH = re.compile(r'^\s*(\d{9,}(?:\.\d+)?)\s+\d+\s+\d+\s+[VDIWEF]\s+([\w.-]+)\s*:\s*(.*)$')


def parse_log(line):
    """Allowlist fields before persistence; never retain URLs/cookies/QR/free text."""
    m = EPOCH.match(line)
    if not m:
        return None
    stamp, tag, body = m.groups()
    fields = dict(re.findall(r'\b([a-z][a-z0-9_]*)=([a-zA-Z0-9_.-]+)', body))
    code = fields.get('code')
    if tag == 'PodBrowserAuth' and (code in BROWSER_CODES or code and re.fullmatch(r'webview_(?:http_\d{3}|load_-?\d{1,3})',code)):
        return {'t_ms': float(stamp) * 1000, 'tag': tag, 'code': code}
    if tag == 'PodJSCloudWorker':
        # Existing activity evidence is NOT continuous restore-state coverage.
        status = re.search(r'finished status=(success|retry|continued|backoff|guest_failed|yielded|stopped|queue_failed|deadline_exceeded)\b',body)
        if status:
            return {'t_ms':float(stamp)*1000,'tag':tag,'code':'worker_finished','state':status[1]}
        stage = re.search(r'(?:guestStage|stage)=(host|download|decrypt|projection|checkpoint|apply-metadata|apply-books|pull|run)\b',body)
        if stage:
            return {'t_ms':float(stamp)*1000,'tag':tag,'code':'worker_activity','stage':stage[1]}
        return None
    if tag != 'DYBENCH' or code not in CODES:
        return None
    if ('startup_stage'in fields or 'duration_ms'in fields) and code!='startup_stage':return None
    if code=='startup_stage' and fields.get('startup_stage')not in ENUMS['startup_stage']:return None
    if code=='startup_stage' and 'slots'in fields and (fields.get('startup_stage')!='stock_saved'or not fields['slots'].isdigit()or int(fields['slots'])>3):return None
    if 'duration_ms'in fields and (not fields['duration_ms'].isdigit()or int(fields['duration_ms'])>600000):return None
    for key,values in _VISIBILITY.items():
        if key in fields and fields[key]not in values:return None
    if (set(_VISIBILITY)|{'offset_abs_milli','audio_gain_milli','system_index','system_max'}).intersection(fields) and code!='player_visible':return None
    if any(k in fields and (not fields[k].isdigit()or int(fields[k])>1024) for k in ['system_index','system_max']):return None
    if 'audio_gain_milli'in fields and (not fields['audio_gain_milli'].isdigit()or int(fields['audio_gain_milli'])>1000):return None
    if 'offset_abs_milli'in fields and (not fields['offset_abs_milli'].isdigit()or int(fields['offset_abs_milli'])>1000000000):return None
    player_fields=set(_PLAYER_ERRORS['enums'])|set(_PLAYER_ERRORS['numbers'])
    if player_fields.intersection(fields) and code not in {'error','error_page'}:return None
    for key,values in _PLAYER_ERRORS['enums'].items():
        if key in fields and fields[key] not in values:return None
    for key,limit in _PLAYER_ERRORS['numbers'].items():
        if key in fields and (not fields[key].isdigit() or int(fields[key])>limit):return None
    out = {'t_ms': float(stamp) * 1000, 'tag': tag, 'code': code}
    for key in NUMBERS:
        if fields.get(key, '').isdigit():
            out[key] = int(fields[key])
    for key, values in ENUMS.items():
        if fields.get(key) in values:
            out[key] = fields[key]
    return out


def quantiles(values):
    vals = sorted(v for v in values if math.isfinite(v))
    if not vals:
        return {'n': 0, 'p50': None, 'p95': None, 'max': None}
    # Nearest rank, including p50, intentionally conservative for small samples.
    return {'n': len(vals), 'p50': vals[math.ceil(.5 * len(vals)) - 1],
            'p95': vals[math.ceil(.95 * len(vals)) - 1], 'max': vals[-1]}


def paired(events, start, end, *, where=None, require=None):
    """Pair once by seq/attempt, reject duplicate/ambiguous identities and reversed time."""
    where, require = where or {}, require or {}
    starts, ends = {}, {}
    for e in events:
        if e.get('tag') != 'DYBENCH' or e.get('code') not in (start, end):
            continue
        identity = e.get('seq'), e.get('attempt')
        if identity == (None, None):
            continue
        (starts if e['code'] == start else ends).setdefault(identity, []).append(e)
    values, missing = [], 0
    for identity, rows in starts.items():
        if not any(all(s.get(k) == v for k, v in where.items()) for s in rows):
            continue
        targets = ends.get(identity, [])
        if len(rows) != 1 or len(targets) != 1:
            missing += 1
            continue
        a, b = rows[0], targets[0]
        if not all(b.get(k) == v for k, v in require.items()):
            missing += 1
            continue
        if end in ('incoming_first_frame','snap_back','fling_done') and (a.get('generation') is None or a.get('generation') != b.get('generation')):
            missing += 1
            continue
        # Host monotonic timestamps prevent wall-clock jumps and logcat buffering bias.
        if 'mono_ms' not in a or 'mono_ms' not in b or b['mono_ms'] < a['mono_ms']:
            missing += 1
            continue
        values.append(b['mono_ms'] - a['mono_ms'])
    return quantiles(values) | {'missing': missing}


def framestats(raw, budget_ms=1000/60, bounds_ns=None):
    """Deduplicate accumulated gfxinfo snapshots by IntendedVsync/FrameCompleted."""
    frames = {}
    for block in raw.split('---PROFILEDATA---'):
        lines = [line.strip() for line in block.splitlines() if ',' in line]
        for i, line in enumerate(lines):
            if not line.startswith('Flags,IntendedVsync,'):
                continue
            for row in csv.DictReader(io.StringIO('\n'.join(lines[i:]))):
                try:
                    flags = int(row['Flags'])
                    start, end = int(row['IntendedVsync']), int(row['FrameCompleted'])
                    if flags == 0 and 0 < start < end < 2**63-1 and (bounds_ns is None or bounds_ns[0] <= start <= end <= bounds_ns[1]):
                        frames[(start, end)] = (end-start)/1e6
                except (KeyError, ValueError, TypeError):
                    continue
            break
    q = quantiles(frames.values())
    return q | {'jank_percent': 100 * sum(v > budget_ms for v in frames.values()) / len(frames) if frames else None,
                'budget_ms': budget_ms, 'scope': 'HWUI only; Surface/TextureView video presentation requires video evidence'}


def meminfo(raw):
    m = re.search(r'^\s*TOTAL PSS:\s*(\d+)', raw, re.M)
    if not m:
        m = re.search(r'^\s*TOTAL\s+(\d+)\s+\d+', raw, re.M)
    return int(m[1]) if m else None


def memory_slope(samples):
    """Per-process slope after warmup; process restarts never share a regression."""
    groups = {}
    for s in samples:
        if s.get('pss_kib') is not None:
            groups.setdefault((s['pid'], s.get('role', 'app')), []).append(s)
    out = []
    for (pid, role), rows in groups.items():
        rows.sort(key=lambda s: s['t_ms'])
        base = rows[0]['t_ms']
        # First minute is decoder/cache warmup; report short samples as insufficient.
        rows = [s for s in rows if s['t_ms'] - base >= 60000]
        points = [((s['t_ms']-base)/60000, s['pss_kib']/1024) for s in rows]
        slope = None
        if len(points) >= 5 and points[-1][0]-points[0][0] >= 2:
            mx, my = (sum(p[i] for p in points)/len(points) for i in (0, 1))
            denom = sum((x-mx)**2 for x, _ in points)
            slope = sum((x-mx)*(y-my) for x, y in points)/denom if denom else None
        out.append({'pid': pid, 'role': role, 'samples_after_warmup': len(points), 'mib_per_minute': slope,
                    'span_min': points[-1][0]-points[0][0] if points else 0})
    return out


def audio_state(raw):
    """Conservative metadata only. Vendor mixer/focus dumps cannot prove audible PCM."""
    modes = re.findall(r'\bmRingerMode(?:Internal|External)?\s*[=:]\s*(\d+)', raw)
    # A focus grant says nothing about whether a previous decoder is still audible.
    mute = re.findall(r'(?:mMasterMute[=:]\s*|Master mute:\s*)(true|false|on|off)',raw,re.I)
    return {'ringer_modes': [int(v) for v in modes], 'master_mute_observations':[v.lower() for v in mute],
            'focus_entry_count': len(re.findall(r'pack:|packageName=', raw)),
            'actual_output': 'PENDING', 'reason': 'needs calibrated per-track mixer observation or external audio capture'}


def restore_coverage(events, start, end, expected):
    rows = sorted((e for e in events if e.get('tag') == 'DYBENCH' and e.get('code') == 'restore_state'), key=lambda e:e['t_ms'])
    prior = [e for e in rows if e['t_ms'] <= start]
    if not prior or start-prior[-1]['t_ms'] > 2000:
        return False
    selected = [prior[-1]] + [e for e in rows if start < e['t_ms'] <= end]
    return (all(e.get('state') == expected for e in selected)
            and all(b['t_ms']-a['t_ms'] <= 2000 for a,b in zip(selected, selected[1:]))
            and end-selected[-1]['t_ms'] <= 2000)


METRICS = {
 'cold_open': [('first_card_ms','entry_start','first_card',{}, {})],
 'home_entry': [('first_card_ms','home_entry','first_card',{}, {})],
 'refresh': [('refresh_ms','refresh_start','refresh_done',{}, {})],
 'next': [('previous_audio_stop_ms','gesture_release','previous_audio_stopped',{'direction':'next'},{'backend':'mixer'}),
          ('incoming_first_frame_ms','gesture_release','incoming_first_frame',{'direction':'next'}, {})],
 'prev': [('previous_audio_stop_ms','gesture_release','previous_audio_stopped',{'direction':'prev'},{'backend':'mixer'}),
          ('incoming_first_frame_ms','gesture_release','incoming_first_frame',{'direction':'prev'}, {})],
 'cancel': [('snap_back_ms','gesture_release','snap_back',{'direction':'cancel'}, {})],
 'fling': [('two_card_ms','gesture_release','fling_done',{'direction':'fling'},{'delta':2})],
 'soak': [('incoming_first_frame_ms','gesture_release','incoming_first_frame',{}, {}),
          ('previous_audio_stop_ms','gesture_release','previous_audio_stopped',{}, {'backend':'mixer'})],
 'mute': [('mute_on_ms','mute_changed','mixer_match',{'kind':'on'},{'backend':'mixer','muted':'true'}),
          ('mute_off_ms','mute_changed','mixer_match',{'kind':'off'},{'backend':'mixer','muted':'false'})],
 'login': [('qr_ms','login_entry','qr_ready',{}, {}),
           ('after_scan_ms','scan_accepted','auth_persisted',{}, {})],
 'logout': [('feedback_ms','logout_start','logout_feedback',{}, {}),
            ('needs_login_ms','entry_start','needs_login',{}, {})],
 'login_tap': [('qr_ms','login_tap','qr_ready',{}, {})]
}


def evaluate(events, manifest, thresholds, gfx='', memory=(), video=()):
    scenario, mode = manifest['scenario'], manifest['restore']
    begin, end = manifest['start_ms'], manifest['end_ms']
    scoped = [e for e in events if begin <= e['t_ms'] <= end]
    metrics = {}
    reasons = []
    target = thresholds['scenarios'][scenario]
    for name, start, end, where, require in METRICS[scenario]:
        q = paired(scoped, start, end, where=where, require=require)
        limits = thresholds['limits'].get(name, {})
        status = 'PASS'
        if q['n'] < target['n'] or q['missing']:
            status = 'PENDING'
        if q['n'] and any(q.get(k) is not None and q[k] > v for k,v in limits.items()):
            status = 'FAIL'
        metrics[name] = q | {'limits': limits, 'status': status}
    begin, end = manifest['start_ms'], manifest['end_ms']
    coverage = restore_coverage(events, begin, end, mode)
    if not coverage:
        reasons.append('restore mode lacks continuous <=2s heartbeat coverage')
    if not manifest.get('log_complete'):
        reasons.append('log collector completeness unverified')
    if manifest.get('synthetic'):
        reasons.append('SYNTHETIC: analyzer exercise only, never device acceptance')
    if not manifest.get('screen_restored'):
        reasons.append('screen settings restoration unverified')
    counts = Counter(e.get('code') for e in scoped)
    errors = counts['error'] + counts['webview_renderer_gone']
    # These negative assertions need specific emitted UI/auth events, never absence alone.
    semantic_failure = (scenario in ('logout','login_tap') and
                        (counts['refreshing'] > 0 if scenario == 'logout' else counts['auth_cleared'] > 0))
    spinners=[e for e in scoped if e.get('code')=='spinner_shown']
    for spinner in spinners:
        if spinner.get('network_stalled')=='false' or spinner.get('buffered_ms',0)>0:
            semantic_failure=True
        elif spinner.get('network_stalled')!='true' or spinner.get('reason')!='network_stalled' or spinner.get('buffered_ms')!=0:
            reasons.append('spinner lacks explicit zero-buffer/network-stall proof')
    clocks = [e['mono_ms'] for e in scoped if e.get('tag')=='DYBENCH' and 'mono_ms' in e]
    bounds = (min(clocks)*1000000,max(clocks)*1000000) if len(clocks)>1 else None
    graphics = framestats(gfx, thresholds['frame_budget_ms'],bounds)
    graphics['scope_verified'] = bounds is not None
    slopes = memory_slope(memory)
    video_fail = any(v.get('calibrated') and (v.get('black_gap_frames',0)>0 or v.get('spinner_frames',0)>0 or
                     v.get('strip_fail_frames',0)>0) for v in video)
    if scenario in ('next','prev','cancel','fling','soak'):
        if scenario in ('next','prev','soak') and sum(e.get('code')=='gesture_release' and e.get('prewarmed')=='true' for e in scoped)<target['n']:
            reasons.append('prewarmed target coverage below required sample count')
        release_ids={e.get('seq') for e in scoped if e.get('code')=='gesture_release' and e.get('seq') is not None}
        video_ids={v.get('seq') for v in video if v.get('calibrated') and v.get('seq') in release_ids}
        if len(video_ids) < target['n'] or any(not v.get('calibrated') for v in video):
            reasons.append('calibrated video windows below required sample count')
        if bounds is None:
            reasons.append('HWUI run clock boundaries missing; cumulative frames are unscoped')
        if graphics['n'] == 0:
            reasons.append('no valid HWUI framestats')
        if scenario == 'soak' and (not slopes or any(s['mib_per_minute'] is None for s in slopes)):
            reasons.append('insufficient per-process memory slope samples')
    if scenario == 'soak' and not any(s['role']=='app' for s in slopes):
        reasons.append('app process memory coverage missing')
    if scenario == 'soak' and not (any(s['role']=='renderer_attributed' for s in slopes) or manifest.get('renderer_absent_verified')):
        reasons.append('attributed renderer memory or verified renderer absence missing')
    if scenario == 'soak' and not manifest.get('renderer_attribution'):
        reasons.append('WebView renderer PIDs not attributed to this app; candidates alone are insufficient')
    if scenario == 'mute' and not manifest.get('audio_adapter_reviewed'):
        reasons.append('audible PCM verification requires calibrated mixer adapter/external capture; focus is insufficient')
    if scenario == 'mute' and not manifest.get('mute_restored_by_operator'):
        reasons.append('original system mute state restoration unverified')
    if scenario == 'login_tap':
        states=[e for e in scoped if e.get('code')=='auth_state']
        taps=[e for e in scoped if e.get('code')=='login_tap']
        if len(states)<2 or not taps or not (states[0]['t_ms'] <= taps[0]['t_ms'] <= states[-1]['t_ms']):
            reasons.append('auth-state snapshots before/after login tap missing')
        elif states[0].get('state')=='present' and states[-1].get('state')=='absent':
            semantic_failure=True
    if scenario in ('logout','login_tap') and counts['needs_login'] < (target['n'] if scenario == 'logout' else 1):
        reasons.append('needs_login entry-state coverage missing')
    failed = (errors > 0 or semantic_failure or video_fail or any(m['status']=='FAIL' for m in metrics.values()) or
              graphics['scope_verified'] and graphics['jank_percent'] is not None and graphics['jank_percent'] > thresholds['jank_percent_max'] or
              any(s['mib_per_minute'] is not None and s['mib_per_minute'] > thresholds['memory_mib_per_minute_max'] for s in slopes))
    return {'status': 'FAIL' if failed else 'PENDING' if reasons or any(m['status']=='PENDING' for m in metrics.values()) else 'PASS',
            'scenario':scenario,'restore':mode,'metrics':metrics,'reasons':reasons,
            'errors':errors,'browser_codes':dict(Counter(e['code'] for e in events if e.get('tag')=='PodBrowserAuth')),
            'semantic_failure':semantic_failure,'restore_verified':coverage,'gfx':graphics,'memory':slopes,'video':list(video),
            'video_summary':{key:quantiles([v[key] for v in video if v.get(key) is not None])
                             for key in ('black_gap_frames','spinner_frames','strip_fail_frames','longest_black_gap_frames','first_changed_pts_ms')}}
