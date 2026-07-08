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
const fs = require('node:fs/promises');
const os = require('node:os');
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

test('Next.js with output: "standalone" emits the self-contained standalone bundle', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockerforge-next-standalone-'));
  try {
    await fs.writeFile(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'standalone-next', private: true,
      scripts: { build: 'next build', start: 'next start' },
      dependencies: { next: '15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
    }, null, 2));
    await fs.writeFile(path.join(dir, 'next.config.ts'), "export default { output: 'standalone' };\n");
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'index.tsx'), 'export default function P(){return null;}\n');

    const projectPath = await core.ingestLocal(dir);
    const result = await core.runDockerfileEngine({ projectPath });
    const df = result.dockerfile;

    assert.ok(df.includes('/.next/standalone ./'), 'should copy the standalone server bundle to /app');
    assert.ok(df.includes('/.next/static ./.next/static'), 'should copy .next/static');
    assert.ok(df.includes('CMD ["node", "server.js"]'), 'standalone runs node server.js');
    assert.ok(df.includes('USER node'), 'standalone runtime runs as the non-root node user');
    assert.ok(df.includes('ENV HOSTNAME=0.0.0.0'), 'standalone server must bind 0.0.0.0 to be reachable');
    // Standalone bundles its own node_modules — the runtime must NOT copy or install them.
    const runtime = df.slice(df.lastIndexOf('\nFROM '));
    const runtimeInstructions = runtime
      .split('\n')
      .filter(l => /^\s*(COPY|RUN)\s/.test(l))
      .join('\n');
    assert.ok(!/node_modules/.test(runtimeInstructions), 'standalone runtime must not copy node_modules');
    assert.ok(!/install/.test(runtimeInstructions), 'standalone runtime must not install');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Next.js without standalone falls back to copying production node_modules', async () => {
  // The committed fixture (node-nextjs) has a plain next.config.ts with no standalone flag.
  const projectPath = await core.ingestLocal(FIXTURE);
  const result = await core.runDockerfileEngine({ projectPath });
  const df = result.dockerfile;

  assert.ok(!df.includes('/.next/standalone'), 'non-standalone app should not use the standalone bundle');
  assert.ok(df.includes('COPY --from=builder /app/node_modules ./node_modules'), 'non-standalone runtime copies production node_modules');
});

test('Next.js root app is not displaced by Terraform cache modules', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockerforge-next-terraform-'));
  try {
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({
      name: 'next-with-terraform-cache',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'next-with-terraform-cache',
          version: '1.0.0',
          dependencies: { next: '15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
        },
      },
    }, null, 2));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'next-with-terraform-cache',
      private: true,
      scripts: { build: 'next build', start: 'next start' },
      dependencies: { next: '15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
    }, null, 2));
    await fs.writeFile(path.join(dir, 'next.config.ts'), 'export default {};\n');
    await fs.mkdir(path.join(dir, 'src', 'app'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'app', 'page.tsx'), 'export default function Page(){return null;}\n');

    const moduleDir = path.join(dir, 'terraform', '.terraform', 'modules', 'naming');
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'go.mod'), 'module github.com/acme/terraform-naming\n\ngo 1.23\n');
    await fs.writeFile(path.join(moduleDir, 'main.go'), 'package main\nfunc main(){}\n');

    const projectPath = await core.ingestLocal(dir);
    const result = await core.runDockerfileEngine({ projectPath });
    const df = result.dockerfile;

    assert.equal(result.analysis.services.length, 1);
    assert.equal(result.analysis.services[0].stack, 'node');
    assert.equal(result.analysis.services[0].serviceDir, '.', 'the frontend root should remain the service');
    assert.ok(df.includes('COPY src/ ./src/'), 'should generate the Next.js root Dockerfile');
    assert.ok(!df.includes('terraform/.terraform/modules'), 'must not build cached Terraform modules');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
