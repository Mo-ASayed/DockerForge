# Opt-In Base Image Digest Pinning Design

## Goal

Add an explicit DockerForge CLI option that resolves generated base-image tags to immutable
`@sha256:` digests and writes digest-pinned `FROM` lines.

## Background

DockerForge currently generates pinned image tags such as:

```dockerfile
FROM node:20-alpine3.21
```

That is reproducible enough to avoid implicit `latest`, but tags are still mutable. A registry can
move a tag to a new manifest over time. Digest pinning makes the generated Dockerfile resolve the
exact same image manifest every time:

```dockerfile
FROM node:20-alpine3.21@sha256:<digest>
```

Docker's registry API supports resolving a manifest reference and reading the
`Docker-Content-Digest` header from the manifest response. Docker's image digest documentation
describes digests as immutable SHA-256 identifiers.

## Product Behavior

Digest resolution is opt-in:

```bash
dockerforge generate . --pin-digests
```

The default command remains offline:

```bash
dockerforge generate .
```

This preserves DockerForge's existing no-network contract for default use while giving production
users a stronger supply-chain option.

## Supported Registries

Initial support covers public images hosted on Docker Hub, including official library images:

- `node:20-alpine3.21` resolves as `library/node:20-alpine3.21`.
- `python:3.12-slim` resolves as `library/python:3.12-slim`.
- `golang:1.23-alpine` resolves as `library/golang:1.23-alpine`.

The resolver should be isolated behind a small interface so future work can add private registry
credentials or non-Docker-Hub registries without changing generator templates.

## CLI Design

Add a generate flag:

```text
--pin-digests
```

When enabled, the CLI passes `pinDigests: true` into the core engine. The CLI description should
make the network behavior clear:

```text
--pin-digests  Resolve Docker Hub base-image tags to immutable sha256 digests (network)
```

The flag applies to `--print`, `--json`, and file-writing modes.

## Core Engine Design

The core engine should accept:

```js
runDockerfileEngine({
  projectPath,
  pinDigests: true
})
```

The engine flow becomes:

1. Analyse the project.
2. Generate the Dockerfile normally.
3. If `pinDigests` is enabled, resolve all external `FROM` image references in the generated
   Dockerfile that are tag-pinned but not already digest-pinned.
4. Rewrite each matching `FROM` image as `<image>:<tag>@sha256:<digest>`.
5. Add a warning/improvement entry that digest resolution used live registry data.

The rewrite should preserve:

- `FROM --platform=$BUILDPLATFORM ... AS builder`.
- stage aliases.
- `FROM <stage-name>` internal stage references.
- already digest-pinned references.

## Resolver Design

Create a focused Docker Hub resolver module with no external dependency:

```js
async function resolveDockerHubDigest(imageRef, options = {}) {
  return {
    original: 'node:20-alpine3.21',
    pinned: 'node:20-alpine3.21@sha256:...',
    digest: 'sha256:...',
  };
}
```

Resolution steps:

1. Parse image reference into registry, repository, and tag.
2. Only handle Docker Hub references in the first implementation.
3. Request an anonymous bearer token from Docker Hub:

   ```text
   https://auth.docker.io/token?service=registry.docker.io&scope=repository:<repo>:pull
   ```

4. Request the manifest with `GET` or `HEAD`:

   ```text
   https://registry-1.docker.io/v2/<repo>/manifests/<tag>
   ```

5. Send Accept headers for OCI indexes, Docker manifest lists, OCI manifests, and Docker v2
   manifests.
6. Prefer the `Docker-Content-Digest` response header.
7. If the digest header is missing, compute the SHA-256 digest of the returned manifest body.

The resolver should use Node's built-in `fetch` and `crypto` APIs, keeping the package dependency
footprint unchanged.

## Error Handling

If `--pin-digests` is enabled and resolution fails, generation should fail with a clear message.
Failing closed is better than silently producing unpinned output after the user explicitly asked for
digest pinning.

Examples:

- Unsupported registry:
  `Digest pinning currently supports Docker Hub images only: ghcr.io/acme/app:1.0`
- Missing tag:
  `Cannot digest-pin an image without an explicit tag: node`
- Registry failure:
  `Failed to resolve digest for node:20-alpine3.21: <registry status/message>`

Default offline generation is unaffected.

## Testing

Use test-first implementation:

- Unit-test image reference parsing and `FROM` line rewriting.
- Unit-test Docker Hub token/manifest resolution with mocked `fetch`.
- Add a CLI test proving `--pin-digests` passes through and produces digest-pinned output using a
  mocked resolver path.
- Add a regression test proving default `generate` still does not resolve digests or require
  network access.

Tests must not depend on live Docker Hub network calls.

## Documentation

Update:

- Root README.
- CLI README.
- `docs/cli.md`.

Docs should show:

```bash
dockerforge generate . --pin-digests
```

And explain that:

- default generation is offline;
- digest pinning makes a live registry request;
- digest-pinned images do not automatically receive base-image patches;
- users should use Docker Scout, Renovate, Dependabot, or another update process to refresh
  digests.

## Non-Goals

This pass will not:

- add private registry authentication;
- support all registry hosts;
- run Docker locally;
- update digest-pinned Dockerfiles automatically after generation;
- change the default offline generation behavior.

## Acceptance Criteria

- `dockerforge generate .` remains offline and outputs tag-pinned base images.
- `dockerforge generate . --pin-digests` outputs digest-pinned Docker Hub base images.
- Already digest-pinned `FROM` references are not changed.
- Internal stage references are not changed.
- Network or registry failures produce clear errors when `--pin-digests` is used.
- `npm test` and `npm run verify` pass.
