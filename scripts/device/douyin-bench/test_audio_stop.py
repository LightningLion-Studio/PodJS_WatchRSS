import unittest
from analyzers import parse_log,paired,METRICS
class AudioStopTests(unittest.TestCase):
 def event(self,code,at,**kw):return dict(tag='DYBENCH',code=code,seq=7,generation=3,source_generation=9,pid=12,mono_ms=at,**kw)
 def test_real_track_ack_pairs_at_native_time(self):
  start=self.event('gesture_release',100,direction='next');end=self.event('previous_audio_stopped',125,backend='audiotrack',audio_ack='pause',audio_track_state='paused')
  require=METRICS['next'][0][-1]
  self.assertEqual(paired([start,end],'gesture_release','previous_audio_stopped',require=require)['p95'],25)
  for field,value in [('generation',4),('source_generation',10),('pid',13),('audio_ack','request'),('audio_track_state','playing'),('backend','player')]:
   self.assertEqual(paired([start,{**end,field:value}],'gesture_release','previous_audio_stopped',require=require)['n'],0)
 def test_parser_rejects_incomplete_or_misplaced_native_ack(self):
  prefix='1700000000.125 12 13 I DYBENCH: '
  body='code=previous_audio_stopped seq=7 generation=3 source_generation=9 backend=audiotrack audio_ack=pause audio_track_state=paused mono_ms=125'
  self.assertIsNotNone(parse_log(prefix+body))
  for invalid in [body.replace(' audio_ack=pause',''),body.replace('state=paused','state=playing'),body.replace('code=previous_audio_stopped','code=mixer_match'),body.replace('backend=audiotrack','backend=player')]:self.assertIsNone(parse_log(prefix+invalid))
if __name__=='__main__':unittest.main()
