# DockerForge CLI Generation Design

## Goal

Make DockerForge behave like a customer-ready npm CLI: `generate` writes files by default, `--print` is explicit, `npx dockerforge` and `npx @dockerforge/cli` both resolve to the same command, and generated Dockerfiles copy the real project files needed to build.

## Design

The scoped package `@dockerforge/cli` remains the canonical implementation. The root `dockerforge` package becomes a small public npm package with a `dockerforge` bin that requires the scoped CLI package. This follows npm naming expectations while preserving the scoped packages for direct installs and programmatic use.

Generation keeps its current default behavior: write `Dockerfile`, `.dockerignore`, and `docker-compose.yml` into the target project unless `--output`, `--json`, or `--print` is used. Tests cover local CLI invocation and package metadata so a stale publish cannot silently ship a CLI that only prints.

Node Dockerfile source copying should be detection-based. The analyser records existing build config files and source/static directories. The generator emits `COPY` lines only for paths that exist, including `tsconfig*.json`, framework configs, `src/`, and real asset dirs such as `public/`. It must not emit guessed `COPY public/` or `COPY src/` lines for build flows when those paths are absent.

Go and Rust remain compiled single-binary stacks: detect module/crate metadata, build in a toolchain image, ship only the binary in a small non-root runtime, and keep `.dockerignore` focused on generated/build artifacts.

## Verification

Use Node's built-in test runner for package metadata, CLI writing, Node template copy behavior, Next.js behavior, static SPA behavior, and Go/Rust generation. Also run a local CLI smoke command against a fixture with `--output` to confirm files are created.
