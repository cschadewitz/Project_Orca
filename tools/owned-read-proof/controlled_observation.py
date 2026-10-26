"""Fixed-source, test-only bootstrap + connected observation. Always incomplete.

No arbitrary command, provider, accepting token or production eligibility. The
parent's explicit preparation authorization designates this exact source model;
neither a report/hash nor CLI input can import a bootstrap capability.
"""
from pathlib import Path
import json
import re
import subprocess
import sys
import tempfile

from controlled_contract import require
from controlled_connected import ConnectedDesignation
from controlled_supervisor import (REPO, OBSERVER_FILES, observe, observer_original, file_digest, digest)


def committed_observer():
    measured = observer_original()
    for name in OBSERVER_FILES:
        original = subprocess.run(['git', 'show', measured['gitHead'] + ':tools/owned-read-proof/' + name],
            cwd=REPO, capture_output=True, check=True, timeout=5).stdout
        require(digest(original) == measured['files'][name], 'observer bytes differ from measured committed source')
    return measured


def safe_summary(run, root):
    value = run.report
    allowed = ('record', 'sourceHead', 'traceBytes', 'traceSha256', 'returncode', 'elapsedNanoseconds',
               'imageProducerSha256', 'imageChildSha256', 'imageBuildSha256')
    result = {k: value[k] for k in allowed if k in value}
    if 'refusal' in value:
        # Never print raw trace lines, producer stderr, phase tokens or protected
        # plaintext. The full original refusal remains in the private packet.
        reason = value['refusal'].replace(str(root), '<attempt>')
        reason = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', reason)
        result['refusal'] = reason[:1000]
    if run.replay is not None:
        result['settledThreads'] = len(run.replay.settled)
        result['serviceReads'] = len(run.replay.resources[0].reads)
        result['finalNamedObservations'] = len(run.original.get('finalPhysicalObservations', {}))
    if 'diagnostic' in value:
        result['diagnostic'] = value['diagnostic']
    result['reportSha256'] = file_digest(run.report_path)
    return result


def observe_new(root=None, diagnostic=False):
    require(type(diagnostic) is bool, 'explicit supervisor diagnostic mode required')
    implementation = committed_observer()
    root = Path(tempfile.mkdtemp(prefix='orca-connected-observation-')) if root is None else Path(root)
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(), 'new original observation root required')
    require({p.name for p in root.iterdir()} <= {'image'}, 'refusing reused observation root')
    image = root / 'image'
    checkpoint = {'record': 'connected-observation-preparation-checkpoint', 'authority': 'none',
                  'root': str(root), 'observerImplementation': implementation, 'attempts': [],
                  'acceptingToken': None, 'productionEligible': False,
                  'diagnostic': diagnostic,
                  'qualification': 'unavailable-independent-aggregate-review-pending'}
    try:
        if not image.exists():
            subprocess.run(['node', str(REPO / 'tools/owned-read-proof/build-controlled.mjs'), str(image)],
                cwd=REPO, check=True, capture_output=True, text=True, timeout=30)
        used = set()
        bootstrap = observe(root, image, used_tokens=used, diagnostic=diagnostic)
        checkpoint['attempts'].append(safe_summary(bootstrap, root))
        # Failure cannot import a designation from the report. This assertion
        # inspects the original supervisor's independently replayed closed graph.
        bootstrap.assert_bootstrap_closed()
        designation = ConnectedDesignation(bootstrap_base=root / 'bootstrap', evidence_path=bootstrap.report_path,
            evidence_ref='controlled-bootstrap-source-preparation:' + bootstrap.report['traceSha256'],
            image=image, assert_bootstrap_closed=bootstrap.assert_bootstrap_closed)
        connected = observe(root, image, 'connected', designation, used, diagnostic)
        checkpoint['attempts'].append(safe_summary(connected, root))
        require(connected.replay is not None, 'connected original observation refused; inspect retained first refusal')
    except BaseException as error:
        checkpoint['refusal'] = type(error).__name__ + ': ' + str(error).replace(str(root), '<attempt>')[:1000]
    (root / 'sanitized-checkpoint.json').write_text(json.dumps(checkpoint, separators=(',', ':')))
    (root / 'sanitized-checkpoint.json').chmod(0o600)
    return checkpoint


def diagnose_bootstrap():
    """Exactly one original diagnostic process, regardless of its outcome.

    The return value is a sanitized report, not a retained graph or designation.
    No connected constructor or command is used in this bounded investigation.
    """
    implementation = committed_observer()
    root = Path(tempfile.mkdtemp(prefix='orca-bootstrap-diagnostic-'))
    image = root / 'image'
    checkpoint = {'record': 'single-original-bootstrap-diagnostic-checkpoint', 'authority': 'none',
                  'root': str(root), 'observerImplementation': implementation, 'attempts': [],
                  'acceptingToken': None, 'productionEligible': False, 'connectedCommandsReleased': False,
                  'qualification': 'unavailable-diagnostic-only-independent-review-pending'}
    try:
        subprocess.run(['node', str(REPO / 'tools/owned-read-proof/build-controlled.mjs'), str(image)],
            cwd=REPO, check=True, capture_output=True, text=True, timeout=30)
        run = observe(root, image, diagnostic=True)
        checkpoint['attempts'].append(safe_summary(run, root))
        run.assert_bootstrap_closed()
        checkpoint['originalBootstrapChecks'] = 'completed-for-this-new-original-only'
    except BaseException as error:
        checkpoint['refusal'] = type(error).__name__ + ': ' + str(error).replace(str(root), '<attempt>')[:1000]
    path = root / 'sanitized-checkpoint.json'
    path.write_text(json.dumps(checkpoint, separators=(',', ':')))
    path.chmod(0o600)
    return checkpoint


if __name__ == '__main__':
    require(len(sys.argv) == 1, 'controlled observation accepts no command/provider arguments')
    result = observe_new()
    print(json.dumps(result, separators=(',', ':')), flush=True)
    sys.exit(1 if 'refusal' in result else 2)
