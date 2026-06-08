'use strict';

// CLI lint smoke tests (Chunk 1.2): real binary, real exit codes, real SARIF.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const CLI = path.join(__dirname, '..', 'src', 'index.js');
const ENV = { env: { ...process.env, NO_COLOR: '1' } };

async function withDockerfile(contents, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockerforge-lint-'));
  try {
    await fs.writeFile(path.join(dir, 'Dockerfile'), contents, 'utf8');
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('lint --format json reports findings and exits 1 on high severity', async () => {
  await withDockerfile('FROM node:latest\nCOPY . .\nCMD ["node","x.js"]', async (dir) => {
    await assert.rejects(
      run('node', [CLI, 'lint', dir, '--format', 'json'], ENV),
      (err) => {
        assert.equal(err.code, 1, 'should exit 1 when findings >= fail-on');
        const out = JSON.parse(err.stdout);
        const ids = out.findings.map((f) => f.ruleId);
        assert.ok(ids.includes('DF001') && ids.includes('DF003'));
        return true;
      }
    );
  });
});

test('lint --format sarif emits valid SARIF 2.1.0', async () => {
  await withDockerfile('FROM node:latest\nUSER node\nWORKDIR /app', async (dir) => {
    // exits 1 (DF001 high), so catch and read stdout
    let stdout;
    try {
      ({ stdout } = await run('node', [CLI, 'lint', dir, '--format', 'sarif'], ENV));
    } catch (err) { stdout = err.stdout; }
    const sarif = JSON.parse(stdout);
    assert.equal(sarif.version, '2.1.0');
    assert.ok(Array.isArray(sarif.runs[0].results));
    assert.equal(sarif.runs[0].tool.driver.name, 'DockerForge');
  });
});

test('clean Dockerfile exits 0', async () => {
  const clean = [
    'FROM node:20-alpine@sha256:abc',
    'WORKDIR /app',
    'COPY package.json ./',
    'RUN npm ci',
    'USER node',
    'CMD ["node","x.js"]',
    '',
  ].join('\n');
  await withDockerfile(clean, async (dir) => {
    // also needs a .dockerignore excluding .env to avoid DF004 (medium, but below default fail-on=high)
    const { stdout } = await run('node', [CLI, 'lint', dir, '--format', 'json'], ENV);
    const out = JSON.parse(stdout);
    // DF004 (medium) may appear but must not fail the run at default --fail-on=high
    assert.ok(!out.findings.some((f) => ['high', 'critical'].includes(f.severity)), 'no high/critical');
  });
});

test('--fail-on critical lets a high finding pass (exit 0)', async () => {
  await withDockerfile('FROM node:latest\nUSER node\nWORKDIR /app', async (dir) => {
    const { stdout } = await run('node', [CLI, 'lint', dir, '--fail-on', 'critical', '--format', 'json'], ENV);
    const out = JSON.parse(stdout);
    assert.ok(out.findings.some((f) => f.ruleId === 'DF001'), 'DF001 still reported');
  });
});
