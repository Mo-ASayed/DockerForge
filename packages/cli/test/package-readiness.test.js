'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const ROOT = path.join(__dirname, '..', '..', '..');
const ROOT_PACKAGE = path.join(ROOT, 'package.json');
const CLI_PACKAGE = path.join(ROOT, 'packages', 'cli', 'package.json');
const CORE_PACKAGE = path.join(ROOT, 'packages', 'core', 'package.json');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'verify-release.js');

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('root package exposes release-quality verification scripts', async () => {
  const rootPkg = await readJson(ROOT_PACKAGE);

  assert.equal(rootPkg.scripts.test, 'node --test packages/core/test/*.test.js packages/cli/test/*.test.js');
  assert.equal(rootPkg.scripts.audit, 'npm audit --audit-level=moderate');
  assert.equal(rootPkg.scripts['pack:dry-run'], 'node scripts/verify-release.js --dry-run-only');
  assert.equal(rootPkg.scripts['smoke:pack'], 'node scripts/verify-release.js --skip-tests --skip-audit --skip-dry-run');
  assert.equal(rootPkg.scripts.verify, 'node scripts/verify-release.js');
});

test('published packages declare the intended public surfaces', async () => {
  const rootPkg = await readJson(ROOT_PACKAGE);
  const cliPkg = await readJson(CLI_PACKAGE);
  const corePkg = await readJson(CORE_PACKAGE);

  assert.equal(rootPkg.bin?.dockerforge, 'bin/dockerforge.js');
  assert.equal(rootPkg.dependencies?.['@dockerforge/cli'], rootPkg.version);
  assert.equal(rootPkg.bugs?.url, 'https://github.com/Mo-ASayed/DockerForge/issues');
  assert.ok(rootPkg.keywords.includes('dockerfile'));
  assert.ok(rootPkg.keywords.includes('containers'));

  assert.equal(cliPkg.bin?.dockerforge, 'src/index.js');
  assert.equal(cliPkg.exports?.['.'], './src/index.js');
  assert.equal(cliPkg.dependencies?.['@dockerforge/core'], corePkg.version);
  assert.equal(cliPkg.bugs?.url, 'https://github.com/Mo-ASayed/DockerForge/issues');

  assert.equal(corePkg.main, 'src/index.js');
  assert.equal(corePkg.exports?.['.'], './src/index.js');
  assert.equal(corePkg.bugs?.url, 'https://github.com/Mo-ASayed/DockerForge/issues');
});

test('release smoke script can verify packed tarballs without recursively running tests', async () => {
  const { stdout, stderr } = await run('node', [
    VERIFY_SCRIPT,
    '--skip-tests',
    '--skip-audit',
    '--skip-dry-run',
  ], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 1024 * 1024 * 8,
  });

  assert.match(stdout, /packed tarball smoke passed/);
  assert.doesNotMatch(stderr, /deprecated glob@10\.5\.0/);
});
