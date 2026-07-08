#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'node-npm');
const DEPRECATED_GLOB_RE = /deprecated\s+glob@10\.5\.0/i;

const args = new Set(process.argv.slice(2));
const dryRunOnly = args.has('--dry-run-only');
const skipTests = args.has('--skip-tests');
const skipAudit = args.has('--skip-audit');
const skipDryRun = args.has('--skip-dry-run');

function resolveWindowsNpmTool(name) {
  const lookup = spawnSync('where.exe', [`${name}.cmd`], {
    encoding: 'utf8',
    shell: false,
  });
  if (lookup.status !== 0 || !lookup.stdout) {
    throw new Error(`Could not locate ${name}.cmd on PATH`);
  }

  const shim = lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith(`${name}.cmd`));

  if (!shim) throw new Error(`Could not resolve ${name}.cmd from where.exe output`);

  const cliName = name === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
  const cli = path.join(path.dirname(shim), 'node_modules', 'npm', 'bin', cliName);
  if (!fs.existsSync(cli)) throw new Error(`Could not locate ${cliName} beside ${shim}`);

  return { command: process.execPath, argsPrefix: [cli] };
}

function resolveTool(name) {
  if (process.platform !== 'win32') return { command: name, argsPrefix: [] };
  if (name === 'npm' || name === 'npx') return resolveWindowsNpmTool(name);
  return { command: name, argsPrefix: [] };
}

function run(command, commandArgs, options = {}) {
  const resolved = resolveTool(command);
  const result = spawnSync(resolved.command, [...resolved.argsPrefix, ...commandArgs], {
    cwd: options.cwd || ROOT,
    env: { ...process.env, NO_COLOR: '1', ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
    shell: false,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (!options.quiet) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }

  if (DEPRECATED_GLOB_RE.test(stdout) || DEPRECATED_GLOB_RE.test(stderr)) {
    throw new Error('install emitted deprecated glob@10.5.0 warning');
  }

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited ${result.status}`);
  }

  return { stdout, stderr };
}

function npm(commandArgs, options) {
  return run('npm', commandArgs, options);
}

function npx(commandArgs, options) {
  return run('npx', commandArgs, options);
}

function parsePackJson(stdout, label) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
  assert.ok(Array.isArray(entries), `${label}: npm pack --json should return package metadata`);
  assert.equal(entries.length, 1, `${label}: expected one packed package`);
  assert.ok(entries[0].files.length > 0, `${label}: packed package should contain files`);
  for (const file of entries[0].files) {
    assert.ok(!file.path.includes('node_modules'), `${label}: tarball must not include node_modules`);
    assert.ok(!file.path.endsWith('.tgz'), `${label}: tarball must not include generated tarballs`);
  }
  return entries[0];
}

function dryRunPack() {
  const packages = [
    ['root', ['pack', '--dry-run', '--json']],
    ['@dockerforge/cli', ['pack', '--dry-run', '--json', '-w', '@dockerforge/cli']],
    ['@dockerforge/core', ['pack', '--dry-run', '--json', '-w', '@dockerforge/core']],
  ];

  for (const [label, packArgs] of packages) {
    const { stdout } = npm(packArgs, { quiet: true });
    const result = parsePackJson(stdout, label);
    console.log(`${label}: dry-run pack contains ${result.entryCount} files (${result.unpackedSize} bytes unpacked)`);
  }
}

function findTarball(dir, pattern) {
  const matches = fs.readdirSync(dir)
    .filter((file) => pattern.test(file))
    .map((file) => path.join(dir, file));
  assert.equal(matches.length, 1, `expected one tarball matching ${pattern}, found ${matches.length}`);
  return matches[0];
}

function initConsumer(dir) {
  fs.mkdirSync(dir, { recursive: true });
  npm(['init', '-y'], { cwd: dir, quiet: true });
}

function installTarballs(dir, tarballs) {
  npm(['install', ...tarballs], { cwd: dir });
}

function assertCliVersion(dir, expectedVersion) {
  const { stdout } = npx(['dockerforge', '--version'], { cwd: dir, quiet: true });
  assert.equal(stdout.trim(), expectedVersion);
}

function assertGenerateJson(dir) {
  const { stdout } = npx(['dockerforge', 'generate', FIXTURE, '--json'], { cwd: dir, quiet: true });
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.dockerfile.includes('FROM'), 'generate --json should include a Dockerfile');
  assert.equal(typeof parsed.confidence, 'number', 'generate --json should include confidence');
}

function packRealTarballs(tmpDir) {
  npm(['pack', '--pack-destination', tmpDir], { quiet: true });
  npm(['pack', '-w', '@dockerforge/core', '--pack-destination', tmpDir], { quiet: true });
  npm(['pack', '-w', '@dockerforge/cli', '--pack-destination', tmpDir], { quiet: true });

  return {
    root: findTarball(tmpDir, /^dockerforge-\d+\.\d+\.\d+.*\.tgz$/),
    core: findTarball(tmpDir, /^dockerforge-core-\d+\.\d+\.\d+.*\.tgz$/),
    cli: findTarball(tmpDir, /^dockerforge-cli-\d+\.\d+\.\d+.*\.tgz$/),
  };
}

function readRootVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

function smokePackedTarballs() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockerforge-release-'));
  try {
    const tarballs = packRealTarballs(tmpDir);
    const expectedVersion = readRootVersion();

    const scopedConsumer = path.join(tmpDir, 'scoped-consumer');
    initConsumer(scopedConsumer);
    installTarballs(scopedConsumer, [tarballs.core, tarballs.cli]);
    assertCliVersion(scopedConsumer, expectedVersion);
    assertGenerateJson(scopedConsumer);

    const rootConsumer = path.join(tmpDir, 'root-consumer');
    initConsumer(rootConsumer);
    installTarballs(rootConsumer, [tarballs.core, tarballs.cli, tarballs.root]);
    assertCliVersion(rootConsumer, expectedVersion);

    console.log('packed tarball smoke passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main() {
  if (dryRunOnly) {
    dryRunPack();
    return;
  }

  if (!skipTests) npm(['test']);
  if (!skipAudit) npm(['audit', '--audit-level=moderate']);
  if (!skipDryRun) dryRunPack();
  smokePackedTarballs();
}

main();
