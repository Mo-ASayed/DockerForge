'use strict';

// Golden + example-parity tests.
//
// These lock the generator against realistic project layouts that mirror the curated example
// library in `Apps/dockerfile-builder/docs/dockerfile-examples`. Two things are checked per
// fixture:
//   1. SNAPSHOT  — the generated Dockerfile must match the stored golden byte-for-byte. Any drift
//                  fails the test. Regenerate intentionally with DOCKERFORGE_UPDATE_GOLDENS=1.
//   2. PARITY    — "works first time" invariants drawn from the example baseline: pinned base
//                  images (never :latest), explicit COPYs (never `COPY . .`), a non-root final
//                  USER, lockfile-first installs, and the correct entrypoint for the stack.
//
// Run host-side: `node --test test/golden.test.js` from packages/core.
// (The sandbox mount can serve truncated reads of the large engine files; run on the host.)

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const core = require('../src/index.js');

const FIXTURE_DIR = path.join(__dirname, 'golden-fixtures');
const SNAPSHOT_DIR = path.join(__dirname, 'golden-snapshots');
const UPDATE = process.env.DOCKERFORGE_UPDATE_GOLDENS === '1';

async function generate(fixture) {
  const projectPath = await core.ingestLocal(path.join(FIXTURE_DIR, fixture));
  const result = await core.runDockerfileEngine({ projectPath });
  return result;
}

// ── Invariants that every production Dockerfile in the example library satisfies ──────────────
function assertUniversalInvariants(df, label) {
  // Explicit copies only — `COPY . .` drags secrets, .git and node_modules into the image.
  assert.ok(!/^COPY\s+\.\s+\.\/?\s*$/m.test(df), `${label}: must not use COPY . .`);

  // Every FROM is pinned: either references an earlier stage, or carries an explicit tag/digest.
  // Never an implicit :latest.
  const froms = df.split('\n').filter(l => /^FROM\s/i.test(l));
  assert.ok(froms.length > 0, `${label}: has at least one FROM`);
  const stageAliases = new Set(
    froms.map(l => (l.match(/\bAS\s+(\S+)/i) || [])[1]).filter(Boolean)
  );
  for (const line of froms) {
    const ref = line.replace(/^FROM\s+/i, '').replace(/--platform=\S+\s+/i, '').split(/\s+/)[0];
    if (stageAliases.has(ref)) continue; // FROM <previous-stage>
    assert.ok(!/:latest$/.test(ref), `${label}: base image must not be :latest (${ref})`);
    assert.ok(/[@:]/.test(ref), `${label}: base image must be pinned with a tag or digest (${ref})`);
  }

  // A non-root user must be selected before the process starts.
  assert.ok(/^USER\s+(?!root\b)\S+/m.test(df), `${label}: must switch to a non-root USER`);
}

const CASES = {
  'express-api': (df, r) => {
    assert.equal(r.analysis.services[0].stack, 'node');
    assert.ok(/RUN npm ci --omit=dev/.test(df), 'express: production-only install');
    assert.ok(/COPY src\/ \.\/src\//.test(df), 'express: copies the src/ directory');
    // The redundant, mis-located `COPY src/server.js ./` must NOT be emitted alongside src/.
    assert.ok(!/COPY src\/server\.js \.\/\s*$/m.test(df), 'express: no redundant entry-file copy');
    assert.ok(/CMD \["node","src\/server\.js"\]/.test(df), 'express: runs the entry file from src/');
  },
  'typescript-api': (df, r) => {
    assert.equal(r.analysis.services[0].stack, 'node');
    assert.ok(/AS builder/.test(df), 'ts: multi-stage build');
    assert.ok(/RUN npm run build/.test(df), 'ts: compiles via the build script');
    assert.ok(/COPY tsconfig\.json \.\//.test(df), 'ts: copies tsconfig for the compiler');
    assert.ok(/COPY --from=builder \/app\/dist \.\/dist/.test(df), 'ts: ships compiled dist/');
    assert.ok(/CMD \["node","dist\/server\.js"\]/.test(df), 'ts: runs the compiled entry');
  },
  'fastapi-pip': (df, r) => {
    assert.equal(r.analysis.services[0].stack, 'python');
    // The fix: the app package must be copied, not a non-existent root main.py.
    assert.ok(/COPY app\/ \.\/app\//.test(df), 'fastapi: copies the app/ package');
    assert.ok(!/COPY main\.py \.\//.test(df), 'fastapi: does not copy a phantom root main.py');
    assert.ok(/uvicorn","app\.main:app/.test(df), 'fastapi: uvicorn targets app.main:app');
    assert.ok(/COPY --from=builder \/opt\/venv \/opt\/venv/.test(df), 'fastapi: ships the venv from the builder');
  },
  'django-gunicorn': (df, r) => {
    assert.equal(r.analysis.services[0].stack, 'python');
    assert.ok(/COPY manage\.py \.\//.test(df), 'django: copies manage.py');
    assert.ok(/COPY config\/ \.\/config\//.test(df), 'django: copies the config package');
    assert.ok(/COPY apps\/ \.\/apps\//.test(df), 'django: copies the apps package');
    assert.ok(/gunicorn","config\.wsgi:application/.test(df), 'django: gunicorn targets the wsgi app');
  },
  'go-http-api': (df, r) => {
    assert.equal(r.analysis.services[0].stack, 'go');
    assert.ok(/CGO_ENABLED=0 go build/.test(df), 'go: static binary');
    assert.ok(/go build .*\.\/cmd\/api/.test(df), 'go: builds the ./cmd/api package');
    assert.ok(/COPY cmd\/ \.\/cmd\//.test(df), 'go: copies cmd/');
    assert.ok(/COPY internal\/ \.\/internal\//.test(df), 'go: copies internal/');
    assert.ok(/ENTRYPOINT \["\/usr\/local\/bin\/api"\]/.test(df), 'go: entrypoint is the binary');
  },
  'rust-axum': (df, r) => {
    assert.equal(r.analysis.services[0].stack, 'rust');
    assert.ok(/cargo build --release --locked --bin axum-api/.test(df), 'rust: locked release build');
    assert.ok(/COPY Cargo\.toml Cargo\.lock \.\//.test(df), 'rust: copies manifest + lockfile');
    assert.ok(/ENTRYPOINT \["\/usr\/local\/bin\/axum-api"\]/.test(df), 'rust: entrypoint is the binary');
  },
  'dotnet-aspnet': (df, r) => {
    assert.equal(r.analysis.services[0].stack, 'dotnet');
    assert.ok(/AS builder/.test(df), 'dotnet: multi-stage build');
    assert.ok(/FROM .*dotnet\/sdk:/.test(df), 'dotnet: builds on the SDK image');
    assert.ok(/dotnet restore/.test(df), 'dotnet: restores packages');
    // Restore the csproj before copying the rest of the source (layer caching).
    assert.ok(df.indexOf('dotnet restore') < df.indexOf('COPY src/ ./src/'), 'dotnet: restore precedes full source copy');
    assert.ok(/FROM .*dotnet\/aspnet:/.test(df), 'dotnet: ships on the ASP.NET runtime image');
    assert.ok(/ENTRYPOINT \["dotnet", "MyApi\.dll"\]/.test(df), 'dotnet: entrypoint runs the published dll');
  },
};

for (const fixture of Object.keys(CASES)) {
  test(`golden + parity: ${fixture}`, async () => {
    const result = await generate(fixture);
    const df = result.dockerfile;

    assertUniversalInvariants(df, fixture);
    CASES[fixture](df, result);

    const snapPath = path.join(SNAPSHOT_DIR, `${fixture}.Dockerfile`);
    if (UPDATE) {
      fs.writeFileSync(snapPath, df + '\n');
      return;
    }
    const expected = fs.readFileSync(snapPath, 'utf-8').replace(/\n$/, '');
    assert.equal(df, expected, `${fixture}: generated Dockerfile drifted from golden snapshot ` +
      `(run with DOCKERFORGE_UPDATE_GOLDENS=1 to update intentionally)`);
  });
}
