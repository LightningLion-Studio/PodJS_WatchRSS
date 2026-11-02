import unittest
from analyzers import parse_log
class PlayerErrorSchema(unittest.TestCase):
 def test_preserves_only_closed_error_metadata(self):
  row=parse_log('1793597000.000 123 124 I DYBENCH: code=error_page seq=1 mono_ms=2 reason=failure failure_code=resource_exhausted failure_stage=prepare failure_origin=sessions exception_kind=illegal_state media3_code=0 slot_limit=1 decoder_count=1 source_kind=cache content_kind=mp4 is_prewarm=false url=PRIVATE cookie=SECRET')
  self.assertEqual(row['failure_code'],'resource_exhausted');self.assertEqual(row['slot_limit'],1);self.assertNotIn('PRIVATE',str(row));self.assertNotIn('SECRET',str(row))
 def test_rejects_unbounded_or_wrong_event_fields(self):
  for field in ['failure_code=PRIVATE','exception_kind=PRIVATE','slot_limit=4','media3_code=1000001','media3_code=-1','is_prewarm=PRIVATE']:
   self.assertIsNone(parse_log('1793597000.000 123 124 I DYBENCH: code=error_page seq=1 '+field))
  self.assertIsNone(parse_log('1793597000.000 123 124 I DYBENCH: code=entry_start seq=1 failure_code=decode_error'))
