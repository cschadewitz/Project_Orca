"""Exercise the actual managed updater with the checked-in operator store boundary."""
import json
from pathlib import Path
import re
import unittest

import test_release

release = test_release.release


REPO = Path(__file__).resolve().parents[2]


def protocol_version():
    """PROTOCOL_VERSION as packages/protocol/src/version.ts declares it."""
    text = (REPO / "packages" / "protocol" / "src" / "version.ts").read_text()
    match = re.search(r"export const PROTOCOL_VERSION: ProtocolVersion = \{ major: (\d+), minor: (\d+) \};", text)
    if not match:
        raise AssertionError("version.ts no longer declares PROTOCOL_VERSION in the expected form")
    return {"major": int(match[1]), "minor": int(match[2])}


class OperatorCompatibilityTests(unittest.TestCase):
    def setUp(self):
        fixture = test_release.DeploymentTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.old, self.new = fixture.old, fixture.new
        self.root, self.calls = fixture.root, fixture.calls
        self.deployment = fixture.deployment
        self.contract = json.loads((REPO / "release-compatibility.json").read_text())
        # Edit the raw records: metadata() resolves runtime paths, which a record must not hold.
        old_metadata = json.loads((self.old / ".orca-release.json").read_text())
        old_metadata["compatibility"]["storeEpoch"] = "config-generations-v3"
        old_metadata["compatibility"]["protocol"] = {"major": 1, "minor": 10}
        release.write_json(self.old / ".orca-release.json", old_metadata)
        new_metadata = json.loads((self.new / ".orca-release.json").read_text())
        new_metadata["compatibility"] = self.contract
        release.write_json(self.new / ".orca-release.json", new_metadata)

    def test_operator_epoch_blocks_activation_and_recovery_before_service_changes(self):
        # The epoch is the boundary under test; the protocol is whatever this release speaks.
        self.assertEqual(self.contract["storeEpoch"], "operator-journals-v4")
        with self.assertRaisesRegex(RuntimeError, "Store compatibility changed"):
            self.deployment.activate(self.new)
        with self.assertRaisesRegex(RuntimeError, "Store compatibility changed"):
            self.deployment.restore({"previous": str(self.old), "candidate": str(self.new), "token": "t"})
        self.assertEqual((self.root / "current").resolve(), self.old)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.deployment.pending.exists())


    def test_release_contract_protocol_is_the_protocol_package_version(self):
        self.assertEqual(self.contract["protocol"], protocol_version())


if __name__ == "__main__":
    unittest.main()
