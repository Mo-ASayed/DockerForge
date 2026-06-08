'use strict';

// Regression test for the Next.js mis-routing bug.
// Before the fix, a Next.js app (role 'frontend', framework 'nextjs') was generated as a
// static nginx image: it emitted `COPY nginx.conf ...` (a file that does not exist, so the
// build failed) and served the .next output via nginx, which breaks SSR and API routes.
// After the fix, Next.js is built and run as a Node server (`next start`).
//
// Run host-side: `node --test test/nextjs.test.js` from packages/core.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const core = require('../src/index.js');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'node-nextjs');

test('Next.js is generated as a Node server, not a static nginx image', async () => {
  const projectPath = await core.ingestLocal(FIXTURE);
  const result = await core.runDockerfileEngine({ projectPath });
  const df = result.dockerfile;

  // The catastrophic bug: nginx static serving + a COPY of a non-existent nginx.conf.
  assert.ok(!/nginx/i.test(df), 'Dockerfile must NOT use nginx for a Next.js app');
  assert.ok(!df.includes('COPY nginx.conf'), 'must NOT COPY a non-existent nginx.conf');
  assert.equal(result.nginxConf, null, 'must not emit an nginx.conf for a Node server app');

  // It must run as a Node server via the package start script (next start).
  assert.ok(/CMD \["(yarn|npm)/.test(df), 'runtime CMD should start the Node server (next start)');

  // It must build with next build and ship the build output + runtime config.
  assert.ok(/RUN .*build/.test(df), 'should run the build step');
  assert.ok(df.includes('/app/.next ./.next'), 'should copy the .next build output into runtime');
});

test('Next.js source copy uses the real src/ layout, not a guessed app/pages/components', async () => {
  const projectPath = await core.ingestLocal(FIXTURE);
  const result = await core.runDockerfileEngine({ projectPath });
  const df = result.dockerfile;

  // The fixture uses a src/ layout (like the real-world app that surfaced this bug).
  assert.ok(df.includes('COPY src/ ./src/'), 'should copy the real src/ directory');
  assert.ok(!df.includes('COPY pages/ ./pages/'), 'should not blindly copy a non-existent pages/');
  assert.ok(df.includes('next.config.ts'), 'should copy the detected next.config.ts');
});
