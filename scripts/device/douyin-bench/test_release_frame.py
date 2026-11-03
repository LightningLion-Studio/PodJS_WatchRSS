import unittest
from analyzers import parse_log
class ReleaseFrameTest(unittest.TestCase):
 def test_visible_frame_is_not_playback_ready(self):
  line='1793663000.001 123 123 I DYBENCH: code=release_frame seq=100 mono_ms=200 generation=3 source_generation=8 target_generation=9 source_ordinal=4 decoded_visible=true playback_ready=false frame_kind=cached'
  event=parse_log(line)
  self.assertEqual(event['decoded_visible'],'true')
  self.assertEqual(event['playback_ready'],'false')
  self.assertEqual(event['target_generation'],9)
  self.assertEqual(event['frame_kind'],'cached')
if __name__=='__main__':unittest.main()
