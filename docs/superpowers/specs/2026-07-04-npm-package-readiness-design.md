# DockerForge NPM Package Readiness Design

## Goal

Make DockerForge publishable as a dependable npm package that users can install, run immediately, and trust as a CLI and programmatic library.

## Current Context

DockerForge is an npm workspace with three package surfaces:

- `@dockerforge/core`: the offline engine and programmatic API.
- `@dockerforge/cli`: the command-line package that exposes the `dockerforge` binary.
- `dockerforge`: an unscoped wrapper package that depends on `@dockerforge/cli` and exposes the same binary.

The scoped packages already exist on npm at `0.1.3`. The unscoped `dockerforge` registry lookup currently returns an npm 404 with an unpublished-package note, so it should not be the canonical install path until publish rights are proven.

The local package is already in strong shape:

- `npm test` passes 49 tests.
- `npm pack --dry-run --json` produces small, intentional tarballs for root, CLI, and core.
- Fresh tarball installation works for `@dockerforge/cli`, `@dockerforge/core`, and the local root wrapper.
- `npm audit --audit-level=moderate` reports no vulnerabilities.
- GitHub has no open issues or pull requests for the repository.

The main release-readiness gaps are first-install polish, repeatable verification, workflow automation, and documentation accuracy.

## Recommended Approach

Use a scoped-first package strategy.

`@dockerforge/cli` is the canonical install package:

```bash
npm install -g @dockerforge/cli
dockerforge generate .
```

`@dockerforge/core` remains the documented Node API package:

```bash
npm install @dockerforge/core
```

The root `dockerforge` package remains an optional convenience alias only after npm publish access for that package name is confirmed. README and release docs must not depend on the unscoped name as the primary user path.

## Package Metadata Design

Each published package should have npm metadata that supports discovery, support, and predictable installation:

- `name` and `version` stay synchronized across the release.
- `description`, `keywords`, `license`, `repository`, `bugs`, `homepage`, and `engines` are present.
- `publishConfig.access` is `public` for scoped packages.
- `files` stays restrictive so tarballs contain only runtime files, README, license, and notices.
- `bin` is present only for packages that install the CLI command.
- `exports` is added where it protects the intended public surface without breaking CommonJS consumers.

The CLI package should continue to expose `dockerforge` from `src/index.js`. The core package should expose only the package root for programmatic consumers.

## Dependency Design

Dependencies should optimize for quiet installs and Node 18 compatibility.

The current install smoke test emits a deprecation warning for `glob@10.5.0`. Update runtime dependencies to the newest compatible patch or major version that still supports Node 18 and CommonJS consumption:

- Update `glob` to a non-deprecated Node 18-compatible version.
- Update `adm-zip` and `fs-extra` to current patch releases.
- Keep `commander` on the newest version compatible with the package engine. Do not move to a Commander major that requires Node 22 unless DockerForge also intentionally raises its engine requirement.

After dependency updates, regenerate `package-lock.json` with npm and verify the tarball install no longer emits dependency deprecation warnings.

## Verification Design

Add a single release verification command that proves the package users receive works from tarballs, not only from the workspace.

The verification command should:

1. Run the full test suite.
2. Run `npm audit --audit-level=moderate`.
3. Run `npm pack --dry-run --json` for the root package, CLI, and core.
4. Build real tarballs into a temporary directory.
5. Install `@dockerforge/core` and `@dockerforge/cli` tarballs into a fresh temporary consumer project.
6. Run `npx dockerforge --version`.
7. Run `npx dockerforge generate <fixture> --json` and assert that JSON includes a Dockerfile.
8. Install the root wrapper tarball into a separate temporary consumer project when the root package remains publishable.
9. Run `npx dockerforge --version` from that root-wrapper consumer.

The implementation can be a small Node script under `scripts/` so it works cross-platform and does not depend on shell-specific behavior.

## CI And Release Design

Add GitHub Actions workflows for repeatable confidence:

- CI workflow on pull requests and pushes to `main`.
- Node matrix covering currently supported Node versions, at minimum Node 18 and the latest LTS.
- Steps: `npm ci`, `npm run verify`.

Add a release workflow prepared for npm trusted publishing and provenance:

- Manual `workflow_dispatch` trigger.
- Run the same verification command before publishing.
- Publish `@dockerforge/core` first, then `@dockerforge/cli`.
- Publish the root `dockerforge` package only when an explicit workflow input enables it.
- Keep publish commands compatible with npm `publishConfig.access`.

Trusted publishing setup on npmjs.com is an external step, but the workflow should be ready for it. Until trusted publishing is configured, the release workflow can remain documented or manual-only.

## Documentation Design

Docs should match what actually works:

- Root README leads with `npx @dockerforge/cli generate ./my-app` and global install via `npm install -g @dockerforge/cli`.
- Package READMEs document package-specific installation and usage.
- CLI docs accurately describe human, JSON, and SARIF output.
- Error docs should not claim JSON-formatted errors unless the CLI actually implements them.
- Add release documentation with exact commands, publish order, verification gates, and the rule that the unscoped `dockerforge` package is optional.

## Testing Design

Use test-first changes for behavior that affects users:

- Add or update tests around package metadata expectations.
- Add a smoke-verification test or script assertion that catches broken tarball installs.
- Add CLI tests only when CLI behavior changes.

Configuration-only workflow files and README edits do not need failing tests, but they must be covered by `npm run verify` and dry-run pack inspection.

## Non-Goals

This package-readiness pass will not add new Docker stack generation features, change the engine architecture, collapse packages, or publish to npm from this environment. Actual npm publishing remains a human-controlled release action after verification.

## Acceptance Criteria

- `npm run verify` passes locally.
- `npm test` passes.
- `npm audit --audit-level=moderate` reports no vulnerabilities.
- `npm pack --dry-run --json` for all publishable packages shows intentional contents only.
- A fresh consumer install from generated tarballs can run `dockerforge --version` and `dockerforge generate --json`.
- First install no longer emits avoidable runtime dependency deprecation warnings.
- Docs identify `@dockerforge/cli` as the canonical install package.
- Release docs explain trusted publishing/provenance readiness and publish order.
