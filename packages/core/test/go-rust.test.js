'use strict';

// Regression tests for the Go and Rust stacks (Phase 2 — compiled single-binary languages).
// Both build on a toolchain image and ship the binary on a tiny runtime, non-root, multi-stage.
//
// Run host-side: `node --test test/go-rust.test.js` from packages/core.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/index.js');
const GO_FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'go-mod');
const RUST_FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'rust-cargo');

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-compiled-roots-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

test('Go module is detected and built as a static binary on a tiny runtime', async () => {
  const projectPath = await core.ingestLocal(GO_FIXTURE);
  const result = await core.runDockerfileEngine({ projectPath });
  const df = result.dockerfile;

  assert.equal(result.analysis.services[0].stack, 'go', 'should detect the go stack');
  assert.ok(/FROM golang:1\.23-alpine.* AS build/.test(df), 'builds on the Go toolchain image');
  assert.ok(df.includes('go mod download'), 'downloads modules in a cached layer');
  assert.ok(df.includes('CGO_ENABLED=0 go build'), 'builds a static binary with CGO disabled');
  assert.ok(df.includes('COPY main.go ./') || df.includes('COPY *.go ./'), 'copies the root Go sources explicitly (no COPY . .)');
  assert.ok(!/\nCOPY \. \.\n/.test(df), 'must not use COPY . .');
  assert.ok(/FROM alpine:3\.21/.test(df), 'ships on a tiny alpine runtime');
  assert.ok(df.includes('COPY --from=build /out/greeter /usr/local/bin/greeter'), 'copies just the binary (named from the module)');
  assert.ok(df.includes('USER appuser'), 'runs as non-root');
  assert.ok(df.includes('ENTRYPOINT ["/usr/local/bin/greeter"]'), 'entrypoint is the binary');
});

test('Rust crate is detected and built as a release binary on debian-slim', async () => {
  const projectPath = await core.ingestLocal(RUST_FIXTURE);
  const result = await core.runDockerfileEngine({ projectPath });
  const df = result.dockerfile;

  assert.equal(result.analysis.services[0].stack, 'rust', 'should detect the rust stack');
  assert.ok(/FROM rust:1\.83-slim-bookworm AS build/.test(df), 'builds on the Rust toolchain image');
  assert.ok(df.includes('COPY Cargo.toml Cargo.lock ./'), 'copies the manifest + lockfile');
  assert.ok(df.includes('COPY src/ src/'), 'copies src/ explicitly (no COPY . .)');
  assert.ok(df.includes('cargo build --release --locked --bin greeter'), 'builds the release binary with the lockfile');
  assert.ok(/FROM debian:bookworm-slim/.test(df), 'ships on debian-slim (glibc runtime)');
  assert.ok(df.includes('COPY --from=build /out-greeter /usr/local/bin/greeter'), 'copies just the binary');
  assert.ok(df.includes('USER appuser'), 'runs as non-root');
  assert.ok(df.includes('ENTRYPOINT ["/usr/local/bin/greeter"]'), 'entrypoint is the binary');
});

test('Go and Rust Dockerfiles pin base images and add a non-root user (no security warnings)', async () => {
  for (const fixture of [GO_FIXTURE, RUST_FIXTURE]) {
    const projectPath = await core.ingestLocal(fixture);
    const result = await core.runDockerfileEngine({ projectPath });
    assert.ok(!/:latest/.test(result.dockerfile), `${fixture}: no :latest tag`);
    assert.ok(result.dockerfile.includes('USER '), `${fixture}: has a USER instruction`);
  }
});

test('Go root app is not displaced by a nested auxiliary module', async () => {
  const dir = tmpProject({
    'go.mod': 'module github.com/acme/api\n\ngo 1.23\n',
    'go.sum': '',
    'main.go': 'package main\nfunc main(){}\n',
    'tools/go.mod': 'module github.com/acme/api/tools\n\ngo 1.23\n',
    'tools/doc.go': 'package tools\n',
  });

  const projectPath = await core.ingestLocal(dir);
  const result = await core.runDockerfileEngine({ projectPath });
  const service = result.analysis.services[0];

  assert.equal(result.analysis.services.length, 1);
  assert.equal(service.stack, 'go');
  assert.equal(service.serviceDir, '.', 'the runnable root app should remain the service');
  assert.ok(result.dockerfile.includes('COPY go.mod go.sum ./'), 'uses the root module files');
  assert.ok(!result.dockerfile.includes('COPY tools/go.mod'), 'does not build the auxiliary tools module');
  assert.ok(result.dockerfile.includes('ENTRYPOINT ["/usr/local/bin/api"]'), 'runs the root module binary');
});

test('Rust root app is not displaced by a nested auxiliary crate', async () => {
  const dir = tmpProject({
    'Cargo.toml': '[package]\nname = "api"\nversion = "0.1.0"\nedition = "2021"\nrust-version = "1.83"\n',
    'Cargo.lock': 'version = 3\n',
    'src/main.rs': 'fn main(){}\n',
    'xtask/Cargo.toml': '[package]\nname = "xtask"\nversion = "0.1.0"\nedition = "2021"\n',
    'xtask/src/lib.rs': 'pub fn run() {}\n',
  });

  const projectPath = await core.ingestLocal(dir);
  const result = await core.runDockerfileEngine({ projectPath });
  const service = result.analysis.services[0];

  assert.equal(result.analysis.services.length, 1);
  assert.equal(service.stack, 'rust');
  assert.equal(service.serviceDir, '.', 'the runnable root crate should remain the service');
  assert.ok(result.dockerfile.includes('COPY Cargo.toml Cargo.lock ./'), 'uses the root crate manifest');
  assert.ok(!result.dockerfile.includes('COPY xtask/Cargo.toml'), 'does not build the auxiliary xtask crate');
  assert.ok(result.dockerfile.includes('ENTRYPOINT ["/usr/local/bin/api"]'), 'runs the root crate binary');
});
