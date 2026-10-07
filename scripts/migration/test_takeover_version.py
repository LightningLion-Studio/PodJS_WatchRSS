import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('ledger', Path(__file__).with_name('allocate_takeover_version.py'))
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)


class VersionLedgerTest(unittest.TestCase):
    def test_forward_after_native_and_recovery(self):
        self.assertEqual(ledger.propose(40, 'podjs'), 1000)
        self.assertEqual(ledger.propose(1000, 'recovery'), 900000)
        self.assertEqual(ledger.propose(900000, 'recovery'), 900001)
        self.assertEqual(ledger.propose(900000, 'podjs'), 1001000)
        self.assertEqual(ledger.propose(1001000, 'recovery'), 1900000)
        self.assertGreater(ledger.propose(999999, 'podjs'), 999999)

    def test_unknown_or_exhausted_code_is_refused(self):
        for highest in (-1, ledger.MAX_CODE, ledger.MAX_CODE + 1):
            with self.assertRaises(ValueError):
                ledger.propose(highest, 'podjs')
        with self.assertRaises(ValueError):
            ledger.propose(ledger.MAX_CODE - 1, 'podjs')


if __name__ == '__main__':
    unittest.main()
