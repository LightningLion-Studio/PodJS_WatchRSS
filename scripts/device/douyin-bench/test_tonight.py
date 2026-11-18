import json,unittest
from tonight import completion,decode_bundle,presentation
class Tonight(unittest.TestCase):
 def test_bundle_does_not_accept_timeout_or_parse_failed_state(self):
  self.assertEqual(decode_bundle('Result: Bundle[{ok=true, json={"targetOrdinal":1}, error=}]'),{'targetOrdinal':1})
  for raw in ['Result: Bundle[{ok=false, json=null, error=timeout}]','Result: Bundle[{ok=true, json=null, error=}]']:
   with self.assertRaises(RuntimeError):decode_bundle(raw)
 def test_completion_requires_end_or_native_repeat_not_near_end(self):
  self.assertFalse(completion({'playbackState':'playing','position':999,'durationMs':1000}))
  self.assertTrue(completion({'playbackState':'ended'}))
  self.assertTrue(completion({'playbackState':'playing','completedLoops':1}))
 def test_presentation_requires_matching_sequence_and_generation(self):
  start={'code':'gesture_release','seq':10,'generation':2,'mono_ms':100}
  end={'code':'incoming_first_frame','seq':10,'generation':2,'mono_ms':145}
  self.assertEqual(presentation([start,end]),45)
  for change in [{'seq':11},{'generation':1},{'mono_ms':99}]:
   self.assertIsNone(presentation([start,{**end,**change}]))
  self.assertIsNone(presentation([start,end,end]))

class NaturalReceipt(unittest.TestCase):
 def test_terminal_source_failure_does_not_wait_fifteen_minutes_as_preparing(self):
  from auto_tonight import terminal_player_failure
  event={'code':'error_page','failure_stage':'source','failure_code':'invalid_argument','reason':'exhausted'}
  self.assertTrue(terminal_player_failure([event]))
  self.assertTrue(terminal_player_failure([{**event,'failure_stage':'recovery'}]))
  for change in [{'code':'prepare_stage'},{'reason':'pending'},{'is_prewarm':'true'},{'failure_stage':'capture'}]:self.assertFalse(terminal_player_failure([{**event,**change}]))
 def test_only_a_native_ended_receipt_with_a_real_frame_counts_as_natural_completion(self):
  from auto_tonight import natural_row
  event={'ended':True,'position_ms':10000,'duration_ms':10000,'first_frame_ms':321,'source_ordinal':1,'source_generation':2,'rebuffer_count':1,'dropped_frames':0}
  self.assertTrue(natural_row(event,1)['completed']);self.assertTrue(natural_row(event,1)['stutter_observed'])
  for change in [{'ended':False},{'first_frame_ms':-1},{'duration_ms':0},{'position_ms':9000}]:self.assertFalse(natural_row({**event,**change},1)['completed'])
  row=natural_row(event,1,['native_player_error']);self.assertTrue(row['completed']);self.assertEqual(row['status'],'FAIL')

class NativeStats(unittest.TestCase):
 def test_cache_transfer_receipts_keep_only_numeric_length_range_and_status(self):
  from tonight import cache_transfer_stats
  line='1.000 1 1 I PodMediaCache: upstreamOpen entry=12 position=0 totalBytes=-1 prefixBytes=4096'
  self.assertEqual(cache_transfer_stats(line),{'tag':'PodMediaCache','code':'cache_upstream_open','entry_ordinal':12,'position':0,'total_bytes':-1,'prefix_bytes':4096})
  line='1.000 1 1 I PodMediaCache: range_transfer entry=12 request=2 position=4096 requested_bytes=65536 network_bytes=32768 ttfb_ms=100 read_ms=1000 status=206'
  self.assertEqual(cache_transfer_stats(line)['status'],206)
  self.assertEqual(cache_transfer_stats('PodMediaCache: prefixHit bytes=4096 position=0')['bytes'],4096)
  for text in [line+' https://PRIVATE',line.replace('entry=12','entry=PRIVATE'),'PodMediaCache: PRIVATE=https://PRIVATE']:
   self.assertIsNone(cache_transfer_stats(text))
 def test_completion_requires_a_closed_native_end_receipt(self):
  from tonight import playback_stats
  value=playback_stats(' 123.000 1 1 I PodVideoStats: completed source_ordinal=4 source_generation=2 position_ms=10000 first_frame_ms=321 rebuffer_count=1 dropped_frames=0 duration_ms=10000 ended=1')
  self.assertTrue(value['ended']);self.assertEqual(value['duration_ms'],10000);self.assertEqual(value['code'],'playback_completed')
  self.assertIsNone(playback_stats('PodVideoStats: completed source_ordinal=PRIVATE'))
  self.assertIsNone(playback_stats('PodVideoStats: completed source_ordinal=4 source_generation=2 position_ms=10000 first_frame_ms=321 rebuffer_count=1 dropped_frames=0 duration_ms=10000 ended=1 https://PRIVATE'))

class Runner(unittest.TestCase):
 def test_three_second_hold_starts_after_first_frame(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  clock=[0.];timers=[]
  def advance(seconds):
   clock[0]+=seconds
   for timer in timers:
    if not timer.fired and clock[0]>=timer.at:timer.fired=True;timer.fn()
  class Timer:
   def __init__(self,seconds,fn):self.at=clock[0]+seconds;self.fn=fn;self.fired=False
   def start(self):timers.append(self)
   def join(self):advance(max(0,self.at-clock[0]))
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.picture=lambda _: (Path(tmp)/'image',False)
   swipes=[]
   def swipe(*args,**kw):
    swipes.append(kw);run.events.append({'code':'playback_retired','source_ordinal':7,'source_generation':1,'position_ms':5000,'rebuffer_count':1,'dropped_frames':3,'host_mono':clock[0]})
   run.device=type('FakeDevice',(),{'swipe':swipe})()
   run.shell=lambda _: {'page':'video','targetOrdinal':2,'sourceGeneration':1,'hasRenderedFirstFrame':clock[0]>=2,'firstFrameMs':2000,'nativeSourceOrdinal':7,'reloadCount':2,'playbackState':'playing','position':int(clock[0]*1000),'rebufferCount':0,'droppedFrames':0}
   with patch('tonight.time.monotonic',lambda:clock[0]),patch('tonight.time.sleep',advance),patch('tonight.threading.Timer',Timer):run.item('B',1,0,1)
   row=run.rows[0];self.assertGreaterEqual(clock[0],5);self.assertEqual(row['status'],'PASS');self.assertGreaterEqual(row['observed_after_first_frame_s'],3);self.assertEqual(swipes,[{'duration_ms':600}]);self.assertEqual(row['leave_input_duration_ms'],0);self.assertEqual(row['reloads'],2);self.assertEqual(row['metrics_scope'],'native_retire');self.assertEqual(row['rebuffer_count'],1);self.assertEqual(row['dropped_frames'],3)
 def test_natural_playback_waits_for_network_recovery_and_records_the_stall(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  clock=[0.]
  def advance(seconds):clock[0]+=seconds
  def state(_):
   t=clock[0];pos=t if t<5 else 5 if t<30 else t-25
   return {'page':'video','targetOrdinal':1,'sourceGeneration':2,'hasRenderedFirstFrame':True,'firstFrameMs':200,'playbackState':'ended' if t>=35 else 'paused' if 5<=t<30 else 'playing','position':min(10000,int(pos*1000)),'durationMs':10000,'rebufferCount':int(t>=5),'droppedFrames':0}
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.picture=lambda _: (Path(tmp)/'image',False);run.shell=state
   with patch('tonight.time.monotonic',lambda:clock[0]),patch('tonight.time.sleep',advance):run.item('A',1,0,0)
   row=run.rows[0];self.assertTrue(row['completed']);self.assertEqual(row['status'],'PASS');self.assertTrue(row['stutter_observed']);self.assertEqual(row['stalls_over_15s'],1);self.assertGreaterEqual(row['max_no_progress_ms'],25000)
 def test_natural_playback_does_not_skip_a_slow_start_without_a_terminal_error(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  clock=[0.]
  def advance(seconds):clock[0]+=seconds
  def state(_):
   t=clock[0]
   return {'page':'video','targetOrdinal':1,'sourceGeneration':2,'hasRenderedFirstFrame':True,'firstFrameMs':200,'playbackState':'ended' if t>=50 else 'paused' if t<40 else 'playing','position':min(10000,max(0,int((t-40)*1000))),'durationMs':10000,'rebufferCount':1,'droppedFrames':0}
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.picture=lambda _: (Path(tmp)/'image',False);run.shell=state
   with patch('tonight.time.monotonic',lambda:clock[0]),patch('tonight.time.sleep',advance):run.item('A',1,0,0)
   row=run.rows[0];self.assertTrue(row['completed']);self.assertEqual(row['status'],'PASS');self.assertTrue(row['start_delay_over_30s']);self.assertTrue(row['stutter_observed']);self.assertEqual(row['stalls_over_15s'],1)
 def test_natural_navigation_retries_only_the_same_completed_target(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  clock=[0.];swipes=[]
  def advance(seconds):clock[0]+=seconds
  def state(_):
   moved=bool(swipes);ended=not moved or clock[0]>=6
   return {'page':'video','targetOrdinal':2 if moved else 1,'sourceGeneration':2,'hasRenderedFirstFrame':True,'firstFrameMs':55 if moved else 333,'playbackState':'ended' if ended else 'playing','position':1000 if ended else int((clock[0]-3)*1000),'durationMs':1000,'rebufferCount':0,'droppedFrames':0}
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.picture=lambda _: (Path(tmp)/'image',False);run.shell=state
   run.device=type('Fake',(),{'swipe':lambda *args,**kw:swipes.append(clock[0])})()
   with patch('tonight.time.monotonic',lambda:clock[0]),patch('tonight.time.sleep',advance):run.item('A',1,0,1)
   row=run.rows[0];self.assertTrue(row['completed']);self.assertEqual(row['status'],'PASS');self.assertEqual(row['navigation_retries'],1);self.assertEqual(row['native_prepare_first_frame_ms'],55);self.assertEqual(len(swipes),1)
 def test_b_waits_for_a_slow_first_frame_then_holds_exactly_three_seconds(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  clock=[0.];timers=[]
  def advance(seconds):clock[0]+=seconds
  class Timer:
   def __init__(self,seconds,fn):self.at=clock[0]+seconds;self.fn=fn
   def start(self):pass
   def join(self):
    if self.fn is not None:advance(max(0,self.at-clock[0]));fn=self.fn;self.fn=None;fn()
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.picture=lambda _: (Path(tmp)/'image',False)
   def swipe(*a,**kw):run.events.append({'code':'playback_retired','source_ordinal':7,'source_generation':2,'position_ms':3000,'rebuffer_count':0,'dropped_frames':0,'host_mono':clock[0]})
   run.device=type('Fake',(),{'swipe':swipe})()
   run.shell=lambda _: {'page':'video','targetOrdinal':1,'sourceGeneration':2,'nativeSourceOrdinal':7,'hasRenderedFirstFrame':clock[0]>=40,'firstFrameMs':40000 if clock[0]>=40 else None,'playbackState':'playing' if clock[0]>=40 else 'preparing','position':max(0,int((clock[0]-40)*1000)),'rebufferCount':0,'droppedFrames':0}
   with patch('tonight.time.monotonic',lambda:clock[0]),patch('tonight.time.sleep',advance),patch('tonight.threading.Timer',Timer):run.item('B',1,0,0)
   row=run.rows[0];self.assertEqual(row['status'],'PASS');self.assertEqual(row['native_prepare_first_frame_ms'],40000);self.assertTrue(row['start_delay_over_30s']);self.assertEqual(row['observed_after_first_frame_s'],3)
 def test_unknown_first_frame_time_is_not_a_pass(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from tonight import Run
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.picture=lambda _: (Path(tmp)/'image',False)
   run.shell=lambda _: {'page':'video','targetOrdinal':1,'hasRenderedFirstFrame':True,'playbackState':'ended','position':1000}
   run.item('A',1,0,0)
   self.assertEqual(run.rows[0]['status'],'FAIL');self.assertIn('first_frame_metric_missing',run.rows[0]['errors'])
 def test_unchanged_target_cannot_reuse_the_previous_videos_first_frame_measurement(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  clock=[0.]
  def advance(seconds):clock[0]+=seconds
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.picture=lambda _: (Path(tmp)/'image',False)
   run.device=type('FakeDevice',(),{'swipe':lambda *args,**kw:None})()
   run.shell=lambda _: {'page':'video','targetOrdinal':1,'hasRenderedFirstFrame':True,'firstFrameMs':123,'playbackState':'playing','position':int(clock[0]*1000)}
   with patch('tonight.time.monotonic',lambda:clock[0]),patch('tonight.time.sleep',advance):run.item('B',1,0,1)
   row=run.rows[0];self.assertIn('target_did_not_change',row['errors']);self.assertIsNone(row['native_prepare_first_frame_ms'])
 def test_final_natural_completion_requires_the_next_target_to_reach_playing(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  states=iter([{'targetOrdinal':20,'hasRenderedFirstFrame':True,'playbackState':'ended'},
               {'targetOrdinal':21,'hasRenderedFirstFrame':False,'playbackState':'preparing'},
               {'targetOrdinal':21,'hasRenderedFirstFrame':True,'playbackState':'playing'}])
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');swipes=[];run.swipe=lambda:swipes.append(True);run.shell=lambda _:next(states)
   with patch('tonight.time.sleep',lambda _:None):run.final_transition(20)
   self.assertTrue(run.final_transition_passed);self.assertEqual(swipes,[True]);self.assertTrue(json.loads((run.out/'A-final-transition.json').read_text())['passed'])
 def test_a_transient_state_transport_failure_is_recorded_and_retried_without_restarting_playback(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  import subprocess
  from tonight import Run
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');calls=[]
   class Fake:
    package='com.lightningstudio.watchrss'
    def call(self,args,**kw):
     calls.append(args)
     if len(calls)==1:raise subprocess.CalledProcessError(255,args,stderr='error: closed https://private.invalid/token')
     return 'Result: Bundle[{ok=true, json={"targetOrdinal":10,"position":4000}, error=}]'
   run.device=Fake()
   with patch('tonight.time.sleep',lambda _:None):state=run.shell('douyin.state')
   self.assertEqual(state['position'],4000);self.assertEqual(len(calls),2);self.assertTrue(all(args[-1]=='douyin.state' for args in calls))
   errors=(run.out/'diagnostic-read-errors.jsonl').read_text();self.assertIn('255',errors);self.assertNotIn('private.invalid',errors)
 def test_state_retries_are_bounded_and_navigation_is_never_replayed(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  import subprocess
  from tonight import Run
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');calls=[]
   class Fake:
    package='com.lightningstudio.watchrss'
    def call(self,args,**kw):calls.append(args);raise subprocess.CalledProcessError(255,args,stderr='closed')
   run.device=Fake()
   with patch('tonight.time.sleep',lambda _:None):
    with self.assertRaises(subprocess.CalledProcessError):run.shell('douyin.state')
    self.assertEqual(len(calls),3)
    with self.assertRaises(subprocess.CalledProcessError):run.shell('douyin.open')
    self.assertEqual(len(calls),4)
 def test_binder_state_timeout_is_retried_but_no_incomplete_bundle_is_accepted(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');responses=iter(['Result: Bundle[{ok=false, json=null, error=timeout}]','Result: Bundle[{ok=true, json={"position":1234}, error=}]'])
   run.device=type('Fake',(),{'package':'com.lightningstudio.watchrss','call':lambda *a,**kw:next(responses)})()
   with patch('tonight.time.sleep',lambda _:None):self.assertEqual(run.shell('douyin.state'),{'position':1234})
   self.assertIn('TimeoutError',(run.out/'diagnostic-read-errors.jsonl').read_text())
 def test_interrupt_restores_settings_before_releasing_owner(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  with TemporaryDirectory() as tmp:
   owner=Path(tmp)/'owner';owner.write_text('released\n');run=Run(Path(tmp)/'run')
   values={'screen_brightness':'119','screen_brightness_mode':'0','screen_off_timeout':'30000'}
   class Fake:
    owner='wrss-douyin-noplay';package='com.lightningstudio.watchrss'
    def setting(self,key,value=None):
     if value is not None:values[key]=str(value)
     return values[key]
    def key(self,_):pass
    def call(self,args,**kw):
     if 'start' in args:raise KeyboardInterrupt()
     return ''
   run.device=Fake()
   with patch('tonight.DEFAULT_OWNER',owner):
    with self.assertRaises(KeyboardInterrupt):run.execute(['A'])
   self.assertEqual(owner.read_text().strip(),'released');self.assertEqual(values['screen_brightness'],'119')
   self.assertTrue(json.loads((run.out/'summary.json').read_text())['settings_restored'])

if __name__=='__main__':unittest.main()

class Resources(unittest.TestCase):
 def test_periodic_resource_sample_is_independent_of_item_local_variables(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from tonight import Run
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.shell=lambda _: {'pssKb':120000,'decoderInstances':2}
   run.device=type('Fake',(),{'package':'com.lightningstudio.watchrss','call':lambda _,args:'123' if args[1]=='pidof' else 'TOTAL PSS: 124999'})()
   row=run.sample('B',20,{})
   self.assertEqual(row['dumpsys_pss_kib'],124999);self.assertTrue(row['passed']);self.assertEqual(row['index'],20)

class NativeLogLevel(unittest.TestCase):
 def test_native_stats_are_enabled_before_capture_and_restore_the_original_level(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  level=[''];calls=[]
  class Device:
   package='com.lightningstudio.watchrss'
   def guard(self):pass
   def call(self,args):
    calls.append(args)
    if args[1]=='pidof':return '123'
    if args[1]=='getprop':return level[0]
    level[0]='INFO' if args[-1]=='INFO' else ''
    return ''
  class Capture:
   stdout=iter([])
   def terminate(self):pass
   def wait(self,**kw):return 0
  def spawn(*a,**kw):self.assertEqual(level[0],'INFO');return Capture()
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.device=Device()
   with patch('tonight.subprocess.Popen',spawn):run.logs();run.restore_logs()
   self.assertEqual(level[0],'');self.assertTrue(json.loads((run.out/'native-stats-tag-after.json').read_text())['restored'])

class TransportRecovery(unittest.TestCase):
 def test_reconnect_waits_for_the_named_watch_and_excludes_both_affected_sources(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from tonight import Run
  class Capture:
   def poll(self):return 1
   def wait(self,**kw):return 1
  calls=[]
  class Device:
   package='com.lightningstudio.watchrss'
   def call(self,args,**kwargs):
    calls.append((args,kwargs))
    if args==['wait-for-device']:return ''
    return 'Result: Bundle[{ok=true, json={"nativeSourceOrdinal":8,"sourceGeneration":2}, error=}]'
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.device=Device();run.log=Capture();run.last_state={'nativeSourceOrdinal':7,'sourceGeneration':2};run.logs=lambda suffix:None
   value=run.reconnect('fixture_transport')
   self.assertEqual(value['nativeSourceOrdinal'],8);self.assertEqual(run.recovery_count,1);self.assertEqual(run.interrupted_keys,{(7,2),(8,2)})
   self.assertEqual(calls[0],(['wait-for-device'],{'timeout':45}));self.assertTrue('makeup_required' in (run.out/'collection-interruptions.jsonl').read_text());self.assertEqual(run.rows,[])
 def test_three_distinct_disconnects_in_ten_minutes_stop_the_run(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.disconnect_times=[100,200]
   with patch('tonight.time.monotonic',lambda:300):
    with self.assertRaisesRegex(RuntimeError,'three collection disconnects'):run.reconnect('fixture')
   self.assertEqual(run.rows,[])

class RestartRecovery(unittest.TestCase):
 def test_empty_shell_reply_after_adb_reconnect_remains_one_outage(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  state_calls=[];waits=[]
  class Device:
   package='com.lightningstudio.watchrss'
   def call(self,args,**kw):
    if args==['wait-for-device']:waits.append(args);return ''
    state_calls.append(args)
    return '' if len(state_calls)==1 else 'Result: Bundle[{ok=true, json={"nativeSourceOrdinal":8,"sourceGeneration":2}, error=}]'
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.device=Device();run.logs=lambda _:None
   with patch('tonight.time.sleep',lambda _:None):run.reconnect('fixture')
   self.assertEqual(len(waits),2);self.assertEqual(len(run.disconnect_times),1);self.assertEqual(run.recovery_count,1)
 def test_changed_application_epoch_requests_a_fresh_segment_without_a_playback_failure(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from tonight import Run
  class Device:
   package='com.lightningstudio.watchrss'
   def call(self,args,**kw):return ''
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.device=Device();run.app_pid='123'
   with self.assertRaisesRegex(RuntimeError,'application epoch changed'):run.reconnect('fixture')
   self.assertTrue(run.collection_restart_needed);self.assertFalse(run.transport_halted);self.assertEqual(run.rows,[]);self.assertEqual(len(run.disconnect_times),1)

class BatteryEnvironment(unittest.TestCase):
 def test_low_battery_marks_an_environment_pause_without_a_playback_failure(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from tonight import Run
  class Device:
   def call(self,*a,**kw):return 'USB powered: true\nstatus: 2\nlevel: 19\n'
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.device=Device();run.last_state={'nativeSourceOrdinal':4,'sourceGeneration':2}
   with self.assertRaisesRegex(RuntimeError,'pause for charging'):run.check_battery()
   self.assertTrue(run.environment_pause);self.assertFalse(run.battery_guard_enabled);self.assertEqual(run.rows,[])


class RecoveryDiagnostics(unittest.TestCase):
 def test_failed_start_screenshot_precedes_leaving_the_failed_target(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from unittest.mock import patch
  from tonight import Run
  clock=[0.];actions=[]
  with TemporaryDirectory() as tmp:
   run=Run(Path(tmp)/'run');run.picture=lambda name: (actions.append('capture:'+name) or (Path(tmp)/'image',False))
   run.device=type('FakeDevice',(),{'swipe':lambda *args,**kw:actions.append('swipe')})()
   run.shell=lambda _: {'page':'video','targetOrdinal':2,'sourceGeneration':2,'hasRenderedFirstFrame':True,'playbackState':'paused','position':1,'durationMs':571745}
   with patch('tonight.time.monotonic',lambda:clock[0]),patch('tonight.time.sleep',lambda ms:clock.__setitem__(0,clock[0]+ms)):run.item('B',1,0,1)
   self.assertEqual(run.rows[0]['status'],'FAIL');self.assertIn('playback_start_timeout_150s',run.rows[0]['errors']);self.assertLess(actions.index('capture:B-001-failure-before-leave'),actions.index('swipe'))
 def test_natural_end_retains_reload_counter_when_native_generation_is_reused(self):
  from pathlib import Path
  from tempfile import TemporaryDirectory
  from auto_tonight import AutoRun
  with TemporaryDirectory() as tmp:
   run=AutoRun.__new__(AutoRun);run.out=Path(tmp);run.first_seen={};run.reload_counts={}
   run.shell=lambda _: {'nativeSourceOrdinal':7,'sourceGeneration':2,'reloadCount':2,'hasRenderedFirstFrame':True,'playbackState':'playing'}
   run.current(1);run.shell=lambda _: {'nativeSourceOrdinal':8,'sourceGeneration':2,'reloadCount':0};run.current(2)
   self.assertEqual(run.reload_counts[(7,2)],2);self.assertEqual(run.reload_counts[(8,2)],0)
