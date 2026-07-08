'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const ROOT = path.join(__dirname, '..', '..', '..');
const ROOT_PACKAGE = path.join(ROOT, 'package.json');
const CLI_PACKAGE = path.join(ROOT, 'packages', 'cli', 'package.json');
const CORE_PACKAGE = path.join(ROOT, 'packages', 'core', 'package.json');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'verify-release.js');
const RELEASE_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function loadVerifyReleaseInternals() {
  const source = await fs.readFile(VERIFY_SCRIPT, 'utf8');
  const instrumented = source.replace(/\nmain\(\);\s*$/, '\nmodule.exports = { parsePackJson };\n');
  const module = { exports: {} };
  vm.runInNewContext(instrumented, {
    require,
    module,
    exports: module.exports,
    __dirname: path.dirname(VERIFY_SCRIPT),
    __filename: VERIFY_SCRIPT,
    process,
    console,
  }, { filename: VERIFY_SCRIPT });
  return module.exports;
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

test('release pack parser accepts npm 12 object-shaped JSON output', async () => {
  const { parsePackJson } = await loadVerifyReleaseInternals();
  const result = parsePackJson(JSON.stringify({
    dockerforge: {
      id: 'dockerforge@0.2.5',
      name: 'dockerforge',
      version: '0.2.5',
      filename: 'dockerforge-0.2.5.tgz',
      files: [
        { path: 'package.json', size: 1260, mode: 420 },
        { path: 'bin/dockerforge.js', size: 64, mode: 420 },
      ],
      entryCount: 2,
      unpackedSize: 1324,
    },
  }), 'root');

  assert.equal(result.name, 'dockerforge');
  assert.equal(result.files.length, 2);
});

test('release workflow pins npm instead of installing latest', async () => {
  const workflow = await fs.readFile(RELEASE_WORKFLOW, 'utf8');

  assert.match(workflow, /npm install -g npm@11\.12\.1/);
  assert.doesNotMatch(workflow, /npm install -g npm@latest/);
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
