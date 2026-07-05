# NPM Package Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DockerForge install, run, verify, and publish cleanly as a polished npm CLI/library package.

**Architecture:** Keep the workspace split into `@dockerforge/core`, `@dockerforge/cli`, and the optional root `dockerforge` alias. Add a cross-platform release verification script that packs real tarballs, installs them into fresh consumers, and runs the CLI as users receive it.

**Tech Stack:** Node.js CommonJS, npm workspaces, Node built-in test runner, GitHub Actions, npm trusted publishing-ready workflows.

---

## File Structure

- Create: `packages/cli/test/package-readiness.test.js` - metadata and release-script tests that fail before package-readiness implementation.
- Create: `scripts/verify-release.js` - cross-platform release verification script used by `npm run verify` and CI.
- Modify: `package.json` - canonical verification scripts, package metadata, optional root alias metadata.
- Modify: `packages/cli/package.json` - CLI package metadata, scripts, dependency version.
- Modify: `packages/core/package.json` - core metadata, scripts, dependency versions, public export surface.
- Modify: `package-lock.json` - npm-generated lockfile after dependency updates.
- Modify: `README.md` - scoped-first install path and release-quality quick start.
- Modify: `packages/cli/README.md` - accurate install, exit-code, and error-output docs.
- Modify: `packages/core/README.md` - package metadata and API docs consistency.
- Modify: `docs/cli.md` - canonical package path and accurate CLI behavior.
- Create: `docs/release.md` - release checklist, publish order, and npm trusted publishing notes.
- Create: `.github/workflows/ci.yml` - verification workflow for pushes and pull requests.
- Create: `.github/workflows/release.yml` - manual trusted-publishing-ready release workflow.

Implementation commits are deferred because the checkout already contains user-owned uncommitted release-candidate changes. Stage or commit only after the final verification result is reviewed.

### Task 1: Package Readiness Tests

**Files:**
- Create: `packages/cli/test/package-readiness.test.js`

- [ ] **Step 1: Write the failing metadata and verification tests**

Create `packages/cli/test/package-readiness.test.js` with:

```js
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
```

- [ ] **Step 2: Run the new test and verify it fails for the expected reason**

Run:

```bash
node --test packages/cli/test/package-readiness.test.js
```

Expected: FAIL because `scripts/verify-release.js`, the new scripts, and/or `exports` metadata do not exist yet.

### Task 2: Release Verification Script

**Files:**
- Create: `scripts/verify-release.js`
- Modify: `package.json`

- [ ] **Step 1: Implement the cross-platform release verification script**

Create `scripts/verify-release.js` with a CommonJS Node script that:

- parses `--dry-run-only`, `--skip-tests`, `--skip-audit`, and `--skip-dry-run`;
- runs commands with `child_process.spawnSync`;
- runs `npm test` unless skipped;
- runs `npm audit --audit-level=moderate` unless skipped;
- runs `npm pack --dry-run --json` for root, CLI, and core unless skipped;
- creates a temporary directory under `os.tmpdir()`;
- runs real `npm pack` commands into that directory;
- creates fresh consumer projects;
- installs the packed core/CLI tarballs and runs `npx dockerforge --version`;
- runs `npx dockerforge generate <fixtures/node-npm> --json`;
- installs the root alias tarball into a separate consumer and runs `npx dockerforge --version`;
- fails if stderr/stdout contains `deprecated glob@10.5.0`;
- prints `packed tarball smoke passed` after the tarball install checks pass.

- [ ] **Step 2: Add release verification scripts to `package.json`**

Update root `scripts` to:

```json
{
  "test": "node --test packages/core/test/*.test.js packages/cli/test/*.test.js",
  "audit": "npm audit --audit-level=moderate",
  "pack:dry-run": "node scripts/verify-release.js --dry-run-only",
  "smoke:pack": "node scripts/verify-release.js --skip-tests --skip-audit --skip-dry-run",
  "verify": "node scripts/verify-release.js"
}
```

- [ ] **Step 3: Run the package-readiness test and verify it still fails only on missing metadata/dependency cleanup if applicable**

Run:

```bash
node --test packages/cli/test/package-readiness.test.js
```

Expected: the script-existence parts pass; metadata and deprecation checks may still fail until Task 3.

### Task 3: Metadata And Dependency Cleanup

**Files:**
- Modify: `package.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/core/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Update package metadata**

Ensure the root package has:

```json
{
  "bugs": {
    "url": "https://github.com/Mo-ASayed/DockerForge/issues"
  },
  "keywords": [
    "docker",
    "dockerfile",
    "container",
    "containers",
    "containerize",
    "cli",
    "generator",
    "lint",
    "sarif"
  ]
}
```

Ensure `packages/cli/package.json` has:

```json
{
  "exports": {
    ".": "./src/index.js"
  }
}
```

Ensure `packages/core/package.json` has:

```json
{
  "exports": {
    ".": "./src/index.js"
  }
}
```

- [ ] **Step 2: Update dependencies while preserving Node 18 support**

Run:

```bash
npm install -w @dockerforge/core glob@13.0.6 adm-zip@0.5.18 fs-extra@11.3.6
npm install -w @dockerforge/cli commander@13.1.0
```

Expected: `package-lock.json`, `packages/core/package.json`, and `packages/cli/package.json` update. Commander stays Node 18-compatible; do not upgrade to Commander 14 or 15 in this pass.

- [ ] **Step 3: Run the readiness test**

Run:

```bash
node --test packages/cli/test/package-readiness.test.js
```

Expected: PASS.

### Task 4: Documentation And Workflows

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `packages/core/README.md`
- Modify: `docs/cli.md`
- Create: `docs/release.md`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Update user-facing docs**

Update docs so the canonical install path is:

```bash
npx @dockerforge/cli generate ./my-app
```

and the canonical global install path is:

```bash
npm install -g @dockerforge/cli
dockerforge generate ./my-app
```

Remove any claim that CLI errors are JSON-formatted unless the command actually prints JSON errors.

- [ ] **Step 2: Add release documentation**

Create `docs/release.md` covering:

- local gate: `npm run verify`;
- publish order: `npm publish -w @dockerforge/core`, then `npm publish -w @dockerforge/cli`;
- optional root alias publish only after unscoped `dockerforge` access is confirmed;
- trusted publishing/provenance setup requirement on npmjs.com;
- staged publishing as an optional human approval step for existing packages.

- [ ] **Step 3: Add CI workflow**

Create `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm run verify
```

- [ ] **Step 4: Add manual release workflow**

Create `.github/workflows/release.yml` with:

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      publish_root_alias:
        description: Publish the optional unscoped dockerforge alias package
        type: boolean
        default: false

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - run: npm run verify
      - run: npm publish -w @dockerforge/core --provenance
      - run: npm publish -w @dockerforge/cli --provenance
      - if: ${{ inputs.publish_root_alias }}
        run: npm publish --provenance
```

### Task 5: Final Verification

**Files:**
- All changed files

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run verify
```

Expected: PASS, including tests, audit, dry-run pack, and fresh tarball consumer smoke checks.

- [ ] **Step 2: Inspect package contents**

Run:

```bash
npm pack --dry-run --json
npm pack --dry-run --json -w @dockerforge/cli
npm pack --dry-run --json -w @dockerforge/core
```

Expected: tarballs contain only intentional runtime files, package README files, license, and notices.

- [ ] **Step 3: Inspect final git state**

Run:

```bash
git status --short
git diff --stat
```

Expected: implementation files are modified/added; no unexpected generated tarballs or temporary consumer directories are present.

- [ ] **Step 4: Report results**

Report:

- tests and verification commands run;
- package install smoke result;
- any remaining manual release steps, especially npm trusted publisher configuration and optional root alias publish access.
