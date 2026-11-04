"""Non-live wrappers and public projections; historical orchestration is disabled.

Preparation authorization does not create designation or launch authority.
Public projections cannot reconstruct an original bootstrap capability.
"""
from pathlib import Path
import json
import subprocess
import sys
import tempfile

from controlled_contract import require
from controlled_connected import ConnectedDesignation
from controlled_supervisor import (REPO, OBSERVER_FILES, observe, observer_original, digest, LIMIT, RUN_NS)


def committed_observer():
    measured = observer_original()
    for name in OBSERVER_FILES:
        original = subprocess.run(['git', 'show', measured['gitHead'] + ':tools/owned-read-proof/' + name],
            cwd=REPO, capture_output=True, check=True, timeout=5).stdout
        require(digest(original) == measured['files'][name], 'observer bytes differ from measured committed source')
    return measured


def public_summary(value):
    """Fixed schema, no I/O or exception conversion; never execution authority.

    Drop all supplied strings, hashes, paths and nested diagnostics. Even a valid
    hex string might be a phase token placed in a purported digest field. Private
    originals retain their complete hashes/correlations; this is not that evidence.
    """
    result = {'record': 'observation-public-summary', 'authority': 'none',
              'acceptingToken': None, 'productionEligible': False,
              'observationAuthorized': False,
              'qualification': 'unavailable-public-summary-is-not-authority'}
    if type(value) is not dict:
        result['refusal'] = 'summary-input-refused'
        return result
    if 'refusal' in value or 'diagnosticRefusal' in value:
        result['refusal'] = 'observation-refused'
    for name, low, high in (('traceBytes', 0, LIMIT), ('elapsedNanoseconds', 0, RUN_NS),
                            ('returncode', -255, 255)):
        if name in value:
            item = value[name]
            if type(item) is int and low <= item <= high:
                result[name] = item
            else:
                result['refusal'] = 'summary-field-refused'
    return result


def public_checkpoint(value):
    """At most the two original lane summaries; unknown/deep values are not walked."""
    result = public_summary(value)
    result['record'] = 'observation-public-checkpoint'
    result['attempts'] = []
    if type(value) is not dict:
        return result
    attempts = value.get('attempts', [])
    if type(attempts) is not list or len(attempts) > 2:
        result['refusal'] = 'checkpoint-shape-refused'
        return result
    result['attempts'] = [public_summary(attempt) for attempt in attempts]
    return result


def safe_summary(run, root):
    # Keep the historical signature, but do not read paths, replay objects or
    # private files merely to produce a public projection.
    return public_summary(run.report)


def observe_new(root=None, diagnostic=False):
    raise RuntimeError('non-live preparation: observer launch disabled')
    # Historical orchestration retained for review only; refusal precedes all I/O.
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
        designation = bootstrap.designate_bootstrap(image)
        connected = observe(root, image, 'connected', designation, used, diagnostic)
        checkpoint['attempts'].append(safe_summary(connected, root))
        require(connected.replay is not None, 'connected original observation refused; inspect retained first refusal')
    except BaseException:
        checkpoint['refusal'] = 'observation-refused'
    public = public_checkpoint(checkpoint)
    (root / 'sanitized-checkpoint.json').write_text(json.dumps(public, separators=(',', ':')))
    (root / 'sanitized-checkpoint.json').chmod(0o600)
    return public


def diagnose_bootstrap():
    """Disabled diagnostic wrapper; historical single-attempt body retained."""
    raise RuntimeError('non-live preparation: observer launch disabled')
    # Historical diagnostic orchestration is not an alternate launch entry point.
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
    except BaseException:
        checkpoint['refusal'] = 'observation-refused'
    public = public_checkpoint(checkpoint)
    path = root / 'sanitized-checkpoint.json'
    path.write_text(json.dumps(public, separators=(',', ':')))
    path.chmod(0o600)
    return public


if __name__ == '__main__':
    require(len(sys.argv) == 1, 'controlled observation accepts no command/provider arguments')
    result = observe_new()
    print(json.dumps(result, separators=(',', ':')), flush=True)
    sys.exit(1 if 'refusal' in result else 2)
