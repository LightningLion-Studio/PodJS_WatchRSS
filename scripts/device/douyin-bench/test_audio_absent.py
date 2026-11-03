import unittest
from analyzers import parse_log

class AudioAbsentTest(unittest.TestCase):
    def event(self, fields):
        return parse_log('1793665013.039 100 100 I DYBENCH: code=previous_audio_absent seq=1024 mono_ms=1000 '+fields)
    def test_absence_is_a_distinct_bounded_receipt(self):
        row=self.event('generation=2 source_generation=3 backend=audiotrack state=absent')
        self.assertIsNotNone(row)
        self.assertEqual(row['code'],'previous_audio_absent')
        self.assertNotIn('audio_track_state',row)
    def test_absence_cannot_claim_stop_or_omit_identity(self):
        for fields in ['generation=2 backend=audiotrack state=absent',
                       'generation=2 source_generation=3 backend=player state=absent',
                       'generation=2 source_generation=3 backend=audiotrack state=present',
                       'generation=2 source_generation=3 backend=audiotrack state=absent audio_ack=pause']:
            self.assertIsNone(self.event(fields))

if __name__=='__main__':unittest.main()
