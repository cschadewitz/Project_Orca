"""Review-only independent dependency copier. No CLI, Git, runtime or admission API.

Caller must establish authenticated run/receipt/gate bindings and exclusive ownership.
Failure leaves partial trees intact. Never resume into an existing output tree.
Only Linux descriptor-relative operations are supported.
"""
import contextlib
import hashlib
import json
import os
import posixpath
import stat

import relocation


class Refusal(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative(path):
    require(isinstance(path, str) and path and not path.startswith('/')
            and all(p not in ('', '.', '..') for p in path.split('/'))
            and '\x00' not in path, 'unsafe relative path')
    return path


DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


@contextlib.contextmanager
def directory(root_fd, path=''):
    fd = os.dup(root_fd)
    try:
        for part in relative(path).split('/') if path else []:
            nxt = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = nxt
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def root(path):
    relocation.root_ok(path)
    fd = os.open('/', DIR)
    try:
        for part in path.split('/')[1:]:
            nxt = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = nxt
        yield fd
    finally:
        os.close(fd)


def stable(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_size,
            st.st_mtime_ns, st.st_ctime_ns, st.st_nlink)


def read_file(parent_fd, name, maximum_bytes=None):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                'special file or shared hardlink')
        require(maximum_bytes is None or before.st_size <= maximum_bytes,
                'file exceeds budgeted payload size')
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            require(total <= before.st_size and (maximum_bytes is None or total <= maximum_bytes),
                    'file grew beyond budgeted size')
            chunks.append(chunk)
        require(stable(before) == stable(os.fstat(fd)), 'file changed during read')
        require(stable(before) == stable(os.stat(name, dir_fd=parent_fd,
                                                follow_symlinks=False)), 'file replaced')
        return b''.join(chunks), before
    finally:
        os.close(fd)


def scan(root_fd, trees, maximum_bytes=None):
    """Complete no-follow inventory; rejects special files and shared hardlinks."""
    entries = {}
    seen = set()

    def visit(parent_fd, name, path):
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        mode = stat.S_IMODE(before.st_mode)
        require(not mode & 0o7000, 'special permission bits')
        item = {'path': path, 'mode': oct(mode)}
        if stat.S_ISDIR(before.st_mode):
            item['kind'] = 'directory'
            with directory(parent_fd, name) as fd:
                require(stable(before) == stable(os.fstat(fd)), 'directory replaced')
                for child in sorted(os.listdir(fd)):
                    visit(fd, child, path + '/' + child)
                require(stable(before) == stable(os.fstat(fd)), 'directory changed')
        elif stat.S_ISREG(before.st_mode):
            data, st = read_file(parent_fd, name, maximum_bytes)
            require(stable(before) == stable(st), 'file replaced before read')
            identity = (st.st_dev, st.st_ino)
            require(identity not in seen, 'repeated regular inode')
            seen.add(identity)
            item.update(kind='file', bytes=len(data), sha256=digest(data))
        elif stat.S_ISLNK(before.st_mode):
            target = os.readlink(name, dir_fd=parent_fd)
            require(not posixpath.isabs(target) and '\x00' not in target,
                    'absolute link')
            normalized = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            require(normalized not in ('', '.', '..') and not normalized.startswith('../'),
                    'escaping link')
            item.update(kind='symlink', target=target)
        else:
            raise Refusal('unsupported filesystem entry')
        require(stable(before) == stable(os.stat(name, dir_fd=parent_fd,
                                                follow_symlinks=False)), 'entry changed')
        entries[path] = item

    for tree in trees:
        parent, name = posixpath.split(tree)
        with directory(root_fd, parent) as fd:
            require(stat.S_ISDIR(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode),
                    'output tree is not a directory')
            visit(fd, name, tree)
    return entries


def virtual_links(fd, entries, link_policy, trees):
    """Validate links against proposed outputs AND untouched workspace targets.

    Existing output trees must be absent. No following foreign directory links,
    even when a later link would lead back to this root.
    """
    require(set(link_policy) == {'workspace_packages', 'workspace_entries'}, 'unknown link policy')
    packages = [relative(p) for p in link_policy['workspace_packages']]
    require(len(packages) == len(set(packages)), 'duplicate workspace package')
    workspace = {}
    def prohibited(p):
        return any(c in ('.git', '.orca') for c in p.split('/'))
    for item in link_policy['workspace_entries']:
        p = relative(item['path'])
        require(not prohibited(p) and p not in workspace and p not in entries
                and any(p == t or p.startswith(t + '/') for t in packages),
                'invalid workspace allowlist')
        require(item['kind'] in ('directory', 'file', 'symlink'), 'unknown workspace kind')
        workspace[p] = item
    require(all(workspace.get(p, {}).get('kind') == 'directory' for p in packages),
            'unbound workspace package')
    allowed = {**workspace, **entries}
    parents = {posixpath.dirname(p) for p in [*trees, *packages]}
    for p in list(parents):
        while p:
            parents.add(p); p = posixpath.dirname(p)
    def approved(p):
        return not prohibited(p) and (p in workspace or
            any(p == t or p.startswith(t + '/') for t in trees))
    def physical(p):
        with directory(fd, posixpath.dirname(p)) as parent:
            st = os.stat(posixpath.basename(p), dir_fd=parent, follow_symlinks=False)
            kind = ('symlink' if stat.S_ISLNK(st.st_mode) else 'directory'
                    if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'special')
            item = {'kind': kind}
            if kind == 'symlink':
                item['target'] = os.readlink(posixpath.basename(p), dir_fd=parent)
            if kind == 'file':
                require(st.st_nlink == 1, 'shared workspace target file')
                item['bytes'] = st.st_size
            return item
    checked = set()
    def resolve(path):
        todo = path.split('/')
        parts = []
        links = 0
        while todo:
            part = todo.pop(0)
            if part in ('', '.'):
                continue
            if part == '..':
                require(parts, 'escaping virtual link')
                parts.pop()
                continue
            p = '/'.join(parts + [part])
            require(not prohibited(p) and (approved(p) or p in parents), 'unapproved link chain path')
            e = allowed.get(p)
            require(e is not None or p in parents, 'unrecorded dependency/link target')
            if p not in entries:
                actual = physical(p)
                require(actual['kind'] == (e['kind'] if e else 'directory'), 'workspace target kind drift')
                if e and e['kind'] == 'symlink':
                    require(actual['target'] == e['target'], 'workspace link drift')
                if e and e['kind'] == 'file':
                    require(actual['bytes'] == e['bytes'], 'workspace file size drift')
                e = actual
            if e['kind'] == 'symlink':
                links += 1
                require(links <= 40 and not e['target'].startswith('/'),
                        'cyclic or absolute virtual link')
                target = posixpath.normpath(posixpath.join(posixpath.dirname(p), e['target']))
                require(approved(target), 'unapproved dependency/workspace link target')
                todo = e['target'].split('/') + todo
            else:
                require(not todo or e['kind'] == 'directory', 'nondirectory link parent')
                parts.append(part)
        final = '/'.join(parts)
        require(approved(final), 'unapproved final link target')
        # Linking a workspace directory exposes its descendants too. Every actual
        # child must be pinned tracked package data or an approved dependency tree.
        if final in workspace and workspace[final]['kind'] == 'directory' and final not in checked:
            checked.add(final)
            with directory(fd, final) as parent:
                names = os.listdir(parent)
            for name in names:
                child = final + '/' + name
                require(child in allowed, 'unrecorded workspace/private-state child')
                resolve(child)
    for item in entries.values():
        if item['kind'] == 'symlink':
            resolve(item['path'])


def contract_entries(contract):
    trees = [relative(p) for p in contract['trees']]
    require(len(trees) == len(set(trees)) and trees, 'duplicate/empty trees')
    for a in trees:
        for b in trees:
            require(a == b or not b.startswith(a + '/'), 'overlapping trees')
    entries = {}
    for e in contract['entries']:
        p = relative(e['path'])
        require(not any(c in ('.git', '.orca') for c in p.split('/')),
                'Git/ORCA state is excluded from dependency outputs')
        require(p not in entries and any(p == t or p.startswith(t + '/') for t in trees),
                'duplicate or out-of-scope entry')
        item = {k: e[k] for k in ('path', 'mode', 'kind')}
        require(e['kind'] in ('directory', 'file', 'symlink'), 'unknown entry kind')
        if e['kind'] == 'file':
            item.update(bytes=e['bytes'], sha256=e['sha256'])
        if e['kind'] == 'symlink':
            item['target'] = e['target']
        entries[p] = item
    require(all(entries.get(t, {}).get('kind') == 'directory' for t in trees),
            'missing tree directory')
    for p in entries:
        if p not in trees:
            require(entries.get(posixpath.dirname(p), {}).get('kind') == 'directory',
                    'missing or nondirectory inventory parent')
    return trees, entries


def absent_outputs(fd, trees):
    for tree in trees:
        parent, name = posixpath.split(tree)
        with directory(fd, parent) as parent_fd:
            try:
                os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise Refusal('existing or partial destination output')


def plan(source, destination, contract):
    """Read-only plan. Returns only transformed shim bytes, never payload copies."""
    relocation.root_ok(source)
    relocation.root_ok(destination)
    require(not relocation.inside(source, destination)
            and not relocation.inside(destination, source), 'overlapping roots')
    trees, expected = contract_entries(contract)
    maximum = max([e.get('bytes', 0) for e in expected.values()])
    with root(source) as sf, root(destination) as df:
        actual = scan(sf, trees, maximum)
        require(actual == expected, 'source inventory drift')
        virtual_links(sf, actual, contract['link_policy'], trees)
        absent_outputs(df, trees)
        virtual_links(df, expected, contract['link_policy'], trees)
        shims = contract['shims']
        require(len(shims) == len({m['path'] for m in shims}), 'duplicate shims')
        require({m['path'] for m in shims} ==
                {p for p, e in expected.items() if e['kind'] == 'file'
                 and '/.bin/' in p}, 'unexpected shim set')
        rewritten = {}
        spans = 0
        for mapping in shims:
            p = mapping['path']
            require(expected[p]['sha256'] == mapping['before_sha256'], 'shim hash mismatch')
            parent, name = posixpath.split(p)
            with directory(sf, parent) as fd:
                data, st = read_file(fd, name, expected[p]['bytes'])
            updated, evidence = relocation.propose(data, mapping['before_sha256'],
                stat.S_IMODE(st.st_mode), source, destination, p)
            for key in ('spans', 'unchanged_bytes_sha256', 'relative_target', 'header_sha256'):
                require(evidence[key] == mapping[key], 'reviewed mapping mismatch')
            rewritten[p] = updated
            spans += len(evidence['spans'])
        require(len(rewritten) == contract['shim_count'] and spans == contract['prefix_count'],
                'reviewed relocation count mismatch')
        for p, hash_value in contract['metadata'].items():
            require(expected[p]['sha256'] == hash_value and p not in rewritten,
                    'historical metadata changed')
        require(scan(sf, trees, maximum) == expected, 'source changed during planning')
        return trees, expected, rewritten


def copy_exclusive(source, destination, contract):
    """Call ONLY after independent code review and renewed receipt/access/gate checks.

    O_EXCL creates independent regular files. No deletion, replacement or rollback.
    All writes are descriptor-relative, with no-follow directory traversal.
    Caller owns both roots exclusively while this function runs; it does not create
    or claim daemon/worker locks. Any exception retains the destination evidence.
    """
    trees, expected, rewritten = plan(source, destination, contract)
    maximum = max([e.get('bytes', 0) for e in expected.values()])
    with root(source) as sf, root(destination) as df:
        require(scan(sf, trees, maximum) == expected, 'source changed before copying')
        absent_outputs(df, trees)
        ordered = sorted(expected, key=lambda p: (p.count('/'), p))
        for p in ordered:
            e = expected[p]
            parent, name = posixpath.split(p)
            with directory(df, parent) as dest_fd:
                if e['kind'] == 'directory':
                    os.mkdir(name, 0o700, dir_fd=dest_fd)
                elif e['kind'] == 'symlink':
                    os.symlink(e['target'], name, dir_fd=dest_fd)
                else:
                    with directory(sf, parent) as src_fd:
                        data, _ = read_file(src_fd, name, e['bytes'])
                    require(digest(data) == e['sha256'] and len(data) == e['bytes'],
                            'source file changed during copying')
                    data = rewritten.get(p, data)
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                 | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dest_fd)
                    try:
                        view = memoryview(data)
                        while view:
                            count = os.write(fd, view)
                            require(count > 0, 'short write')
                            view = view[count:]
                        os.fchmod(fd, int(e['mode'], 8))
                        os.fsync(fd)
                        require(os.fstat(fd).st_nlink == 1, 'destination shared hardlink')
                    finally:
                        os.close(fd)
                    del view, data
                os.fsync(dest_fd)
        for p in reversed(ordered):
            if expected[p]['kind'] == 'directory':
                with directory(df, p) as fd:
                    os.fchmod(fd, int(expected[p]['mode'], 8))
                    os.fsync(fd)
        wanted = {p: dict(e) for p, e in expected.items()}
        for p, data in rewritten.items():
            wanted[p].update(bytes=len(data), sha256=digest(data))
        require(scan(df, trees, max([e.get('bytes', 0) for e in wanted.values()])) == wanted,
                'destination inventory mismatch')
        virtual_links(df, wanted, contract['link_policy'], trees)
        require(scan(sf, trees, maximum) == expected, 'source preservation check failed')
        return {'trees': len(trees), 'shims': len(rewritten),
                'prefixes': contract['prefix_count'], 'independent_files': True,
                'source_preserved': True, 'metadata_preserved': True}
