# DockerForge CLI Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship customer-ready DockerForge npm generation behavior across package metadata, CLI output, Node file copying, and Go/Rust stack coverage.

**Architecture:** Keep `@dockerforge/cli` as the implementation package and expose root `dockerforge` as an npm alias package that points to the same bin. Keep generation write behavior in CLI code and fix generator correctness by using analyser-detected files and directories instead of guessed COPY paths.

**Tech Stack:** Node.js CommonJS, commander, npm workspaces, Node built-in test runner.

---

### Task 1: Package And CLI Metadata

**Files:**
- Modify: `package.json`
- Modify: `packages/cli/package.json`
- Modify: `package-lock.json`
- Test: `packages/cli/test/cli.test.js`

- [x] Add failing tests that assert the root package is publishable, has a `dockerforge` bin, and `@dockerforge/cli` depends on the matching local core version.
- [x] Run `node --test packages/cli/test/cli.test.js` and confirm the metadata tests fail.
- [x] Update package metadata so both `npx dockerforge` and `npx @dockerforge/cli` expose the CLI and package versions/dependencies are aligned.
- [x] Run `npm install --package-lock-only` to refresh the lockfile.
- [x] Re-run `node --test packages/cli/test/cli.test.js` and confirm it passes.

### Task 2: Node COPY Detection

**Files:**
- Modify: `packages/core/src/engine/analysis/analyser.js`
- Modify: `packages/core/src/engine/generation/generator.js`
- Test: `packages/core/test/static-spa.test.js`
- Test: `packages/core/test/nextjs.test.js`

- [x] Add failing tests for a Vite app without `src/` or `public/` so the Dockerfile does not copy nonexistent dirs but still copies `vite.config.js`.
- [x] Add failing tests for a Vite/CRA-style app with `src/`, `public/`, and `tsconfig.json` so those real build inputs are copied.
- [x] Run the focused static SPA and Next.js tests and confirm the new tests fail before implementation.
- [x] Update analyser/generator helpers to produce build COPY blocks from detected files/dirs.
- [x] Re-run focused tests and confirm they pass.

### Task 3: Go And Rust Verification

**Files:**
- Modify as needed: `packages/core/src/engine/constants.js`
- Modify as needed: `packages/core/src/engine/analysis/analyser.js`
- Modify as needed: `packages/core/src/engine/generation/generator.js`
- Test: `packages/core/test/go-rust.test.js`

- [x] Run `node --test packages/core/test/go-rust.test.js` to verify the existing Go/Rust work.
- [x] Fix only failures directly related to Go/Rust generation.
- [x] Re-run the Go/Rust focused test file.

### Task 4: Full Verification

**Files:**
- All touched package, CLI, docs, and test files.

- [x] Run `npm test`.
- [x] Run a local `generate --output` smoke command against a fixture and list the created files.
- [x] Run `npm pack --dry-run --workspace @dockerforge/cli`, `npm pack --dry-run --workspace @dockerforge/core`, and root `npm pack --dry-run` to inspect publish contents.
- [x] Report exact verification results and any remaining risks.
