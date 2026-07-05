# Release

DockerForge publishes two canonical npm packages:

- `@dockerforge/core` - the programmatic engine.
- `@dockerforge/cli` - the CLI package that installs the `dockerforge` command.

The root `dockerforge` package is an optional convenience alias. Publish it only after confirming
the npm account has publish rights for the unscoped `dockerforge` name.

## Local Gate

Run the full release gate before publishing:

```bash
npm ci
npm run verify
```

`npm run verify` runs the test suite, npm audit, dry-run pack inspection, and a fresh tarball
install smoke test. The smoke test installs the packed CLI and core into a new project and runs:

```bash
npx dockerforge --version
npx dockerforge generate <fixture> --json
```

## Publish Order

Publish core first because the CLI depends on the exact matching core version:

```bash
npm publish -w @dockerforge/core
npm publish -w @dockerforge/cli
```

If the unscoped alias package is confirmed publishable, publish it after the scoped packages:

```bash
npm publish
```

Do not publish from a dirty worktree unless the uncommitted changes are intentionally part of the
release candidate and have passed `npm run verify`.

## Trusted Publishing

The release workflow is prepared for npm trusted publishing with provenance. Configure trusted
publishing for each npm package on npmjs.com before using the workflow to publish:

- `@dockerforge/core`
- `@dockerforge/cli`
- `dockerforge`, only if the optional alias is used

The workflow uses GitHub Actions OIDC and `npm publish --provenance`, so no long-lived npm publish
token should be required after the npm package settings are configured.

## Staged Publishing

For an extra human approval step on packages that already exist on npm, use staged publishing:

```bash
npm stage publish -w @dockerforge/core
npm stage publish -w @dockerforge/cli
```

Review the staged packages on npmjs.com or with `npm stage list`, then approve them with 2FA.
