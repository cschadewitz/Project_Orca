"""Exercise the actual managed updater with the checked-in operator store boundary."""
import json
from pathlib import Path
import unittest

import test_release

release = test_release.release


class OperatorCompatibilityTests(unittest.TestCase):
    def setUp(self):
        fixture = test_release.DeploymentTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.old, self.new = fixture.old, fixture.new
        self.root, self.calls = fixture.root, fixture.calls
        self.deployment = fixture.deployment
        self.contract = json.loads((Path(__file__).resolve().parents[2] /
                                    "release-compatibility.json").read_text())
        old_metadata = release.metadata(self.old)
        old_metadata["compatibility"]["storeEpoch"] = "config-generations-v3"
        old_metadata["compatibility"]["protocol"] = {"major": 1, "minor": 10}
        release.write_json(self.old / ".orca-release.json", old_metadata)
        new_metadata = release.metadata(self.new)
        new_metadata["compatibility"] = self.contract
        release.write_json(self.new / ".orca-release.json", new_metadata)

    def test_operator_epoch_blocks_activation_and_recovery_before_service_changes(self):
        self.assertEqual(self.contract["storeEpoch"], "operator-journals-v4")
        self.assertEqual(self.contract["protocol"], {"major": 2, "minor": 0})
        with self.assertRaisesRegex(RuntimeError, "Store compatibility changed"):
            self.deployment.activate(self.new)
        with self.assertRaisesRegex(RuntimeError, "Store compatibility changed"):
            self.deployment.restore({"previous": str(self.old), "candidate": str(self.new), "token": "t"})
        self.assertEqual((self.root / "current").resolve(), self.old)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.deployment.pending.exists())


if __name__ == "__main__":
    unittest.main()
