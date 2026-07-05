'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');

const {
  parseImageReference,
  pinDockerfileDigests,
  resolveDockerHubDigest,
} = require('../src/engine/digestPinning');

const core = require('../src/index.js');
const NODE_FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'node-npm');

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

test('runDockerfileEngine digest-pins generated Docker Hub FROM images when opted in', async () => {
  const projectPath = await core.ingestLocal(NODE_FIXTURE);
  const digest = `sha256:${'d'.repeat(64)}`;
  const result = await core.runDockerfileEngine({
    projectPath,
    pinDigests: true,
    digestResolver: async (imageRef) => ({
      original: imageRef,
      pinned: `${imageRef}@${digest}`,
      digest,
    }),
  });

  assert.match(result.dockerfile, /FROM node:20-alpine3\.21@sha256:d{64}/);
  assert.ok(result.improvements.some((item) => /Digest-pinned/.test(item)));
  assert.ok(result.warnings.some((item) => /Digest-pinned/.test(item)));
});

test('runDockerfileEngine stays offline by default when digest pinning is not requested', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network call attempted: fetch');
  };

  try {
    const projectPath = await core.ingestLocal(NODE_FIXTURE);
    const result = await core.runDockerfileEngine({ projectPath });
    assert.ok(result.dockerfile.includes('FROM'));
    assert.ok(!result.dockerfile.includes('@sha256:'));
  } finally {
    globalThis.fetch = previousFetch;
  }
});
