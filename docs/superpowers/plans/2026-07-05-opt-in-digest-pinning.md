# Opt-In Digest Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `dockerforge generate --pin-digests` so generated Dockerfiles can opt into Docker Hub `@sha256:` base-image pinning while default generation remains offline.

**Architecture:** Add a focused `digestPinning` module under the core engine to parse `FROM` image references, resolve Docker Hub manifests with Node built-ins, and rewrite generated Dockerfiles. Wire `pinDigests` from the CLI to core without changing default behavior.

**Tech Stack:** Node.js CommonJS, Node built-in `fetch`, `crypto`, and `node:test`; npm workspaces.

---

## File Structure

- Create: `packages/core/src/engine/digestPinning.js` - image reference parsing, Docker Hub token/manifest resolution, and Dockerfile `FROM` rewriting.
- Create: `packages/core/test/digest-pinning.test.js` - unit tests for parsing, rewriting, mocked registry resolution, and default no-network behavior.
- Modify: `packages/core/src/engine/index.js` - opt-in digest pinning after generation/optimisation and before final result creation.
- Modify: `packages/core/src/index.js` - pass `pinDigests` through the public API.
- Modify: `packages/cli/src/index.js` - add `--pin-digests` flag and pass it to core.
- Modify: `packages/cli/test/cli.test.js` - assert CLI flag reaches core behavior via deterministic test hook.
- Modify: `README.md`, `packages/cli/README.md`, `docs/cli.md` - document opt-in network behavior and digest update tradeoff.

Implementation should not add runtime dependencies.

### Task 1: Core Digest Pinning Tests

**Files:**
- Create: `packages/core/test/digest-pinning.test.js`

- [ ] **Step 1: Write failing tests**

Create tests that require `../src/engine/digestPinning` and assert:

```js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  parseImageReference,
  pinDockerfileDigests,
  resolveDockerHubDigest,
} = require('../src/engine/digestPinning');

test('parseImageReference handles Docker Hub official images', () => {
  assert.deepEqual(parseImageReference('node:20-alpine3.21'), {
    original: 'node:20-alpine3.21',
    registry: 'docker.io',
    repository: 'library/node',
    tag: '20-alpine3.21',
    registryType: 'docker-hub',
  });
});

test('parseImageReference rejects untagged images', () => {
  assert.throws(
    () => parseImageReference('node'),
    /Cannot digest-pin an image without an explicit tag/
  );
});

test('parseImageReference rejects unsupported registries', () => {
  assert.throws(
    () => parseImageReference('ghcr.io/acme/app:1.0'),
    /supports Docker Hub images only/
  );
});

test('pinDockerfileDigests rewrites external FROM images and preserves stage syntax', async () => {
  const dockerfile = [
    '# syntax=docker/dockerfile:1',
    'FROM --platform=$BUILDPLATFORM node:20-alpine3.21 AS builder',
    'RUN npm ci',
    'FROM builder AS deps',
    'FROM node:20-alpine3.21',
    'USER node',
  ].join('\n');

  const result = await pinDockerfileDigests(dockerfile, {
    resolveDigest: async (imageRef) => ({
      original: imageRef,
      pinned: `${imageRef}@sha256:${'a'.repeat(64)}`,
      digest: `sha256:${'a'.repeat(64)}`,
    }),
  });

  assert.match(result.dockerfile, /FROM --platform=\$BUILDPLATFORM node:20-alpine3\.21@sha256:a{64} AS builder/);
  assert.match(result.dockerfile, /FROM builder AS deps/);
  assert.match(result.dockerfile, /FROM node:20-alpine3\.21@sha256:a{64}\nUSER node/);
  assert.equal(result.pinnedImages.length, 2);
});

test('pinDockerfileDigests leaves already digest-pinned images alone', async () => {
  let calls = 0;
  const digest = `sha256:${'b'.repeat(64)}`;
  const dockerfile = `FROM node:20-alpine3.21@${digest}\nUSER node`;

  const result = await pinDockerfileDigests(dockerfile, {
    resolveDigest: async () => {
      calls += 1;
      throw new Error('should not resolve');
    },
  });

  assert.equal(result.dockerfile, dockerfile);
  assert.equal(calls, 0);
});

test('resolveDockerHubDigest uses token and manifest digest header', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith('https://auth.docker.io/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: 'token-123' }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'docker-content-digest' ? `sha256:${'c'.repeat(64)}` : null },
      arrayBuffer: async () => Buffer.from('{}'),
    };
  };

  const result = await resolveDockerHubDigest('node:20-alpine3.21', { fetchImpl });
  assert.equal(result.pinned, `node:20-alpine3.21@sha256:${'c'.repeat(64)}`);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /scope=repository%3Alibrary%2Fnode%3Apull/);
  assert.match(calls[1].url, /\/v2\/library\/node\/manifests\/20-alpine3\.21$/);
});

test('resolveDockerHubDigest computes digest when header is absent', async () => {
  const body = Buffer.from('{"schemaVersion":2}');
  const expected = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    if (requestCount === 1) return { ok: true, status: 200, json: async () => ({ token: 'token-123' }) };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => body,
    };
  };

  const result = await resolveDockerHubDigest('library/alpine:3.21', { fetchImpl });
  assert.equal(result.digest, expected);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test packages/core/test/digest-pinning.test.js
```

Expected: FAIL because `packages/core/src/engine/digestPinning.js` does not exist.

### Task 2: Implement Digest Module

**Files:**
- Create: `packages/core/src/engine/digestPinning.js`

- [ ] **Step 1: Implement parser, resolver, and rewrite helpers**

Implement:

- `parseImageReference(imageRef)`
- `resolveDockerHubDigest(imageRef, options = {})`
- `pinDockerfileDigests(dockerfile, options = {})`

Use `globalThis.fetch` by default and `crypto.createHash('sha256')` for fallback digest calculation. Use Accept headers:

```js
[
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')
```

Preserve `FROM --platform=...`, `AS alias`, stage references, and already digest-pinned images.

- [ ] **Step 2: Run digest tests**

Run:

```bash
node --test packages/core/test/digest-pinning.test.js
```

Expected: PASS.

### Task 3: Core Engine Integration

**Files:**
- Modify: `packages/core/src/engine/index.js`
- Modify: `packages/core/src/index.js`
- Modify: `packages/core/test/digest-pinning.test.js`

- [ ] **Step 1: Add failing integration tests**

Append tests to `packages/core/test/digest-pinning.test.js` that:

- call `core.runDockerfileEngine({ projectPath, pinDigests: true, digestResolver })`;
- assert generated Dockerfile contains `@sha256:`;
- assert improvements and warnings mention digest pinning;
- block `globalThis.fetch` and prove default `runDockerfileEngine({ projectPath })` still succeeds.

- [ ] **Step 2: Run integration tests and verify failure**

Run:

```bash
node --test packages/core/test/digest-pinning.test.js
```

Expected: FAIL because `pinDigests` is not wired through.

- [ ] **Step 3: Wire `pinDigests` through core**

Update `packages/core/src/index.js` to pass `pinDigests` and an optional `digestResolver` test hook to engine:

```js
const { projectPath, hints, optimise, security, validation, pinDigests, digestResolver } = input;
return engine.runDockerfileEngine({ projectPath, hints, optimise, security, validation, pinDigests, digestResolver });
```

Update `packages/core/src/engine/index.js` to call `pinDockerfileDigests` after optimisation and before `securityPass`, then add improvement/warning text.

- [ ] **Step 4: Run integration tests**

Run:

```bash
node --test packages/core/test/digest-pinning.test.js
```

Expected: PASS.

### Task 4: CLI Flag

**Files:**
- Modify: `packages/cli/src/index.js`
- Modify: `packages/cli/test/cli.test.js`

- [ ] **Step 1: Add failing CLI test**

Append a CLI test that runs:

```bash
DOCKERFORGE_TEST_DIGEST=sha256:<64 hex chars> node packages/cli/src/index.js generate fixtures/node-npm --print --pin-digests
```

Assert stdout contains `@sha256:`.

- [ ] **Step 2: Run CLI tests and verify failure**

Run:

```bash
node --test packages/cli/test/cli.test.js
```

Expected: FAIL because the flag does not exist.

- [ ] **Step 3: Add CLI flag and test hook**

Add:

```js
.option('--pin-digests', 'Resolve Docker Hub base-image tags to immutable sha256 digests (network)')
```

Pass `pinDigests: opts.pinDigests` to core. For deterministic CLI tests, if `process.env.DOCKERFORGE_TEST_DIGEST` is set, pass a `digestResolver` function that appends the supplied digest.

- [ ] **Step 4: Run CLI tests**

Run:

```bash
node --test packages/cli/test/cli.test.js
```

Expected: PASS.

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `docs/cli.md`

- [ ] **Step 1: Document opt-in digest pinning**

Add examples:

```bash
dockerforge generate . --pin-digests
npx @dockerforge/cli generate ./my-app --pin-digests --print
```

Document that default generation is offline, `--pin-digests` makes live Docker Hub registry requests, and digest-pinned images need an update process.

### Task 6: Final Verification

**Files:**
- All changed files

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run release verification**

Run:

```bash
npm run verify
```

Expected: PASS.

- [ ] **Step 3: Inspect status**

Run:

```bash
git status --short --branch
git diff --stat
```

Expected: only intended files changed.
