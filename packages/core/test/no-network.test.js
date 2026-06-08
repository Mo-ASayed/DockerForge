'use strict';

// Enforces the @dockerforge/core no-network guarantee (contract Section 1).
// We monkeypatch the network primitives to throw, then run a real generation against a
// backend fixture. If core touches the network, the test fails loudly.
//
// Run host-side: `node --test test/` from packages/core (needs backend fixtures present).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

function blockNetwork() {
  const http = require('node:http');
  const https = require('node:https');
  const net = require('node:net');
  const dns = require('node:dns');
  const boom = (name) => () => { throw new Error(`network call attempted: ${name}`); };

  http.request = boom('http.request');
  http.get = boom('http.get');
  https.request = boom('https.request');
  https.get = boom('https.get');
  net.connect = boom('net.connect');
  net.createConnection = boom('net.createConnection');
  if (net.Socket && net.Socket.prototype) net.Socket.prototype.connect = boom('net.Socket.connect');
  if (dns.lookup) dns.lookup = boom('dns.lookup');
  if (dns.promises) dns.promises.lookup = boom('dns.promises.lookup');
}

test('core generates a Dockerfile with no network access', async () => {
  blockNetwork();

  const core = require('../src/index.js');
  const fixture = path.join(
    __dirname, '..', '..', '..', 'fixtures', 'node-npm'
  );

  const projectPath = await core.ingestLocal(fixture);
  const result = await core.runDockerfileEngine({ projectPath });

  assert.ok(result.dockerfile.includes('FROM'), 'should produce a Dockerfile');
  assert.equal(typeof result.confidence, 'number', 'should return a confidence score');
});

test('ingestLocal throws typed PathNotFoundError', async () => {
  const core = require('../src/index.js');
  await assert.rejects(
    () => core.ingestLocal(path.join(__dirname, 'does-not-exist-xyz')),
    (err) => err.code === 'PATH_NOT_FOUND'
  );
});

test('runDockerfileEngine rejects remote-only input (no projectPath)', async () => {
  const core = require('../src/index.js');
  await assert.rejects(
    () => core.runDockerfileEngine({ gitUrl: 'https://example.com/x/y' }),
    (err) => err.code === 'INGEST_ERROR'
  );
});
