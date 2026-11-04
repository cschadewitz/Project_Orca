"""Zipapp bootstrap: actual isolated/no-site/no-bytecode flags before CLI imports."""
import sys

if not (sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode):
    sys.stderr.write('use python3 -I -S -B with the reviewed bundle\n')
    raise SystemExit(2)
if sys.version_info < (3, 11) or sys.platform != 'linux':
    sys.stderr.write('Linux Python 3.11 or newer required; do not install or change settings\n')
    raise SystemExit(2)

# Zipapps are a script search-path entry even under -I. Remove that entry
# BEFORE importing bootstrap stdlib so an extra hashlib/json/zipfile.py cannot
# execute before the archive whitelist is checked. The exact reviewed archive
# is restored only after all contents pass. Host stdlib remains a prerequisite.
_archive_path = getattr(__loader__, 'archive', None)
if type(_archive_path) is not str or not _archive_path:
    sys.stderr.write('reviewed bundle unavailable; stop without fallback\n')
    raise SystemExit(2)
sys.path[:] = [entry for entry in sys.path if entry != _archive_path]

import hashlib
import json
import zipfile

try:
    names = ('__main__.py', 'orca_controller_cli.py', 'packet_exporter.py', 'packet_receiver.py', 'SOURCE.json')
    with zipfile.ZipFile(sys.argv[0], 'r') as bundle:
        entries = bundle.infolist()
        if tuple(item.filename for item in entries) != names:
            raise ValueError()
        if bundle.comment:
            raise ValueError()
        for item in entries:
            if (item.compress_type != zipfile.ZIP_STORED or item.file_size > 1048576 or
                    item.compress_size != item.file_size or item.flag_bits != 0 or
                    item.date_time != (1980, 1, 1, 0, 0, 0) or item.create_system != 3 or
                    item.external_attr >> 16 != 0o100644 or item.extra or item.comment):
                raise ValueError()
        raw = bundle.read('SOURCE.json')
        if len(raw) > 65536:
            raise ValueError()
        manifest = json.loads(raw)
        if (type(manifest) is not dict or set(manifest) != {'format', 'source_commit', 'inputs'} or
                manifest['format'] != 'orca-nonsecret-controller-zipapp-v1' or
                type(manifest['source_commit']) is not str or len(manifest['source_commit']) != 40 or
                any(c not in '0123456789abcdef' for c in manifest['source_commit']) or
                type(manifest['inputs']) is not list or len(manifest['inputs']) != 5):
            raise ValueError()
        indexed = {}
        for item in manifest['inputs']:
            if (type(item) is not dict or set(item) != {'path', 'entry', 'bytes', 'sha256'} or
                    type(item['path']) is not str or len(item['path']) > 256 or
                    type(item['bytes']) is not int or not 0 < item['bytes'] <= 1048576 or
                    type(item['sha256']) is not str or len(item['sha256']) != 64 or
                    any(c not in '0123456789abcdef' for c in item['sha256'])):
                raise ValueError()
            if item['entry'] is not None:
                if item['entry'] not in names[:-1] or item['entry'] in indexed:
                    raise ValueError()
                data = bundle.read(item['entry'])
                if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                    raise ValueError()
                indexed[item['entry']] = item
        if set(indexed) != set(names[:-1]):
            raise ValueError()
except BaseException:
    sys.stderr.write('reviewed bundle unavailable; stop without fallback\n')
    raise SystemExit(2) from None

sys.path.insert(0, _archive_path)
from orca_controller_cli import main

raise SystemExit(main(source_commit=manifest['source_commit']))
