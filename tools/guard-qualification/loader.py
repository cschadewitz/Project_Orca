"""Build a reviewed module manifest and the node argv for bound-loader.mjs.

The manifest is created from reviewed bytes; its digest is passed on the command
line by the supervisor, so a manifest swapped on disk refuses. Paths are within
one snapshot root and are never symlinks.
"""
import hashlib
import json
import os
import shutil

from bounds import LOADER_MODULE_LIMIT
from reasons import require

HERE = os.path.dirname(os.path.abspath(__file__))
LOADER = os.path.join(HERE, 'bound-loader.mjs')
FORMATS = frozenset(('module', 'commonjs', 'json'))
NODE_FLAGS = ('--permission', '--disallow-code-generation-from-strings', '--no-addons',
              '--no-experimental-require-module', '--no-experimental-detect-module')


def make_snapshot(root, modules, builtins=()):
    """Copy the loader into root and write a manifest of (relative path, format) entries."""
    require(0 < len(modules) <= LOADER_MODULE_LIMIT, 'loader_manifest_invalid')
    shutil.copyfile(LOADER, os.path.join(root, 'bound-loader.mjs'))
    entries = []
    for path, fmt in modules:
        require(fmt in FORMATS, 'loader_format_unknown')
        with open(os.path.join(root, path), 'rb') as handle:
            data = handle.read()
        entries.append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                        'format': fmt})
    manifest = json.dumps({'version': 1, 'root': root, 'modules': entries, 'builtins': list(builtins)},
                          sort_keys=True).encode()
    with open(os.path.join(root, 'manifest.json'), 'wb') as handle:
        handle.write(manifest)
    return hashlib.sha256(manifest).hexdigest()


def node_argv(node, root, manifest_sha256, entry, extra_flags=()):
    return [node, *NODE_FLAGS, '--allow-fs-read=' + root, *extra_flags, os.path.join(root, 'bound-loader.mjs'),
            os.path.join(root, 'manifest.json'), manifest_sha256, entry]
