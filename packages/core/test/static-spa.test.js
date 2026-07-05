'use strict';

// Regression test for frontend-only SPA generation.
// Static SPA builds should produce a normal Node static-server image using `serve`.
// They must not depend on nginx config files or generated inline nginx config.
//
// Run host-side: `node --test test/static-spa.test.js` from packages/core.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/index.js');
const VITE_FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'node-vite');

test('static SPA (Vite) is served by non-root Node serve with no nginx config machinery', async () => {
  const projectPath = await core.ingestLocal(VITE_FIXTURE);
  const result = await core.runDockerfileEngine({ projectPath });
  const df = result.dockerfile;

  assert.ok(!/nginx/i.test(df), 'Dockerfile must not use nginx for a generated static SPA');
  assert.ok(!df.includes('COPY nginx.conf'), 'must not COPY a non-existent nginx.conf');
  assert.ok(!df.includes('NGINX_CONF'), 'must not write inline nginx config');
  assert.equal(result.nginxConf, null, 'must not emit a separate nginx.conf file');

  assert.ok(df.includes('FROM node:'), 'runtime should stay on a Node base image');
  assert.ok(df.includes('npm install -g serve@'), 'runtime should install a pinned serve package');
  assert.ok(df.includes('COPY --from=builder /app/dist ./dist'), 'runtime should copy only the built dist output');
  assert.ok(df.includes('USER node'), 'runtime should drop to the non-root node user');
  assert.ok(df.includes('CMD ["serve", "-s", "dist", "-l", "3000"]'), 'runtime should serve the SPA build output');
});

test('static SPA copies detected build config without copying absent source dirs', async () => {
  const projectPath = await core.ingestLocal(VITE_FIXTURE);
  const result = await core.runDockerfileEngine({ projectPath });
  const df = result.dockerfile;

  assert.ok(df.includes('COPY vite.config.js ./'), 'should copy the detected Vite config');
  assert.ok(!df.includes('COPY public/ ./public/'), 'should not copy absent public/');
  assert.ok(!df.includes('COPY src/ ./src/'), 'should not copy absent src/');
});

test('static SPA copies real source, public assets, and TypeScript config when present', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockerforge-vite-real-inputs-'));
  try {
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}\n');
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'vite-real-inputs',
      version: '1.0.0',
      scripts: { build: 'vite build' },
      dependencies: {
        '@vitejs/plugin-react': '^4.0.0',
        vite: '^5.0.0',
        react: '^18.2.0',
        'react-dom': '^18.2.0',
      },
      devDependencies: {
        typescript: '^5.0.0',
      },
    }, null, 2));
    await fs.writeFile(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{"jsx":"react-jsx"}}\n');
    await fs.writeFile(path.join(dir, 'vite.config.ts'), 'export default {};\n');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'main.tsx'), 'export default null;\n');
    await fs.mkdir(path.join(dir, 'public'), { recursive: true });
    await fs.writeFile(path.join(dir, 'public', 'favicon.txt'), 'icon\n');

    const projectPath = await core.ingestLocal(dir);
    const result = await core.runDockerfileEngine({ projectPath });
    const df = result.dockerfile;

    assert.ok(df.includes('COPY tsconfig.json vite.config.ts ./') || df.includes('COPY vite.config.ts tsconfig.json ./'), 'should copy real build config files');
    assert.ok(df.includes('COPY src/ ./src/'), 'should copy real src/');
    assert.ok(df.includes('COPY public/ ./public/'), 'should copy real public/');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('static SPA (CRA) keeps build flags in the default Dockerfile users receive', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockerforge-cra-'));
  try {
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}\n');
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'test-cra-app',
      version: '1.0.0',
      scripts: {
        build: 'react-scripts build',
      },
      dependencies: {
        '@testing-library/jest-dom': '^6.4.0',
        react: '^18.2.0',
        'react-dom': '^18.2.0',
        'react-scripts': '^5.0.1',
      },
    }, null, 2));

    const projectPath = await core.ingestLocal(dir);
    const result = await core.runDockerfileEngine({ projectPath });

    assert.ok(
      /RUN .*DISABLE_ESLINT_PLUGIN=true npm run build/.test(result.dockerfile),
      'default Dockerfile should keep CRA build flags instead of requiring powerDockerfile'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
