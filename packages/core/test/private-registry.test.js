'use strict';

// Regression test for private/scoped-registry support and the Next.js single-install runtime.
//
// Bug 1: the default Dockerfile stripped the `--mount=type=secret,id=npmrc` line, so apps that
//        depend on private scoped packages (e.g. @yourco/*) could never authenticate and the
//        install 404'd. The secret mount must survive into the default Dockerfile.
// Bug 2: the Next.js runtime re-ran `install --production`, fetching every dep a second time
//        (and needing the private token twice). The runtime should copy node_modules from the
//        builder instead, so the registry is contacted only once.
//
// Run host-side: `node --test test/private-registry.test.js` from packages/core.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/index.js');

async function makeNextApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockerforge-next-priv-'));
  await fs.writeFile(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'private-next-app',
    private: true,
    scripts: { build: 'next build', start: 'next start' },
    dependencies: {
      next: '15.0.0',
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      '@yourco/ui': '^1.0.0',        // a private, scoped dependency
    },
    devDependencies: { typescript: '^5' },
  }, null, 2));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'index.tsx'), 'export default function App(){return null;}\n');
  await fs.writeFile(path.join(dir, 'next.config.ts'), 'export default {};\n');
  return dir;
}

test('Next.js app with scoped deps keeps the npmrc secret mount in the default Dockerfile', async () => {
  const dir = await makeNextApp();
  try {
    const projectPath = await core.ingestLocal(dir);
    const result = await core.runDockerfileEngine({ projectPath });
    const df = result.dockerfile; // the default (simple) Dockerfile users receive

    // Secret mount must survive so `docker build --secret id=npmrc,src=.npmrc` can authenticate.
    assert.ok(
      df.includes('--mount=type=secret,id=npmrc'),
      'default Dockerfile must keep the npmrc secret mount for scoped/private packages'
    );
    // Cache mounts are still stripped from the default output.
    assert.ok(!df.includes('--mount=type=cache'), 'cache mounts should be stripped from the default Dockerfile');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Next.js runtime copies node_modules from the builder instead of re-installing', async () => {
  const dir = await makeNextApp();
  try {
    const projectPath = await core.ingestLocal(dir);
    const result = await core.runDockerfileEngine({ projectPath });
    const df = result.dockerfile;

    // Runtime stage is everything after the final FROM. Look only at RUN commands so a
    // comment that happens to mention "install" doesn't trip the check.
    const runtime = df.slice(df.lastIndexOf('\nFROM '));
    const runtimeRunCmds = runtime.split('\n').filter(l => /^\s*RUN\s/.test(l)).join('\n');
    assert.ok(df.includes('COPY --from=builder /app/node_modules ./node_modules'), 'runtime should copy built node_modules');
    assert.ok(df.includes('COPY --from=builder /app/package.json ./package.json'), 'runtime should copy package.json from builder');
    assert.ok(
      !/yarn install|npm ci|pnpm install/.test(runtimeRunCmds),
      'runtime stage must NOT run a second dependency install (registry contacted once, in the builder)'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
