import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from analyzers import (parse_log,paired,quantiles,framestats,meminfo,memory_slope,
                       audio_state,restore_coverage,evaluate)
from bench import Device,Screen,require_player,run
from video import analyze_frames

CFG=json.loads((Path(__file__).parent/'thresholds.json').read_text())


def event(code,t,seq=1,**fields):
    return {'tag':'DYBENCH','code':code,'t_ms':t,'mono_ms':t,'seq':seq,**fields}


class Logs(unittest.TestCase):
    def test_epoch_whitespace_allowlist_and_secrets(self):
        raw='         1800000000.125 12 13 I DYBENCH: code=gesture_release seq=2 direction=next token=SECRET url=https://private'
        self.assertEqual(parse_log(raw),{'tag':'DYBENCH','t_ms':1800000000125,'code':'gesture_release','seq':2,'direction':'next'})
        self.assertIsNone(parse_log(raw.replace('DYBENCH','RandomTag')))
        self.assertIsNone(parse_log(raw.replace('gesture_release','secret_text')))
        self.assertNotIn('SECRET',json.dumps(parse_log(raw)))

    def test_browser_diagnostic_not_terminal(self):
        for code in ['browser_script_error','service_closed','webview_renderer_gone','webview_http_503','webview_load_-2','browser_qr_timeout']:
            self.assertEqual(parse_log(f'1800000000.125 12 13 W PodBrowserAuth: code={code}')['code'],code)

    def test_cloud_activity_not_restore_idle(self):
        value=parse_log('1800000000.125 12 13 I PodJSCloudWorker: finished status=continued code=completed token=PRIVATE')
        self.assertEqual(value['code'],'worker_finished')
        self.assertFalse(restore_coverage([value],1800000000125,1800000000125,'idle'))

    def test_nearest_rank(self):
        self.assertEqual(quantiles(range(1,31)),{'n':30,'p50':15,'p95':29,'max':30})
        self.assertIsNone(quantiles([])['p95'])

    def test_pairing_duplicate_missing_and_clock_reversal(self):
        rows=[event('a',100),event('b',150)]
        self.assertEqual(paired(rows,'a','b')['max'],50)
        self.assertEqual(paired(rows+[event('b',160)],'a','b')['missing'],1)
        self.assertEqual(paired([event('a',100),event('b',90)],'a','b')['missing'],1)
        self.assertEqual(paired([event('a',100)],'a','b')['missing'],1)
        rows[0].pop('mono_ms')
        self.assertEqual(paired(rows,'a','b')['n'],0)

    def test_generation_must_match_incoming_surface(self):
        rows=[event('gesture_release',100,generation=2),event('incoming_first_frame',130,generation=1)]
        self.assertEqual(paired(rows,'gesture_release','incoming_first_frame')['n'],0)

    def test_wrong_attempt_never_pairs(self):
        self.assertEqual(paired([event('a',100,attempt=1),event('b',110,attempt=2)],'a','b')['n'],0)

    def test_actual_audio_not_player_requested_state(self):
        rows=[event('mute_changed',0,kind='on'),event('mixer_match',20,backend='player',muted='true')]
        self.assertEqual(paired(rows,'mute_changed','mixer_match',require={'backend':'mixer'})['n'],0)
        self.assertEqual(audio_state('mRingerModeInternal=0\nMaster mute: on\npack: sample')['actual_output'],'PENDING')

    def test_restore_continuous_heartbeat(self):
        rows=[event('restore_state',t,state='running') for t in (0,1000,2000,3000)]
        self.assertTrue(restore_coverage(rows,500,3500,'running'))
        self.assertFalse(restore_coverage(rows,500,5500,'running'))
        self.assertFalse(restore_coverage(rows,500,3500,'idle'))
        self.assertFalse(restore_coverage(rows[:1]+rows[3:],0,3500,'running'))


class Dumps(unittest.TestCase):
    def test_gfx_deduplicate_flags_sentinels_jank(self):
        raw='---PROFILEDATA---\nFlags,IntendedVsync,Vsync,FrameCompleted,\n0,100,100,10000100,\n0,200,200,30000200,\n1,300,300,40000300,\n0,400,400,9223372036854775807,\n---PROFILEDATA---\n'
        result=framestats(raw+raw)
        self.assertEqual(result['n'],2)
        self.assertEqual(result['jank_percent'],50)
        self.assertEqual(result['p95'],30)
        self.assertEqual(framestats('Permission denied')['n'],0)
        self.assertEqual(framestats(raw,bounds_ns=(200,30000200))['n'],1)

    def test_meminfo_formats_and_process_restarts(self):
        self.assertEqual(meminfo(' TOTAL PSS: 12345 TOTAL RSS: 9'),12345)
        self.assertEqual(meminfo(' TOTAL 4567 123 456'),4567)
        self.assertIsNone(meminfo('not available'))
        samples=[{'pid':10,'t_ms':i*60000,'pss_kib':10240+i*1024,'role':'app'} for i in range(6)]
        samples.append({'pid':11,'t_ms':360000,'pss_kib':999999,'role':'app'})
        result=memory_slope(samples)
        self.assertAlmostEqual(result[0]['mib_per_minute'],1)
        self.assertIsNone(result[1]['mib_per_minute'])


class Safety(unittest.TestCase):
    def test_automated_swipe_requires_fresh_unobscured_player(self):
        good=[event('player_visible',1000,state='present')]
        require_player(good,1500)
        for rows in ([],[event('player_visible',1000,state='absent')],
                     good+[{'tag':'PodBrowserAuth','code':'requested','t_ms':1100}],
                     good+[event('error_page',1100,reason='exhausted')]):
            with self.assertRaises(RuntimeError):require_player(rows,1500)
        with self.assertRaises(RuntimeError):require_player(good,4001)

    def test_prewarm_and_ring_observations_keep_only_closed_fields(self):
        row=parse_log('1793500000.0 1 1 I DYBENCH: code=prewarm_ready seq=7 mono_ms=100 generation=2 buffered_ms=1200 url=PRIVATE')
        self.assertEqual(row['code'],'prewarm_ready')
        self.assertEqual(row['buffered_ms'],1200)
        self.assertNotIn('url',row)
        row=parse_log('1793500000.0 1 1 I DYBENCH: code=background_gate seq=7 mono_ms=100 state=paused reason=foreground_media')
        self.assertEqual(row['reason'],'foreground_media')
        self.assertEqual(row['state'],'paused')

    def test_live_requires_execute_and_logout_opt_in_before_device_work(self):
        from argparse import Namespace
        args=Namespace(execute=False,scenario='logout',record=False,allow_logout=False)
        with patch('bench.Device') as device:
            with self.assertRaises(ValueError):run(args)
            args.execute=True
            with self.assertRaises(ValueError):run(args)
            args.scenario='login';args.record=True
            with self.assertRaises(ValueError):run(args)
            device.assert_not_called()

    def test_wrong_owner_blocks_all_adb(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'owner'
            path.write_text('someone-else')
            device=Device('wrss-dybench',path)
            with patch('subprocess.run') as run:
                with self.assertRaises(PermissionError):
                    device.key(223)
                run.assert_not_called()

    def test_no_phone_install_data_clear_or_account_actions(self):
        d=Device('wrss-dybench')
        with self.assertRaises(ValueError): d.key(131)
        with self.assertRaises(ValueError): d.swipe('like')
        with self.assertRaises(ValueError): d.setting('wifi_on','0')
        with self.assertRaises(ValueError): d.dumps('package','clear')
        with self.assertRaises(ValueError): d.recording('/sdcard/other.mp4')
        with self.assertRaises(ValueError): Device('wrss-dybench',package='phone.app')

    def test_setting_restoration_on_failure_and_null(self):
        class Fake:
            def __init__(self):
                self.values={'screen_brightness':'55','screen_brightness_mode':'1','screen_off_timeout':'null'}
                self.keys=[]
            def setting(self,k,v=None):
                if v is not None:self.values[k]=v
                return self.values[k]
            def key(self,k):self.keys.append(k)
        fake=Fake()
        original=dict(fake.values)
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(RuntimeError):
                with Screen(fake,td):
                    self.assertEqual(fake.values['screen_brightness'],'10')
                    raise RuntimeError('fixture failure')
            self.assertEqual(fake.values,original)
            self.assertTrue(json.loads((Path(td)/'screen.json').read_text())['restored'])
            self.assertEqual(fake.keys,[223])

    def test_long_timeout_normalized(self):
        class Fake:
            values={'screen_brightness':'55','screen_brightness_mode':'1','screen_off_timeout':'7200000'}
            def setting(self,k,v=None):
                if v is not None:self.values[k]=v
                return self.values[k]
            def key(self,k):pass
        with tempfile.TemporaryDirectory() as td:
            with Screen(Fake(),td):pass
            state=json.loads((Path(td)/'screen.json').read_text())
            self.assertTrue(state['long_timeout_normalized'])
            self.assertEqual(state['actual']['screen_off_timeout'],'30000')


class Images(unittest.TestCase):
    def test_black_gap_spinner_and_strip_continuity(self):
        from PIL import Image,ImageDraw
        old=Image.new('RGB',(64,64),(200,20,20))
        new=Image.new('RGB',(64,64),(20,20,200))
        strip=old.copy();strip.paste(new.crop((0,0,64,32)),(0,32))
        template=Image.new('RGB',(32,32),(30,30,30))
        ImageDraw.Draw(template).arc((2,2,29,29),0,270,fill='white',width=3)
        spinner=new.copy();spinner.paste(template,(16,16))
        frames=[(0,old),(33,strip),(66,Image.new('RGB',(64,64),'black')),(99,spinner)]
        cfg={'content_roi':[0,0,1,1],'spinner_roi':[.25,.25,.75,.75],'human_reviewed':True,'sync_error_ms':10,'window_ms':[0,100]}
        result=analyze_frames(frames,cfg,template=template,previous=old,incoming=new,offsets={'1':.5})
        self.assertEqual(result['first_changed_pts_ms'],33)
        self.assertEqual(result['black_gap_frames'],1)
        self.assertEqual(result['spinner_frames'],1)
        self.assertEqual(result['strip_tested_frames'],1)
        self.assertEqual(result['strip_fail_frames'],0)
        self.assertTrue(result['calibrated'])
        bad=analyze_frames([(0,old),(40,old)],cfg,template=template,previous=old,incoming=new,offsets={'1':.5})
        self.assertEqual(bad['strip_fail_frames'],1)

    def test_missing_template_or_offsets_never_calibrated(self):
        from PIL import Image
        image=Image.new('RGB',(8,8),'red')
        result=analyze_frames([(0,image),(33,image)],{'content_roi':[0,0,1,1],'spinner_roi':[0,0,1,1]})
        self.assertFalse(result['calibrated'])
        self.assertIsNone(result['first_changed_pts_ms'])
        with self.assertRaises(ValueError):
            analyze_frames([(0,image)],{'content_roi':[0,0,2,2],'spinner_roi':[0,0,1,1]})


class Acceptance(unittest.TestCase):
    def manifest(self,scenario='cold_open'):
        return {'scenario':scenario,'restore':'idle','start_ms':0,'end_ms':1000,
                'log_complete':True,'screen_restored':True}
    def test_empty_data_never_passes(self):
        for scenario in CFG['scenarios']:
            self.assertEqual(evaluate([],self.manifest(scenario),CFG)['status'],'PENDING')

    def test_threshold_fail_and_adequate_samples(self):
        rows=[event('restore_state',0,state='idle')]
        for i in range(5):
            rows.extend([event('entry_start',i,seq=i),event('first_card',100+i,seq=i)])
        result=evaluate(rows,self.manifest(),CFG)
        self.assertEqual(result['status'],'PASS')
        rows[-1]['mono_ms']=10000
        self.assertEqual(evaluate(rows,self.manifest(),CFG)['status'],'FAIL')
        self.assertEqual(evaluate(rows[:3],self.manifest(),CFG)['status'],'PENDING')

    def test_synthetic_never_acceptance_and_crash_detected(self):
        rows=[event('restore_state',0,state='idle')]
        manifest=self.manifest();manifest['synthetic']=True
        self.assertEqual(evaluate(rows,manifest,CFG)['status'],'PENDING')
        rows.append({'tag':'PodBrowserAuth','code':'browser_script_error','t_ms':100})
        self.assertEqual(evaluate(rows,manifest,CFG)['errors'],0)
        rows.append({'tag':'PodBrowserAuth','code':'webview_renderer_gone','t_ms':200})
        self.assertEqual(evaluate(rows,manifest,CFG)['status'],'FAIL')

    def test_login_tap_cannot_clear_auth_and_logout_cannot_refresh(self):
        self.assertEqual(evaluate([event('auth_cleared',0)],self.manifest('login_tap'),CFG)['status'],'FAIL')
        self.assertEqual(evaluate([event('refreshing',0)],self.manifest('logout'),CFG)['status'],'FAIL')

    def test_login_tap_preserves_present_credentials(self):
        rows=[event('auth_state',0,state='present'),event('login_tap',100,attempt=1),
              event('qr_ready',200,attempt=1),event('auth_state',300,state='absent')]
        self.assertEqual(evaluate(rows,self.manifest('login_tap'),CFG)['status'],'FAIL')

    def test_full_synthetic_recording_replay(self):
        from fixtures import generate
        from bench import analyze
        with tempfile.TemporaryDirectory() as td:
            out=Path(td)/'run'
            generate(out)
            result=analyze(out)
            self.assertEqual(result['metrics']['incoming_first_frame_ms']['n'],30)
            self.assertEqual(result['metrics']['incoming_first_frame_ms']['p95'],50)
            self.assertEqual(result['metrics']['incoming_first_frame_ms']['max'],250)
            self.assertEqual(result['status'],'FAIL')
            v=result['video'][0]
            self.assertEqual(v['black_gap_frames'],1)
            self.assertEqual(v['spinner_frames'],1)
            self.assertEqual(v['strip_fail_frames'],0)
            self.assertEqual(v['strip_tested_frames'],4)


if __name__=='__main__':
    unittest.main()
