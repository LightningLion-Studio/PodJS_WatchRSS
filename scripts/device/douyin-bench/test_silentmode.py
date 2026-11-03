import unittest
from analyzers import parse_log,paired
class SilentModeHarnessTest(unittest.TestCase):
 def test_player_endpoints_are_retained_but_never_satisfy_mixer_pair(self):
  a=parse_log('1700000000.100 1 2 I DYBENCH: code=mute_changed seq=1 mono_ms=100 kind=on muted=true')
  b=parse_log('1700000000.120 1 2 I DYBENCH: code=player_audio_applied seq=1 mono_ms=120 kind=on muted=true backend=player url=private')
  self.assertEqual(b['code'],'player_audio_applied');self.assertEqual(b['backend'],'player');self.assertNotIn('url',b)
  self.assertEqual(paired([a,b],'mute_changed','player_audio_applied',require={'backend':'player'})['n'],1)
  self.assertEqual(paired([a,b],'mute_changed','mixer_match',require={'backend':'mixer'})['n'],0)

 def test_ringer_policy_fields_are_closed_and_preserved(self):
  prefix='1700000000.100 1 2 I DYBENCH: code=player_visible seq=1 mono_ms=100 '
  for mode in ('normal','vibrate','silent','unknown'):
   for silence in ('true','false'):
    row=parse_log(prefix+f'ringer_mode={mode} silenced={silence} audio_gain_milli=0 audio_track=true')
    self.assertEqual(row['ringer_mode'],mode);self.assertEqual(row['silenced'],silence)
  for extra in ('ringer_mode=PRIVATE','silenced=PRIVATE'):
   self.assertIsNone(parse_log(prefix+extra))
  self.assertIsNone(parse_log(prefix.replace('code=player_visible','code=entry_start')+'ringer_mode=normal'))
