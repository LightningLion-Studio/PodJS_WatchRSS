import unittest
from analyzers import parse_log, explicit_play_first_frame
class StartupStages(unittest.TestCase):
 def test_closed_stages_and_native_clock(self):
  e=parse_log('1793603025.217 19610 19610 I DYBENCH: code=startup_stage seq=216436468736 mono_ms=211371392 startup_stage=decoder_configured duration_ms=128')
  self.assertEqual(e['mono_ms'],211371392);self.assertEqual(e['duration_ms'],128)
  for body in ['code=startup_stage startup_stage=https://secret','code=entry_start startup_stage=play_tap','code=startup_stage startup_stage=prepare_start duration_ms=-1','code=startup_stage startup_stage=prepare_start duration_ms=600001']:
   self.assertIsNone(parse_log('1793603025.217 19610 19610 I DYBENCH: '+body+' seq=12 mono_ms=10'))

 def test_stock_count_is_closed_and_not_playback_proof(self):
  e=parse_log('1793603025.217 19610 19610 I DYBENCH: code=startup_stage seq=12 mono_ms=10 startup_stage=stock_saved slots=3');self.assertEqual(e['slots'],3)
  self.assertIsNone(parse_log('1793603025.217 19610 19610 I DYBENCH: code=startup_stage seq=12 mono_ms=10 startup_stage=stock_saved slots=4'))
  self.assertIsNone(parse_log('1793603025.217 19610 19610 I DYBENCH: code=startup_stage seq=12 mono_ms=10 startup_stage=prepare_start slots=3'))

class ColdPrepareStagesTest(unittest.TestCase):
 def test_closed_native_prepare_stages(self):
  for stage in ['prepare_admitted', 'player_constructed', 'prepare_dispatched', 'video_format_ready', 'initial_frame_adopted']:
   self.assertEqual(parse_log("1793603025.217 19610 19610 I DYBENCH: code=startup_stage seq=12 mono_ms=10 startup_stage="+stage)["startup_stage"],stage)


class ExplicitPlayFirstFrameTest(unittest.TestCase):
 def event(self, code, mono_ms, seq=12, **fields):
  return dict(tag='DYBENCH', code=code, mono_ms=mono_ms, seq=seq, **fields)

 def test_excludes_cover_dwell_and_other_startup_stages(self):
  rows=[self.event('entry_start',10),self.event('startup_stage',20,startup_stage='entry_mounted'),
        self.event('startup_stage',10000,startup_stage='play_tap'),
        self.event('startup_stage',10005,startup_stage='player_mounted'),self.event('first_card',10120)]
  self.assertEqual(explicit_play_first_frame(rows),dict(n=1,p50=120,p95=120,max=120,missing=0))

 def test_cover_cache_and_hidden_frame_are_not_video_presentation(self):
  cover=[self.event('entry_start',10),self.event('startup_stage',20,startup_stage='entry_mounted'),
         self.event('startup_stage',30,startup_stage='preview_ready'),
         self.event('startup_stage',40,startup_stage='decoded_first_frame'),self.event('prewarm_ready',50)]
  self.assertEqual(explicit_play_first_frame(cover),dict(n=0,p50=None,p95=None,max=None,missing=0))
  play=cover+[self.event('startup_stage',100,startup_stage='play_tap')]
  self.assertEqual(explicit_play_first_frame(play)['missing'],1)
  self.assertEqual(explicit_play_first_frame(play)['n'],0)

 def test_duplicate_mismatched_or_reversed_endpoints_fail_closed(self):
  tap=self.event('startup_stage',100,startup_stage='play_tap');frame=self.event('first_card',120)
  for rows in [[tap,tap,frame],[tap,frame,frame],
               [tap,self.event('first_card',120,seq=13)],[tap,self.event('first_card',90)],
               [tap,dict(tag='DYBENCH',code='first_card',seq=12,t_ms=120)]]:
   self.assertEqual(explicit_play_first_frame(rows)['n'],0)
   self.assertEqual(explicit_play_first_frame(rows)['missing'],1)
