'use strict';

// Smoke tests for @dockerforge/cli (Chunk 1.1). Runs the real binary against a backend fixture.
// Offline; no network. Run host-side: `node --test` from packages/cli (needs workspace install
// so @dockerforge/core resolves, and backend fixtures present).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const CLI = path.join(__dirname, '..', 'src', 'index.js');
const ROOT_PACKAGE = path.join(__dirname, '..', '..', '..', 'package.json');
const CLI_PACKAGE = path.join(__dirname, '..', '..', 'cli', 'package.json');
const CORE_PACKAGE = path.join(__dirname, '..', '..', 'core', 'package.json');
const FIXTURE = path.join(
  __dirname, '..', '..', '..', 'fixtures', 'node-npm'
);

test('root dockerforge package is a publishable npx alias for the CLI', async () => {
  const rootPkg = JSON.parse(await fs.readFile(ROOT_PACKAGE, 'utf8'));

  assert.equal(rootPkg.name, 'dockerforge');
  assert.notEqual(rootPkg.private, true, 'root package must be publishable for npx dockerforge');
  assert.equal(rootPkg.bin?.dockerforge, 'bin/dockerforge.js');
  assert.equal(rootPkg.dependencies?.['@dockerforge/cli'], rootPkg.version);
});

test('@dockerforge/cli depends on the matching core package version', async () => {
  const cliPkg = JSON.parse(await fs.readFile(CLI_PACKAGE, 'utf8'));
  const corePkg = JSON.parse(await fs.readFile(CORE_PACKAGE, 'utf8'));

  assert.equal(cliPkg.version, corePkg.version);
  assert.equal(
    cliPkg.dependencies?.['@dockerforge/core'],
    corePkg.version,
    'CLI must not publish against a stale core range'
  );
});

test('generate --json emits a Dockerfile and confidence', async () => {
  const { stdout } = await run('node', [CLI, 'generate', FIXTURE, '--json'], { env: { ...process.env, NO_COLOR: '1' } });
  const out = JSON.parse(stdout);
  assert.ok(out.dockerfile.includes('FROM'), 'should contain a Dockerfile');
  assert.equal(typeof out.confidence, 'number');
  assert.ok(out.dockerignore && out.dockerignore.length > 0, 'should contain a .dockerignore');
});

test('generate --pin-digests prints digest-pinned Docker Hub base images', async () => {
  const digest = `sha256:${'e'.repeat(64)}`;
  const { stdout } = await run('node', [CLI, 'generate', FIXTURE, '--print', '--pin-digests'], {
    env: { ...process.env, NO_COLOR: '1', DOCKERFORGE_TEST_DIGEST: digest },
  });

  assert.match(stdout, /FROM .*node:20-alpine3\.21@sha256:e{64}/);
});

test('generate writes files to --output dir', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockerforge-cli-'));
  try {
    await run('node', [CLI, 'generate', FIXTURE, '--output', outDir], { env: { ...process.env, NO_COLOR: '1' } });
    const df = await fs.readFile(path.join(outDir, 'Dockerfile'), 'utf8');
    assert.ok(df.includes('FROM'), 'Dockerfile should be written');
    await fs.access(path.join(outDir, '.dockerignore'));
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('exits non-zero with a typed error on a missing path', async () => {
  await assert.rejects(
    run('node', [CLI, 'generate', path.join(__dirname, 'no-such-dir'), '--json'], { env: { ...process.env, NO_COLOR: '1' } }),
    (err) => err.code === 1 && /PATH_NOT_FOUND/.test(String(err.stderr))
  );
});
