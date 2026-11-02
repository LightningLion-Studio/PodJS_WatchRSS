import unittest
from analyzers import parse_log
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
