"""Offline inspection of fixed reviewed bytes, never designation or loaded-code proof.

No launcher, observer, subprocess, runtime probe, plan or capability constructor.
All descriptors are acquisition-scoped; returned snapshots own no open resources.
The trusted Python implementation is not protected against same-process mutation.
"""
from contextlib import ExitStack
from dataclasses import dataclass, field
import hashlib
import os
import stat
import sys


REVIEWED_IMAGE_SOURCE = '4ebf382fe6738bb11268b47b048a3d7c7a6f2586'
# Native artifact bytes from the independently rebuilt image, not formatted JSON
# copies and not expected values supplied by a caller or by the candidate itself.
OUTPUTS = (
    ('controlled-build.json', 48027, '889bd46eeec3bf3133bea022591d23ad4a627b2e7bfc73d71fd8c4ecc971d977'),
    ('controlled-child.mjs', 5713, '17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13'),
    ('controlled-producer.mjs', 2248652, '1c0bffce70e7bb70245962590f2f291b68b6afdd35078caa5fd25fbd573e5ff7'),
)
REFUSAL = 'current image inspection refused'


def require(condition):
    if not condition:
        raise RuntimeError(REFUSAL)


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def inventory(directory):
    names = set()
    with os.scandir(directory) as entries:
        for index, entry in enumerate(entries):
            require(index < len(OUTPUTS))
            names.add(entry.name)
    require(names == {name for name, _, _ in OUTPUTS})


def regular_file(physical, size):
    require(stat.S_ISREG(physical[2]) and physical[3] == os.geteuid() and
            not physical[2] & 0o022 and physical[5] == 1 and physical[6] == size)


@dataclass(frozen=True)
class CandidateInspection:
    """A temporal physical snapshot, not an execution or bootstrap capability.

    Serialization, construction or mutation of this object grants no authority.
    There is intentionally no bind, association, authorize, execute or launch API.
    """
    _path: str = field(repr=False)
    _ancestors: tuple = field(repr=False)
    _directory: tuple = field(repr=False)
    _files: tuple = field(repr=False)

    def recheck(self):
        require(inspect_current_image(self._path) == self)

    def report(self):
        self.recheck()
        return {'record': 'offline-current-image-inspection', 'authority': 'none',
                'acceptingToken': None, 'productionEligible': False,
                'observationAuthorized': False, 'loadedImageVerified': False,
                'candidateCorrespondence': 'fixed-reviewed-output-bytes-only',
                'reviewedImageSource': REVIEWED_IMAGE_SOURCE,
                'files': [{'name': name, 'physicalStamp': list(physical), 'sha256': digest}
                          for name, physical, digest in self._files],
                'qualification': 'unavailable-original-run-and-loaded-image-evidence-absent'}


def inspect_current_image(path):
    """Read only the exact three-file image through non-following directory FDs.

    No candidate JSON is parsed as policy. Equality with the complete native
    manifest hash closes its inventory for this fixed build, not arbitrary builds.
    Rechecks detect observed identity/stamp/byte changes; no snapshot constrains a
    future loader or establishes ongoing filesystem isolation.
    """
    try:
        require(sys.platform == 'linux' and all(hasattr(os, flag) for flag in
                ('O_PATH', 'O_DIRECTORY', 'O_NOFOLLOW', 'O_CLOEXEC', 'O_NONBLOCK')))
        require(type(path) is str and path.startswith('/') and '\x00' not in path)
        parts = path.split('/')[1:]
        require(0 < len(parts) <= 32 and all(p not in ('', '.', '..') for p in parts))
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        pin_flags = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC
        with ExitStack() as resources:
            def open_owned(name, flags, parent=None):
                fd = os.open(name, flags, dir_fd=parent)
                resources.callback(os.close, fd)
                return fd

            parent = open_owned('/', directory_flags)
            ancestors = [stamp(os.fstat(parent))[:5]]
            anchors = []
            for part in parts:
                child = open_owned(part, directory_flags, parent)
                identity = stamp(os.fstat(child))[:5]
                require(stat.S_ISDIR(identity[2]) and
                        stamp(os.stat(part, dir_fd=parent, follow_symlinks=False))[:5] == identity)
                anchors.append((parent, part, child, identity))
                ancestors.append(identity)
                parent = child
            directory = stamp(os.fstat(parent))
            require(directory[3] == os.geteuid() and not directory[2] & 0o022)
            inventory(parent)
            files, readers = [], []
            for name, size, expected in OUTPUTS:
                before = stamp(os.stat(name, dir_fd=parent, follow_symlinks=False))
                regular_file(before, size)
                pinned = open_owned(name, pin_flags, parent)
                require(stamp(os.fstat(pinned)) == before)
                # O_PATH has no device/FIFO read-open effects. Reopen this owned,
                # validated regular inode, never the replaceable candidate name.
                # This Linux procfd operation assumes the trusted process/procfs;
                # it does not attest an interpreter's later module loading.
                fd = open_owned('/proc/self/fd/' + str(pinned), os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK)
                require(stamp(os.fstat(fd)) == before and
                        stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == before)
                digest, count = hashlib.sha256(), 0
                while True:
                    data = os.read(fd, min(65536, size + 1 - count))
                    if not data:
                        break
                    count += len(data)
                    require(count <= size)
                    digest.update(data)
                require(count == size and digest.hexdigest() == expected)
                require(stamp(os.fstat(fd)) == before and
                        stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == before)
                files.append((name, before, expected))
                readers.append((fd, name, before))
            require(len({physical[:2] for _, physical, _ in files}) == len(files))
            inventory(parent)
            require(stamp(os.fstat(parent)) == directory)
            for fd, name, before in readers:
                require(stamp(os.fstat(fd)) == before and
                        stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == before)
            for ancestor, part, child, identity in anchors:
                require(stamp(os.fstat(child))[:5] == identity and
                        stamp(os.stat(part, dir_fd=ancestor, follow_symlinks=False))[:5] == identity)
            return CandidateInspection(path, tuple(ancestors), directory, tuple(files))
    except (OSError, ValueError, TypeError, RuntimeError):
        # OS errors and candidate content/pathnames never enter a public refusal.
        raise RuntimeError(REFUSAL) from None
