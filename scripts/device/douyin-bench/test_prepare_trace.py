import unittest
from analyzers import parse_log
from cadence import script, parse

class PrepareTrace(unittest.TestCase):
    def test_native_network_and_decoder_keep_identity_without_private_data(self):
        line = ('1793632000.001 42 43 I DYBENCH: code=prepare_stage seq=123 mono_ms=1000 '
                'prepare_stage=network_open source_generation=12 is_prewarm=true '
                'network_bytes=0 position_bytes=734193')
        row = parse_log(line + ' cookie=PRIVATE url=PRIVATE')
        self.assertEqual((123, 12, 734193), (row['seq'], row['source_generation'], row['position_bytes']))
        self.assertNotIn('PRIVATE', str(row))
        for bad in ['prepare_stage=private', 'network_bytes=-1', 'playback_state=5']:
            original = 'prepare_stage=network_open' if bad.startswith('prepare_stage') else 'network_bytes=0'
            self.assertIsNone(parse_log(line.replace(original, bad)))

    def test_three_paces_use_one_device_script_and_safe_endpoints(self):
        for pace in (200, 500, 1000):
            body = script(50, pace)
            self.assertIn('input swipe 233 330 233 220 120', body)
            self.assertIn('sleep', body)
            self.assertIn('/proc/uptime', body)
        self.assertEqual(2, len(parse('trial=0 start_ms=1 end_ms=2 status=0\ntrial=1 start_ms=201 end_ms=202 status=0')))
        with self.assertRaises(ValueError): script(201, 500)
        with self.assertRaises(ValueError): script(50, 250)
