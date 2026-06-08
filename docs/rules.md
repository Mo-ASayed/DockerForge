# Lint rules

DockerForge ships six rules. They are deterministic and chosen to have a low false-positive rate,
so they are safe to run in CI with `--fail-on`.

| Id | Check | Severity |
| --- | --- | --- |
| [DF001](#df001) | Base image is not pinned | high |
| [DF002](#df002) | Final stage runs as root | high |
| [DF003](#df003) | `COPY . .` copies the whole build context | high |
| [DF004](#df004) | `.dockerignore` is missing or does not exclude `.env` | medium |
| [DF005](#df005) | A secret-like value is hardcoded in `ENV` or `ARG` | critical |
| [DF006](#df006) | No `WORKDIR` in the final stage | low |

Run a subset with `--rules`, for example `dockerforge lint . --rules DF001,DF005`.

## DF001

**Base image is not pinned.** Severity: high.

A `FROM` line with no tag, or with `:latest`, means the image you build today and the image you
build next month can be different. That makes builds unreproducible and pulls in unreviewed
changes.

```dockerfile
# flagged
FROM node

# better
FROM node:20-alpine

# best: pin the digest
FROM node:20-alpine@sha256:...
```

## DF002

**Final stage runs as root.** Severity: high.

If the final stage has no non-root `USER`, the container runs as root. A process that is
compromised then has root inside the container, which widens the blast radius.

```dockerfile
# flagged: no USER, or USER root
FROM node:20-alpine
CMD ["node","x.js"]

# better
FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
USER app
CMD ["node","x.js"]
```

## DF003

**`COPY . .` copies the whole build context.** Severity: high.

Copying the entire context pulls in whatever happens to be in the directory, including `.env`
files, `.git`, and local secrets. Copy only what the image needs.

```dockerfile
# flagged
COPY . .

# better
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
```

A good `.dockerignore` reduces the risk, but an explicit copy list is clearer about intent.

## DF004

**`.dockerignore` is missing or does not exclude `.env`.** Severity: medium.

Without a `.dockerignore`, `docker build` sends the whole directory to the daemon and `COPY`
instructions can pick up files you did not intend to ship, including `.env`.

```text
# .dockerignore
.env
.env.*
node_modules
.git
```

## DF005

**A secret-like value is hardcoded in `ENV` or `ARG`.** Severity: critical.

A value that looks like a token, key, or password baked into `ENV` is readable by anyone who pulls
the image. A value in `ARG` is recorded in the image build history. Pass secrets at run time
instead, or use build secrets.

```dockerfile
# flagged
ENV API_TOKEN=sk_live_abc123
ARG DB_PASSWORD=hunter2

# better: provide at run time
# docker run -e API_TOKEN=... my-app
```

## DF006

**No `WORKDIR` in the final stage.** Severity: low.

Without a `WORKDIR`, relative paths and the default working directory resolve to `/`, which is
easy to get wrong and clutters the root filesystem.

```dockerfile
# better
WORKDIR /app
COPY . .
CMD ["node","index.js"]
```
