"""Observer negative controls; no producer verdict/report is consulted."""
import tempfile
from pathlib import Path
import unittest
from run import observe


class ObserverTests(unittest.TestCase):
    def check_trace(self, text):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            trace = base / 'trace'
            trace.write_text(text.replace('BASE', str(base)))
            return observe(trace, base)

    def test_missing_calibration_refuses(self):
        with self.assertRaises(RuntimeError):
            self.check_trace('')

    def test_short_calibration_refuses(self):
        with self.assertRaises(RuntimeError):
            self.check_trace('1 pread64(17<BASE/observer-calibration>, "x", 4, 0) = 1')

    def test_unexpected_effect_refuses_even_with_calibration(self):
        with self.assertRaises(RuntimeError):
            self.check_trace('1 pread64(17<BASE/observer-calibration>, "test", 4, 0) = 4\n'
                             '1 pread64(18<BASE/orca-owned-service-x/fixture (deleted)>, "x", 1, 0) = 1')

    def test_calibration_is_separate(self):
        self.assertEqual(self.check_trace('1 pread64(17<BASE/observer-calibration>, "test", 4, 0) = 4'),
                         {'calibrationReads': 1, 'serviceReads': 0})


if __name__ == '__main__':
    unittest.main()
