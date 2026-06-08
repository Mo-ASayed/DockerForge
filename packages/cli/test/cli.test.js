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
const FIXTURE = path.join(
  __dirname, '..', '..', '..', 'fixtures', 'node-npm'
);

test('generate --json emits a Dockerfile and confidence', async () => {
  const { stdout } = await run('node', [CLI, 'generate', FIXTURE, '--json'], { env: { ...process.env, NO_COLOR: '1' } });
  const out = JSON.parse(stdout);
  assert.ok(out.dockerfile.includes('FROM'), 'should contain a Dockerfile');
  assert.equal(typeof out.confidence, 'number');
  assert.ok(out.dockerignore && out.dockerignore.length > 0, 'should contain a .dockerignore');
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
