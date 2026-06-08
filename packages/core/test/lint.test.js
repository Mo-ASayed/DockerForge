'use strict';

// Lint engine tests (Chunk 1.2). Raw-string inputs keep them deterministic and offline.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/index.js');

const ids = (r) => r.findings.map((f) => f.ruleId).sort();

test('flags an unpinned :latest base (DF001)', async () => {
  const r = await core.lint({ dockerfile: 'FROM node:latest\nWORKDIR /app\nUSER node\nCMD ["node","x.js"]' });
  assert.ok(ids(r).includes('DF001'));
});

test('flags a missing tag as unpinned (DF001)', async () => {
  const r = await core.lint({ dockerfile: 'FROM ubuntu\nWORKDIR /app\nUSER app' });
  assert.ok(ids(r).includes('DF001'));
});

test('does NOT flag a digest-pinned base, and does not false-positive registry:port', async () => {
  const r = await core.lint({ dockerfile: 'FROM registry.example.com:5000/node:20-alpine@sha256:abc\nWORKDIR /app\nUSER node' });
  assert.ok(!ids(r).includes('DF001'), 'digest + registry port should be clean for DF001');
});

test('flags root + COPY . . + secret + missing workdir', async () => {
  const df = 'FROM node:20-alpine\nCOPY . .\nENV API_KEY=sk_live_123\nCMD ["node","x.js"]';
  const r = await core.lint({ dockerfile: df });
  const got = ids(r);
  assert.ok(got.includes('DF002'), 'root');     // no USER
  assert.ok(got.includes('DF003'), 'COPY . .');
  assert.ok(got.includes('DF005'), 'secret');
  assert.ok(got.includes('DF006'), 'no WORKDIR');
});

test('clean dockerfile (raw) yields no findings', async () => {
  const df = [
    'FROM node:20-alpine@sha256:abc AS build',
    'WORKDIR /app',
    'COPY package.json package-lock.json ./',
    'RUN npm ci',
    'COPY src ./src',
    'USER node',
    'CMD ["node","src/index.js"]',
  ].join('\n');
  const r = await core.lint({ dockerfile: df });
  assert.deepEqual(r.findings, [], 'expected no findings, got: ' + JSON.stringify(r.findings));
});

test('multi-stage: build stage from alias is not flagged as unpinned', async () => {
  const df = [
    'FROM node:20-alpine@sha256:abc AS build',
    'WORKDIR /app',
    'RUN echo hi',
    'FROM build',
    'WORKDIR /app',
    'USER node',
  ].join('\n');
  const r = await core.lint({ dockerfile: df });
  assert.ok(!ids(r).includes('DF001'), 'FROM build (alias) must not be flagged');
});

test('rules option filters which rules run', async () => {
  const r = await core.lint({ dockerfile: 'FROM node:latest\nCOPY . .' }, { rules: ['DF003'] });
  assert.deepEqual(ids(r), ['DF003']);
});

test('summary reports worst severity', async () => {
  const r = await core.lint({ dockerfile: 'FROM node:20-alpine\nENV PASSWORD=hunter2\nUSER node\nWORKDIR /app' });
  assert.equal(r.summary.worst, 'critical');
  assert.equal(r.summary.counts.critical, 1);
});

test('throws typed error on a missing Dockerfile path', async () => {
  await assert.rejects(() => core.lint('/no/such/Dockerfile.xyz'), (e) => e.code === 'PATH_NOT_FOUND');
});
