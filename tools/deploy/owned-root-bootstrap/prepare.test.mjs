import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { POLICY, PreparationError, constructPlan, prepare, fingerprint, cacheFingerprint } from './prepare.mjs';

// All synthetic files live beneath the authorized source directory. No /tmp,
// real Git subprocess, pnpm, ACP, host services, credentials, or network.
const here = path.dirname(fileURLToPath(import.meta.url));
const base = '8875f4585d7e5cd038ec974f5c6c270f8c5f01c3';
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const area = await fs.mkdtemp(path.join(here, '.synthetic-'));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const parent = path.join(area, 'roots'), root = path.join(parent, 'run');
  const cache = path.join(area, 'seed'), control = path.join(area, 'controller');
  for (const dir of [root, cache, control, path.join(root, 'packages', 'a'), path.join(root, 'tools')])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(control, 0o700);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@12.4.2' }));
  await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n  - "tools/*"\nallowBuilds:\n  esbuild: true\n');
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fs.writeFile(path.join(root, 'packages/a/package.json'), '{}');
  await fs.writeFile(path.join(root, 'source.txt'), 'unchanged\n');
  await fs.writeFile(path.join(cache, 'content'), 'synthetic cached package');
  const executable = path.join(area, 'fake-pnpm');
  await fs.writeFile(executable, 'synthetic bytes, never executed', { mode: 0o700 });
  const branch = 'orca/roots/run';
  const c = {
    parent, root, cwd: root, branch, base, record: { cwd: root, branch, base },
    policy: { ...POLICY }, manager: { identity: 'pnpm@12.4.2', executable, sha256: sha(await fs.readFile(executable)) },
    cache, control, cacheDigest: await cacheFingerprint(cache), ...await fingerprint(root),
  };
  const controller = {
    exclusiveBeforeAgent: true,
    protectedState: true, immutablePrerequisites: true,
    readIdentity: async () => ({ cwd: root, branch, head: base, clean: true, record: { cwd: root, branch, base } }),
    readManagerIdentity: async () => 'pnpm@12.4.2',
  };
  return { area, c, controller, plan: () => constructPlan(c, controller) };
}
const rejects = (action, code) => assert.rejects(action, (error) => error.code === code && error.message.length < 100);
const success = async (plan) => {
  await fs.mkdir(path.join(plan.cwd, 'node_modules/.pnpm'));
  await fs.writeFile(path.join(plan.cwd, 'node_modules/.pnpm/package'), 'copied output');
  await fs.writeFile(path.join(plan.cwd, 'node_modules/.modules.yaml'), 'synthetic metadata, not pnpm acceptance');
  return { exitCode: 0, cacheComplete: true };
};

test('frozen offline copy plan has a clean environment, no stdout, and no activation', async (t) => {
  const f = await fixture(t);
  const before = await fingerprint(f.c.root);
  const plan = await f.plan();
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.args) && Object.isFrozen(plan.env));
  for (const flag of ['--offline', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile',
    '--package-import-method=copy', '--enable-global-virtual-store=false', '--manage-package-manager-versions=false'])
    assert.ok(plan.args.includes(flag));
  assert.deepEqual(plan.stdio, ['ignore', 'ignore', 'ignore']);
  assert.equal(plan.env.PATH, '');
  assert.deepEqual(Object.keys(plan.env).sort(), ['CI', 'COREPACK_ENABLE_NETWORK', 'HOME', 'NPM_CONFIG_GLOBALCONFIG',
    'NPM_CONFIG_USERCONFIG', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'].sort());
  assert.deepEqual(await fingerprint(f.c.root), before); // planning writes nothing
  const receipt = await prepare(plan, success);
  assert.equal(receipt.status, 'prepared');
  assert.deepEqual(await fingerprint(f.c.root), before); // source and all inputs untouched
  const source = await fs.stat(path.join(f.c.cache, 'content'));
  const copy = await fs.stat(path.join(f.c.root, 'node_modules/.orca-store/content'));
  assert.equal(copy.nlink, 1);
  assert.notEqual(`${copy.dev}:${copy.ino}`, `${source.dev}:${source.ino}`);
  await fs.writeFile(path.join(f.c.root, 'node_modules/.orca-store/content'), 'local mutation');
  assert.equal(await fs.readFile(path.join(f.c.cache, 'content'), 'utf8'), 'synthetic cached package');
  assert.equal((await fs.readdir(f.c.control)).length, 1);
  await rejects(() => prepare(plan, success), 'ALREADY_RESERVED');
});

test('assigned paths, record, base, branch and controller identity fail closed', async (t) => {
  for (const [field, value, code] of [
    ['cwd', 'wrong', 'ASSIGNED_ROOT'], ['parent', '.', 'PATH'],
    ['base', '0'.repeat(40), 'RECORD'], ['branch', 'orca/roots/other', 'RECORD'],
    ['record', undefined, 'RECORD'], ['root', '/unapproved/missing', 'PREREQUISITE_OR_PARTIAL'],
  ]) {
    const f = await fixture(t); f.c[field] = value;
    await rejects(f.plan, code);
  }
  const f = await fixture(t);
  for (const change of [{ head: '0'.repeat(40) }, { branch: 'other' }, { cwd: f.area }, { clean: false }]) {
    f.controller.readIdentity = async () => ({ cwd: f.c.root, branch: f.c.branch, head: base, clean: true, ...change });
    await rejects(f.plan, 'GIT_IDENTITY');
  }
  f.controller.readIdentity = async () => ({ cwd: f.c.root, branch: f.c.branch, head: base, clean: true });
  await rejects(f.plan, 'RECORDED_IDENTITY');
});

test('symlinked root, ancestor, source, inputs and cache are rejected', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.area, 'alias');
  await fs.symlink(f.c.parent, alias);
  const old = f.c.parent; f.c.parent = alias;
  await rejects(f.plan, 'SYMLINK'); f.c.parent = old;
  for (const target of ['source.txt', 'pnpm-lock.yaml']) {
    const file = path.join(f.c.root, target), moved = path.join(f.area, target);
    await fs.rename(file, moved); await fs.symlink(moved, file);
    await rejects(f.plan, target === 'source.txt' ? 'OUTPUT_SYMLINK' : 'SYMLINK');
    await fs.unlink(file); await fs.rename(moved, file);
  }
  await fs.symlink(f.c.root, path.join(f.c.cache, 'link'));
  await rejects(f.plan, 'OUTPUT_SYMLINK');
});

test('missing tools/cache/inputs, mismatched digests and unpinned manager fail', async (t) => {
  for (const mutate of [
    async (f) => fs.unlink(f.c.manager.executable),
    async (f) => fs.rm(f.c.cache, { recursive: true }),
    async (f) => fs.unlink(path.join(f.c.root, 'pnpm-lock.yaml')),
  ]) {
    const f = await fixture(t); await mutate(f);
    await rejects(f.plan, 'PREREQUISITE_OR_PARTIAL');
  }
  for (const [mutate, code] of [
    [(f) => { f.c.inputs['pnpm-lock.yaml'] = '0'.repeat(64); }, 'INPUT_HASH'],
    [(f) => { f.c.sourceDigest = '0'.repeat(64); }, 'SOURCE_HASH'],
    [(f) => { f.c.cacheDigest = '0'.repeat(64); }, 'CACHE_MISS'],
    [(f) => { f.c.manager.sha256 = '0'.repeat(64); }, 'MANAGER_HASH'],
    [(f) => { f.c.manager.identity = 'pnpm@latest'; }, 'MANAGER_IDENTITY'],
    [(f) => { f.controller.readManagerIdentity = async () => 'pnpm@12.4.1'; }, 'MANAGER_IDENTITY'],
    [(f) => { f.c.policy.scripts = true; }, 'INSTALL_POLICY'],
    [(f) => { f.controller.exclusiveBeforeAgent = false; }, 'CONTROLLER_REQUIRED'],
    [(f) => { f.controller.protectedState = false; }, 'CONTROLLER_REQUIRED'],
    [(f) => { f.controller.immutablePrerequisites = false; }, 'CONTROLLER_REQUIRED'],
  ]) { const f = await fixture(t); mutate(f); await rejects(f.plan, code); }
});

test('unexpected lifecycle, hooks, config and new dependency inputs fail even before hashing', async (t) => {
  for (const name of ['.npmrc', '.pnpmfile.cjs', '.env', 'packages/a/.pnpmfile.mjs']) {
    const f = await fixture(t); await fs.writeFile(path.join(f.c.root, name), 'synthetic-private-never-read');
    await rejects(f.plan, 'HOOK_OR_PRIVATE_CONFIG');
  }
  const f = await fixture(t);
  await fs.writeFile(path.join(f.c.root, 'packages/a/package.json'), '{"scripts":{"install":"network"}}');
  await rejects(f.plan, 'LIFECYCLE_POLICY');
  await fs.writeFile(path.join(f.c.root, 'packages/a/package.json'), '{"pnpm":{"overrides":{}}}');
  await rejects(f.plan, 'INSTALL_POLICY');
  await fs.writeFile(path.join(f.c.root, 'packages/a/package.json'), '{}');
  await fs.appendFile(path.join(f.c.root, 'pnpm-workspace.yaml'), '  dangerousSetting: execute\n');
  await rejects(f.plan, 'WORKSPACE_POLICY');
  const g = await fixture(t);
  await fs.mkdir(path.join(g.c.root, 'packages/new'));
  await fs.writeFile(path.join(g.c.root, 'packages/new/package.json'), '{}');
  await rejects(g.plan, 'INPUT_HASH');
});

test('preexisting output and root ready markers cannot confer readiness', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.c.root, 'node_modules'));
  await rejects(f.plan, 'PARTIAL_OUTPUT');
  const g = await fixture(t);
  await fs.mkdir(path.join(g.c.root, '.orca'));
  await fs.writeFile(path.join(g.c.root, '.orca/ready'), 'prepared');
  await rejects(() => prepare({}, success), 'TRUSTED_PLAN_REQUIRED');
  assert.equal((await fs.readdir(g.c.control)).length, 0);
});

test('concurrent initialization is refused atomically; interrupted state stays reserved', async (t) => {
  const f = await fixture(t), plan = await f.plan();
  let release, started;
  const pending = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const first = prepare(plan, async () => { started(); await pending; throw new Error('synthetic secret must not leak'); });
  await entered;
  await rejects(() => prepare(plan, success), 'ALREADY_RESERVED');
  release(); await rejects(() => first, 'PREREQUISITE_OR_PARTIAL');
  const slot = path.join(f.c.control, (await fs.readdir(f.c.control))[0]);
  assert.equal(JSON.parse(await fs.readFile(path.join(slot, 'state.json'))).status, 'preparing');
  await assert.rejects(fs.stat(path.join(slot, 'prepared.json')), { code: 'ENOENT' });
  await rejects(() => prepare(plan, success), 'ALREADY_RESERVED');
  assert.equal(await fs.readFile(path.join(f.c.root, 'source.txt'), 'utf8'), 'unchanged\n');
});

test('cache miss has no fallback, retains partial files and preserves lock/source', async (t) => {
  const f = await fixture(t), before = await fingerprint(f.c.root), plan = await f.plan();
  let calls = 0;
  await rejects(() => prepare(plan, async () => { calls++; return { exitCode: 1, cacheComplete: false }; }), 'INSTALL_FAILED_OR_CACHE_MISS');
  assert.equal(calls, 1);
  assert.deepEqual(await fingerprint(f.c.root), before);
  assert.ok(await fs.stat(path.join(f.c.root, 'node_modules/.orca-store/content')));
});

test('revalidation catches changes after planning and before accepting preparation', async (t) => {
  const f = await fixture(t), plan = await f.plan();
  await fs.appendFile(path.join(f.c.root, 'pnpm-lock.yaml'), 'changed\n');
  let calls = 0;
  await rejects(() => prepare(plan, async () => { calls++; }), 'INPUT_HASH');
  assert.equal(calls, 0);
  for (const [file, code] of [['pnpm-lock.yaml', 'INPUT_HASH'], ['source.txt', 'SOURCE_HASH']]) {
    const g = await fixture(t), p = await g.plan();
    await rejects(() => prepare(p, async (spec) => {
      await fs.appendFile(path.join(spec.cwd, file), 'unsafe modification');
      return success(spec);
    }), code);
    assert.match(await fs.readFile(path.join(g.c.root, file), 'utf8'), /unsafe modification/); // no destructive rollback
  }
});

test('shared writable hardlinks and escaping output links are refused', async (t) => {
  for (const kind of ['hardlink', 'symlink']) {
    const f = await fixture(t), plan = await f.plan();
    await rejects(() => prepare(plan, async (spec) => {
      await success(spec);
      const target = path.join(spec.cwd, 'node_modules/unsafe');
      if (kind === 'hardlink') await fs.link(path.join(f.c.cache, 'content'), target);
      else await fs.symlink(f.c.cache, target);
      return { exitCode: 0, cacheComplete: true };
    }), kind === 'hardlink' ? 'SHARED_OR_SPECIAL_FILE' : 'OUTPUT_SYMLINK');
  }
});

test('uncertain success without dependency layout and unsafe controller permissions fail', async (t) => {
  const f = await fixture(t), plan = await f.plan();
  await rejects(() => prepare(plan, async () => ({ exitCode: 0, cacheComplete: true })), 'PREREQUISITE_OR_PARTIAL');
  const g = await fixture(t);
  await fs.chmod(g.c.control, 0o755);
  await rejects(g.plan, 'CONTROL_PERMISSIONS');
  const h = await fixture(t);
  h.c.control = h.c.root;
  await rejects(h.plan, 'PATH_OVERLAP');
});

test('diagnostics discard arbitrary runner strings and forged preparation errors', async (t) => {
  const f = await fixture(t), plan = await f.plan();
  await rejects(() => prepare(plan, async () => {
    const error = new PreparationError('synthetic-secret');
    error.message = 'synthetic-secret raw log';
    error.code = 'synthetic-secret';
    throw error;
  }), 'PREREQUISITE_OR_PARTIAL');
});
