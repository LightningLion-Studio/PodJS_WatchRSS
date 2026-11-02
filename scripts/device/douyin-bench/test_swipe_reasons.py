import unittest
from analyzers import parse_log

class SwipeReasons(unittest.TestCase):
    def test_closed_swipe_reasons_survive_native_event_parsing(self):
        base = '1793640000.001 42 43 I DYBENCH: code=gesture_release seq=12 mono_ms=123 direction=cancel delta=0 reason='
        for reason in ('release', 'boundary', 'threshold', 'cancelled', 'network_prompt'):
            self.assertEqual(reason, parse_log(base + reason)['reason'])
        self.assertNotIn('reason', parse_log(base + 'PRIVATE'))
