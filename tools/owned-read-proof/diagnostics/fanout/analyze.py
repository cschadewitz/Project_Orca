"""DIAGNOSTIC ONLY analysis of drive.py outputs for the #706 fan-out investigation.

usage: python3 -I analyze.py <command> <args>

  trace <file.trace>                  bytes/calls per command-FIFO phase and syscall
  units <census.json>                 child/producer/managed-check counts per phase
  callers <census.json> <phase> [n]   frames above producer check() (n frames)
  entries <census.json>               managed-check origins by managed-layer entry point
  consumers <census.json>             producer checks by first non-helper top-level operation
  adjacent <census.json.seq.json>     consecutive producer checks in the same synchronous turn
  sites <census.json.seq.json>        those same-turn pairs classified by code site
  stracec <strace-c.txt>              selected syscall counts from `strace -c`
  markers <file.trace> <begin> <end>  syscalls between /MARK-<begin> and /MARK-<end> probes
                                      (gate-units.mjs), excluding every /MARK-* line

Census counts come from wrapped synchronous fs calls (not syscalls). A "producer check" is
counted once at its direct `Object.check@child` frame; a "managed check" is a producer check
whose caller is the managed owner's assertCurrent (baseline: two per managed check, lifetime
and build ports; candidate: one, lifetime port).
"""
import collections
import json
import re
import sys

PRODUCER = 'check@cli/test/controlled-owned-read-producer'
MANAGED = 'assertCurrent@cli/typed-workspace-gate'
INNER = ('cli/typed-workspace-gate', 'agents/managed-typed-store', 'agents/typed-sidecar.ts')
HELPERS = ('binding@daemon', 'currentFacts@daemon', 'current@daemon/owned-read', 'currentBinding@daemon',
           'currentStore@', 'assertEntry@daemon', 'facts@daemon')
CHECKISH = {'base-or-ancestor', 'root-dir', 'workspace-identity-id', 'control-file', 'sidecar', 'credentials',
            'image-file', 'fdinfo', 'receipt', 'lifetime-path', 'fd:lifetime', 'fd:command', 'fd:ack', 'plan',
            'fd:other'}


def strip(frame):
    return re.sub(r':\d+$', '', frame).replace('Object.', '')


def producer_stacks(census):
    """Yield (phase, raw frames, stripped frames, count) once per producer check."""
    for key, count in census['checkStacks'].items():
        phase, stack = key.split('|', 1)
        raw = stack.split(' < ')
        if len(raw) > 1 and raw[1].startswith('Object.check@child'):
            yield phase.split(':')[0], raw, [strip(f) for f in raw], count


def above_producer(frames):
    return next((i for i, f in enumerate(frames) if f.startswith(PRODUCER)), None)


def trace(path):
    pattern = re.compile(rb'^\d+\s+\d+\.\d+\s+(?:<\.\.\. )?(\w+)')
    phase, stats = 'init', collections.OrderedDict()
    with open(path, 'rb') as stream:
        for line in stream:
            match = pattern.match(line)
            name = match[1].decode() if match else '?'
            if b'"orca-phase:' in line and name == 'read':
                phase = re.search(rb'"orca-phase:([a-z-]+):', line)[1].decode()
            st = stats.setdefault(phase, {'bytes': 0, 'lines': 0, 'calls': collections.Counter(),
                                          'callBytes': collections.Counter()})
            st['bytes'] += len(line)
            st['lines'] += 1
            if b'resumed>' not in line:
                st['calls'][name] += 1
            st['callBytes'][name] += len(line)
    total = 0
    for phase, st in stats.items():
        total += st['bytes']
        top = ', '.join(f'{k}={v}({st["callBytes"][k] / 1e6:.1f}MB)' for k, v in st['calls'].most_common(7))
        print(f'{phase:11s} {st["bytes"] / 1e6:8.1f} MB  lines={st["lines"]:8d}  {top}')
    print(f'TOTAL {total} bytes = {total / 2 ** 20:.1f} MiB  (cap 256 MiB)')


def units(path):
    census = json.load(open(path))
    result = collections.OrderedDict()
    for key, count in census['counts'].items():
        phase, op, kind = key.split('|')
        entry = result.setdefault(phase.split(':')[0], collections.Counter())
        if op == 'openSync' and kind == 'fdinfo':
            entry['childChecks'] += count
        if op == 'readFileSync' and kind == 'receipt':
            entry['receiptReads'] += count
    for phase, _, frames, count in producer_stacks(census):
        result[phase]['producerChecks'] += count
        i = above_producer(frames)
        if i is not None and i + 1 < len(frames) and frames[i + 1].startswith(MANAGED):
            result[phase]['producerChecksFromManagedOwner'] += count
    for phase, entry in result.items():
        print(phase, dict(entry))


def callers(path, phase, depth=1):
    census = json.load(open(path))
    counter = collections.Counter()
    for current, _, frames, count in producer_stacks(census):
        if current != phase:
            continue
        i = above_producer(frames)
        counter[tuple(frames[i + 1:i + 1 + depth]) if i is not None else ('<no producer frame>',)] += count
    for key, count in counter.most_common(40):
        print(f'{count:6d}  ' + '  <  '.join(key))


def managed_rest(frames):
    i = above_producer(frames)
    if i is None or i + 1 >= len(frames) or not frames[i + 1].startswith(MANAGED):
        return None
    return frames[i + 1:]


def entries(path):
    census = json.load(open(path))
    counter = collections.Counter()
    for _, _, frames, count in producer_stacks(census):
        rest = managed_rest(frames)
        if rest is None:
            continue
        j = next((j for j, f in enumerate(rest) if not any(x in f for x in INNER)), len(rest))
        counter[' < '.join(f.split('@')[0] for f in rest[:j])] += count
    total = sum(counter.values())
    for key, count in counter.most_common(20):
        print(f'{count:6d} {100 * count / total:5.1f}%  {key}')


def consumers(path):
    census = json.load(open(path))
    counter = collections.Counter()
    for phase, _, frames, count in producer_stacks(census):
        rest = [f for f in frames[2:] if not any(s in f for s in INNER + ('check@cli/test', 'child'))]
        top = [f for f in rest if not f.startswith(HELPERS)]
        counter[(phase, top[0] if top else '?')] += count
    total = sum(counter.values())
    for (phase, frame), count in counter.most_common(30):
        print(f'{count:6d} {100 * count / total:5.1f}% {phase:10s} {frame}')


def same_turn_pairs(seq):
    """Consecutive producer checks: same promise continuation, no effect call, only check reads."""
    checks = [i for i, e in enumerate(seq) if e[0] == 'C' and e[4] == 1]
    reasons = collections.Counter()
    for a, b in zip(checks, checks[1:]):
        between = seq[a + 1:b]
        if seq[a][1] != seq[b][1]:
            reasons['async boundary'] += 1
        elif any(e[0] == 'W' for e in between):
            reasons['effect/other call between'] += 1
        elif any(e[0] == 'R' and e[4] not in CHECKISH for e in between):
            reasons['non-check read between'] += 1
        else:
            reasons['same-turn adjacent'] += 1
            yield seq[a], seq[b], None
    yield None, None, (len(checks), reasons)


def adjacent(path):
    for first, second, summary in same_turn_pairs(json.load(open(path))):
        if summary:
            count, reasons = summary
            print('producer checks', count, 'pairs', count - 1, dict(reasons))


def site(event):
    frames = event[5]
    if frames and frames[0].startswith(MANAGED):
        nxt = frames[1] if len(frames) > 1 else '?'
        return 'M:' + re.sub(r'@.*:(\d+)$', r'@\1', nxt)
    return 'P:' + (frames[0].split('@')[0] if frames else '?')


def sites(path):
    counter = collections.Counter()
    for first, second, summary in same_turn_pairs(json.load(open(path))):
        if first is not None:
            counter[(site(first), site(second))] += 1
    total = sum(counter.values())
    for (a, b), count in counter.most_common(14):
        print(f'{count:6d} {100 * count / total:5.1f}%  {a:28s} -> {b}')


def stracec(path):
    rows = {}
    for line in open(path):
        match = re.match(r'\s*[\d.]+\s+[\d.]+\s+\d+\s+(\d+)\s+(?:\d+\s+)?(\w+)$', line)
        if match:
            rows[match[2]] = int(match[1])
    print({k: rows.get(k) for k in ('statx', 'openat', 'read', 'close', 'pread64', 'futex', 'total')})


def markers(path, begin, end):
    lines = open(path).read().splitlines()
    first = next(i for i, line in enumerate(lines) if f'/MARK-{begin}"' in line)
    last = next(i for i, line in enumerate(lines) if f'/MARK-{end}"' in line)
    counter = collections.Counter()
    for line in lines[first + 1:last]:
        match = re.match(r'\d+\s+(\w+)\(', line)
        if match and '/MARK-' not in line:
            counter[match[1]] += 1
    print(dict(counter.most_common()))


if __name__ == '__main__':
    command, args = sys.argv[1], sys.argv[2:]
    if command == 'callers' and len(args) > 2:
        args[2] = int(args[2])
    {'trace': trace, 'units': units, 'callers': callers, 'entries': entries, 'consumers': consumers,
     'adjacent': adjacent, 'sites': sites, 'stracec': stracec, 'markers': markers}[command](*args)
