import unittest
from analyzers import parse_log
class SwapTrace(unittest.TestCase):
 def line(self,stage,extra=''):
  return f'1793641350.123 123 123 I DYBENCH: code=swap_stage seq=12 mono_ms=123 generation=2 source_generation=4 swap_stage={stage} {extra}'
 def test_closed_native_swap_stages_keep_identity_and_clock(self):
  for stage in 'promote_enter surface_promoted play_command texture_updated rendered_first_frame ui_confirm observer_armed window_commit_1 window_commit_2'.split():
   row=parse_log(self.line(stage));self.assertEqual((row['seq'],row['generation'],row['source_generation'],row['mono_ms']),(12,2,4,123));self.assertEqual(row['swap_stage'],stage)
 def test_unknown_stage_is_rejected_and_private_fields_are_not_persisted(self):
  self.assertIsNone(parse_log(self.line('PRIVATE')))
  row=parse_log(self.line('texture_updated','url=PRIVATE cookie=PRIVATE token=PRIVATE text=PRIVATE'))
  self.assertNotIn('PRIVATE',str(row))
if __name__=='__main__':unittest.main()
