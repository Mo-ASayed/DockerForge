// Part of the @dockerforge/core engine.
// Accepts { services, sharedDirs } from the analyser.
// Produces one Dockerfile (multi-stage if needed) + .dockerignore.

const path = require('path');
const { STACKS, BASE_IMAGES } = require('../constants');
const { isSecretLikeEnvKey, isSecretLikeEnvValue } = require('../security/security');

const STATIC_RUNTIME_IMAGE = 'nginx:1.27-alpine';
const PNPM_VERSION = '9';

function installPnpmGlobalCmd() {
  return `npm install -g pnpm@${PNPM_VERSION}`;
}

function dockerCmdArray(cmd, fallback = []) {
  if (Array.isArray(cmd)) return cmd;
  if (typeof cmd === 'string' && cmd.trim()) return cmd.trim().split(/\s+/);
  return fallback;
}

function runtimeStartCmd(a) {
  const cmd = dockerCmdArray(a.startCmd, ['node', a.entryPoint]);
  if (!a.hasBuild || !Array.isArray(cmd) || cmd[0] !== 'node' || !cmd[1]) return cmd;

  const buildOut = a.buildOutputDir || 'dist';
  const entry = cmd[1].replace(/\\/g, '/');
  if (entry.startsWith(`${buildOut}/`) || entry.startsWith('./' + buildOut + '/')) {
    return cmd;
  }

  return ['node', `${buildOut}/${entry.replace(/^\.\//, '')}`];
}

function nginxStaticServerBlock(port) {
  return 'COPY nginx.conf /etc/nginx/conf.d/default.conf';
}

function nginxConf(port) {
  return `server {
    listen ${port};
    root /usr/share/nginx/html;
    index index.html;

    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header Referrer-Policy "strict-origin-when-cross-origin";

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /health { return 200 "ok"; add_header Content-Type text/plain; }
    location / { try_files $uri $uri/ /index.html; }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript
               text/xml application/xml image/svg+xml font/woff2 application/manifest+json;
}`.trim();
}

function nginxNonRootPrepBlock() {
  return [
    'RUN mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp /var/cache/nginx/scgi_temp',
    'RUN touch /var/run/nginx.pid && chown -R nginx:nginx /var/cache/nginx /var/run/nginx.pid /var/log/nginx /etc/nginx/conf.d /usr/share/nginx/html',
  ].join('\n');
}

function simpleHttpHealthcheck(port) {
  return `HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -qO- http://localhost:${port}/health || exit 1`;
}

function addDockerfileHeader(dockerfile) {
  const text = normalizeDockerfileText(dockerfile).trim();
  if (text.startsWith('# syntax=docker/dockerfile:1')) return text;
  // Prepend the BuildKit syntax directive — required for --mount=type=cache to work.
  return ['# syntax=docker/dockerfile:1', text].join('\n');
}

/**
 * Power-mode header: adds CI/CD stamping args and OCI image labels.
 * Injected into powerDockerfile only — not the default output.
 */
function addPowerDockerfileHeader(dockerfile) {
  const text = normalizeDockerfileText(dockerfile).trim();
  if (text.startsWith('# syntax=docker/dockerfile:1')) {
    // Already has a simple header; replace it with the full power header.
    const withoutSyntax = text.replace(/^# syntax=docker\/dockerfile:1\n/, '');
    return buildPowerHeader(withoutSyntax);
  }
  return buildPowerHeader(text);
}

function buildPowerHeader(text) {
  const lines = text.split('\n');
  const isMultiPlatform = text.includes('--platform=$BUILDPLATFORM');

  const header = [
    '# syntax=docker/dockerfile:1',
    '# Enables layer caching when using a registry cache (--cache-from in CI).',
    'ARG BUILDKIT_INLINE_CACHE=1',
    '# Pass --build-arg GIT_SHA=$(git rev-parse HEAD) in CI to stamp the image.',
    'ARG GIT_SHA=unknown',
    '# Pass --build-arg VERSION=$TAG in CI to record the release version.',
    'ARG VERSION=unknown',
  ];
  if (isMultiPlatform) header.splice(1, 0, 'ARG TARGETPLATFORM', 'ARG BUILDPLATFORM');

  const firstFromIndex = lines.findIndex(line => line.trim().startsWith('FROM '));
  if (firstFromIndex === -1) return [...header, text].join('\n');

  const lastFromIndex = lines.reduce((last, line, index) => (
    line.trim().startsWith('FROM ') ? index : last
  ), firstFromIndex);

  // Re-declare ARGs after the final FROM so they're in scope for LABEL.
  // ARGs before FROM are only visible to FROM itself in Docker's build model.
  const stageMetadata = [
    'ARG GIT_SHA',
    'ARG VERSION',
    '# Image stamped at build time by CI via --build-arg.',
    'LABEL org.opencontainers.image.revision="${GIT_SHA}" \\',
    '      org.opencontainers.image.version="${VERSION}"',
  ];
  if (isMultiPlatform) stageMetadata.unshift('ARG TARGETPLATFORM', 'ARG BUILDPLATFORM');

  return [
    ...header,
    ...lines.slice(0, lastFromIndex + 1),
    ...stageMetadata,
    ...lines.slice(lastFromIndex + 1),
  ].join('\n');
}

function builderFrom(image, stageName) {
  return `FROM --platform=$BUILDPLATFORM ${image} AS ${stageName}`;
}

function dotnetRuntimeRid(runtimeImage) {
  return runtimeImage.includes('alpine') ? 'linux-musl-x64' : 'linux-x64';
}

function dotnetPublishLine(projectPath, runtimeImage) {
  return `RUN dotnet publish "${projectPath}" -c Release -o /app/publish --no-restore --runtime ${dotnetRuntimeRid(runtimeImage)} --self-contained false`;
}

function nodeInstallLine(packageManager, prodOnly = false, options = {}) {
  const prefix = options.cwd ? `cd ${options.cwd} && ` : '';
  const omitDev = prodOnly;
  const secretMount = options.hasScopedPackages ? '--mount=type=secret,id=npmrc,target=/root/.npmrc ' : '';
  if (packageManager === 'pnpm') {
    const filter = options.filter ? ` --filter ${options.filter}` : '';
    return `RUN --mount=type=cache,target=/root/.local/share/pnpm/store ${secretMount}${prefix}${installPnpmGlobalCmd()} && ${prefix}pnpm install --frozen-lockfile${omitDev ? ' --prod' : ''}${filter}`;
  }
  if (packageManager === 'yarn') {
    return `RUN --mount=type=cache,target=/usr/local/share/.cache/yarn ${secretMount}${prefix}yarn install --frozen-lockfile${omitDev ? ' --production' : ''}`;
  }
  return `RUN --mount=type=cache,target=/root/.npm ${secretMount}${prefix}npm ci${omitDev ? ' --omit=dev' : ''}`;
}

function nodePruneLine(packageManager, cwd = '') {
  const prefix = cwd ? `cd ${cwd} && ` : '';
  if (packageManager === 'pnpm') return `RUN ${prefix}pnpm prune --prod`;
  if (packageManager === 'yarn') return `RUN ${prefix}yarn install --frozen-lockfile --production --ignore-scripts && yarn cache clean`;
  return `RUN ${prefix}npm prune --omit=dev`;
}

function nodeSourceCopyBlock(a, configCopyLine = '', frontendAssetCopyLine = '') {
  const blocks = [];
  if (configCopyLine) blocks.push(configCopyLine.trimEnd());
  if (a.framework === 'nextjs') {
    blocks.push('COPY app/ ./app/');
    blocks.push('COPY pages/ ./pages/');
    blocks.push('COPY components/ ./components/');
    blocks.push('COPY public/ ./public/');
  } else if (a.framework === 'remix') {
    blocks.push('COPY app/ ./app/');
    blocks.push('COPY public/ ./public/');
  } else if (['astro', 'vite', 'cra', 'sveltekit'].includes(a.framework)) {
    if (frontendAssetCopyLine) blocks.push(frontendAssetCopyLine.trimEnd());
    blocks.push('COPY src/ ./src/');
  } else if (a.framework === 'nestjs') {
    blocks.push('COPY src/ ./src/');
  } else {
    blocks.push('# Update these COPY lines if your source is not under src/.');
    blocks.push('COPY src/ ./src/');
  }
  return blocks.join('\n');
}

function pythonBuilderImage(a) {
  return a.hasNativeDeps ? `python:${a.version}` : BASE_IMAGES[STACKS.PYTHON](a.version);
}

function nodeSecretMount(a) {
  return a.hasScopedPackages ? '--mount=type=secret,id=npmrc,target=/root/.npmrc ' : '';
}

function nodeStopSignalBlock() {
  return 'STOPSIGNAL SIGTERM';
}

function runtimeUserBlock(alpine = true) {
  return alpine
    ? 'RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app\nUSER appuser'
    : 'RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser && chown -R appuser:appgroup /app\nUSER appuser';
}

function pythonInstallBlock(a, prefix = '') {
  const hashFlag = a.requirementsHasHashes ? ' --require-hashes' : '';
  const installCmd = a.packageManager === 'pip'
    ? `pip install --no-cache-dir${hashFlag} -r ${a.requirementsFile}`
    : a.installCmd;
  const lines = [`RUN --mount=type=cache,target=/root/.cache/pip ${prefix}${installCmd}`];
  if (a.needsGunicornInstall) {
    lines.push(`RUN ${prefix}pip install --no-cache-dir gunicorn`);
  }
  return lines.join('\n');
}

function pythonWheelInstallBlock(a, prefix = '') {
  const lines = [`RUN ${prefix}pip install --no-cache-dir --no-index --find-links=/wheels -r ${a.requirementsFile}`];
  if (a.needsGunicornInstall) {
    lines.push(`RUN ${prefix}pip install --no-cache-dir --no-index --find-links=/wheels gunicorn`);
  }
  return lines.join('\n');
}

function pythonWheelBuildBlock(a, prefix = '') {
  const lines = [`RUN ${prefix}pip wheel --no-cache-dir --wheel-dir /wheels -r ${a.requirementsFile}`];
  if (a.needsGunicornInstall) {
    lines.push(`RUN ${prefix}pip wheel --no-cache-dir --wheel-dir /wheels gunicorn`);
  }
  return lines.join('\n');
}

// ── Main Entry ───────────────────────────────────────────────────────────────

function generateDockerfile({ services, sharedDirs = [], staticAssets = [], rootConfigFiles = [], envVars = [], dockerignoreBlockedDirs = [], workspacePackageDirs = [], workspaceSharedConfigs = [] }) {
  // Single service at project root — classic path
  if (services.length === 1 && services[0].serviceDir === '.') {
    return finalizeResult(generateSingleRoot(services[0], envVars, rootConfigFiles));
  }

  // Single service in a subdirectory
  if (services.length === 1) {
    return finalizeResult(generateSingleSub(services[0], sharedDirs, staticAssets, rootConfigFiles, envVars, workspacePackageDirs, workspaceSharedConfigs));
  }

  // Multiple services — build a multi-stage Dockerfile
  return finalizeResult(generateMultiService(services, sharedDirs, rootConfigFiles, envVars, dockerignoreBlockedDirs, workspacePackageDirs, workspaceSharedConfigs));
}

// Builds a safe runtime ENV block from detected non-secret defaults.
function buildEnvBlock(envVars) {
  const safeDefaults = (envVars || []).filter(v =>
    v.hasDefault &&
    !isSecretLikeEnvKey(v.key) &&
    !isSecretLikeEnvValue(v.value)
  );
  if (safeDefaults.length === 0) return 'ENV NODE_ENV=production';
  const envPairs = [
    'NODE_ENV=production',
    ...safeDefaults
      .filter(v => v.key !== 'NODE_ENV')
      .map(v => `    ${v.key}=${v.value}`),
  ];
  const envLine = envPairs.length === 1
    ? `ENV NODE_ENV=production`
    : `ENV ${envPairs.join(' \\\n')}`;
  return envLine;
}

function buildCommandPrefix(service) {
  // Fire for CRA regardless of how detection landed — framework='cra', role='frontend',
  // or any build command that invokes react-scripts directly.
  const isReactScripts =
    service.framework === 'cra' ||
    service.role === 'frontend' ||
    (typeof service.buildCommand === 'string' && service.buildCommand.includes('react-scripts'));
  if (!isReactScripts) return '';
  return 'CI=false GENERATE_SOURCEMAP=false NODE_OPTIONS=--max-old-space-size=1024 DISABLE_ESLINT_PLUGIN=true ';
}

function countLineDiff(a = '', b = '') {
  const left = String(a).split(/\r?\n/);
  const right = String(b).split(/\r?\n/);
  const max = Math.max(left.length, right.length);
  let lineDiffCount = 0;

  for (let i = 0; i < max; i += 1) {
    if ((left[i] || '') !== (right[i] || '')) lineDiffCount += 1;
  }

  return {
    lineDiffCount,
    score: max === 0 ? 0 : Number((lineDiffCount / max).toFixed(2)),
  };
}

function normalizeDockerfileText(text) {
  if (!text) return text;
  return String(text)
    .replace(/â”€/g, '-')
    .replace(/[\u2500-\u257F]/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/⚠️/g, 'WARNING:');
}

function finalizeResult(result) {
  return {
    ...result,
    dockerfile: addDockerfileHeader(result.dockerfile),
    validationDockerfile: result.validationDockerfile
      ? addDockerfileHeader(result.validationDockerfile)
      : result.validationDockerfile,
  };
}

function withValidationVariant(result, validationDockerfile) {
  if (!validationDockerfile || validationDockerfile === result.dockerfile) {
    return {
      ...result,
      validationDockerfile: null,
      validationDrift: null,
    };
  }

  return {
    ...result,
    validationDockerfile: normalizeDockerfileText(validationDockerfile),
    validationDrift: countLineDiff(
      normalizeDockerfileText(result.dockerfile),
      normalizeDockerfileText(validationDockerfile)
    ),
  };
}

// ── Single service: lives at project root ────────────────────────────────────
// Existing behaviour — nothing changes for projects where package.json is at /

function generateSingleRoot(a, envVars = [], rootConfigFiles = []) {
  if (a.stack === STACKS.NODE)   return generateNodeRoot(a, envVars, rootConfigFiles);
  if (a.stack === STACKS.PYTHON) return generatePythonRoot(a, rootConfigFiles);
  if (a.stack === STACKS.DOTNET) return generateDotnetRoot(a);
  throw new Error(`No template for stack: ${a.stack}`);
}

// ── Single service: lives in a subdirectory ──────────────────────────────────

function generateSingleSub(a, sharedDirs, staticAssets, rootConfigFiles = [], envVars = [], workspacePackageDirs = [], workspaceSharedConfigs = []) {
  const dir = a.serviceDir;

  if (a.stack === STACKS.NODE)   return generateNodeSub(a, dir, sharedDirs, staticAssets, rootConfigFiles, envVars, workspacePackageDirs, workspaceSharedConfigs);
  if (a.stack === STACKS.PYTHON) return generatePythonSub(a, dir, sharedDirs, staticAssets);
  if (a.stack === STACKS.DOTNET) return generateDotnetSub(a, dir, sharedDirs);
  throw new Error(`No template for stack: ${a.stack}`);
}

// ── Multi-service ────────────────────────────────────────────────────────────

function generateMultiService(services, sharedDirs, rootConfigFiles = [], envVars = [], dockerignoreBlockedDirs = [], workspacePackageDirs = [], workspaceSharedConfigs = []) {
  const improvements = [];

  if (dockerignoreBlockedDirs.length > 0) {
    improvements.push(
      `⚠️  Your .dockerignore uses a whitelist that blocks: ${dockerignoreBlockedDirs.map(d => d + '/').join(', ')}. ` +
      `The generated .dockerignore tab fixes this — you MUST apply it alongside the Dockerfile or COPY commands will fail.`
    );
  }

  // Split into frontends and backends/services
  const frontends = services.filter(s => s.role === 'frontend');
  const backends  = services.filter(s => s.role !== 'frontend');

  if (frontends.length > 0 && backends.length === 0) {
    throw new Error('Multiple frontend services detected but no backend/runtime service was found. Generate each frontend separately or add a backend service to serve the built assets.');
  }

  const stages = [];

  // ── Frontend builder stages ──
  for (const fe of frontends) {
    if (fe.stack !== STACKS.NODE) continue;
    const baseImage = BASE_IMAGES[STACKS.NODE](fe.version);
    const stageName = `${fe.serviceDir.replace(/\//g, '-')}-build`;

    let stageContent;
    if (fe.lockFileAtRoot) {
      const buildPrefix = buildCommandPrefix(fe);
      const buildCmd = fe.packageManager === 'yarn'
        // Explicitly prepend /build/node_modules/.bin to PATH before build.
        // Hoisted devDeps (cross-env, vite, etc.) land in root node_modules/.bin,
        // but yarn 1.x script runner does not reliably add them via --cwd or nested
        // yarn calls. export PATH is inherited by all child processes.
        ? `RUN export PATH="/build/node_modules/.bin:$PATH" && cd ${fe.serviceDir} && ${buildPrefix}yarn build`
        : fe.packageManager === 'pnpm'
          ? `RUN ${buildPrefix}pnpm --filter ./${fe.serviceDir} build`
          : `RUN ${buildPrefix}npm run build --workspace=${fe.serviceDir}`;

      if (fe.packageManager === 'yarn') {
        // Copy ALL workspace member package.json files before install.
        // Yarn hoists devDeps from ALL members to root node_modules/.bin.
        // Missing members = their devDeps (cross-env, vite, etc.) not installed.
        const allServicePkgCopies = services
          .filter(s => s.lockFileAtRoot && s.serviceDir !== fe.serviceDir)
          .map(s => `COPY ${s.serviceDir}/package.json ./${s.serviceDir}/package.json`)
          .join('\n');
        const extraPkgCopies = workspacePackageDirs
          .filter(d => d !== fe.serviceDir && !services.some(s => s.serviceDir === d))
          .map(d => `COPY ${d}/package.json ./${d}/package.json`)
          .join('\n');
        const allExtraCopies = [allServicePkgCopies, extraPkgCopies].filter(Boolean).join('\n');
        stageContent = `
# ─── Stage: Build ${fe.serviceDir} ───────────────────────────────────────
${builderFrom(baseImage, stageName)}

WORKDIR /build

COPY ${fe.lockFile} package.json ./
COPY ${fe.serviceDir}/package.json ./${fe.serviceDir}/package.json${allExtraCopies ? '\n' + allExtraCopies : ''}
RUN yarn install --frozen-lockfile

# Copy only this service's source — other workspace dirs not needed for this build
COPY ${fe.serviceDir}/ ./${fe.serviceDir}/
${buildCmd}`.trim();
      } else {
        // pnpm/npm: workspace root install with all workspace package.json files
        // COPY . . is banned — leaks .env and secrets into build context.
        const installCmd = fe.packageManager === 'pnpm'
          ? `RUN ${installPnpmGlobalCmd()} && pnpm install --frozen-lockfile`
          : `RUN npm ci`;
        const workspacePkgCopies = services
          .filter(s => s.lockFileAtRoot)
          .map(s => `COPY ${s.serviceDir}/package.json ./${s.serviceDir}/package.json`)
          .join('\n');
        stageContent = `
# ─── Stage: Build ${fe.serviceDir} ───────────────────────────────────────
${builderFrom(baseImage, stageName)}

WORKDIR /build

# Copy manifests first for better Docker layer caching
COPY ${fe.lockFile} package.json ./
${workspacePkgCopies}
${installCmd}

# Copy only this service's source — other workspace dirs not needed for this build
COPY ${fe.serviceDir}/ ./${fe.serviceDir}/
${buildCmd}`.trim();
      }
    } else {
      // Lock file lives inside the service directory — standalone package
      const installCmd = fe.packageManager === 'pnpm'
        ? `RUN ${installPnpmGlobalCmd()} && pnpm install --frozen-lockfile`
        : fe.packageManager === 'yarn'
          ? `RUN yarn install --frozen-lockfile`
          : `RUN npm ci`;

      stageContent = `
# ─── Stage: Build ${fe.serviceDir} ───────────────────────────────────────
${builderFrom(baseImage, stageName)}

WORKDIR /build

COPY ${fe.serviceDir}/${fe.lockFile} ${fe.serviceDir}/package.json ./
${installCmd}

COPY ${fe.serviceDir}/ .
RUN ${fe.buildCommand || 'npm run build'}`.trim();
    }

    stages.push(stageContent);
    improvements.push(`Frontend (${fe.serviceDir}): built in isolated stage — build tools never reach production image`);
  }

  // ── Backend / service runtime stages ──
  for (const be of backends) {
    const dir = be.serviceDir;
    const sharedCopies = sharedDirs.map(s => `COPY ${s}/ ./${s}/`).join('\n');

    // Frontend artifact copies — use correct build output path per frontend
    const frontendCopies = frontends.map(fe => {
      const stageName = `${fe.serviceDir.replace(/\//g, '-')}-build`;
      const buildOutputDir = fe.buildOutputDir || 'dist';
      const buildOutputPath = fe.lockFileAtRoot
        ? (fe.serviceDir === '.' ? `/build/${buildOutputDir}` : `/build/${fe.serviceDir}/${buildOutputDir}`)
        : `/build/${buildOutputDir}`;
      return `# Copy built ${fe.serviceDir} assets into server static dir\nCOPY --from=${stageName} ${buildOutputPath} ./${dir}/public`;
    }).join('\n');

    if (be.stack === STACKS.NODE) {
      const baseImage = BASE_IMAGES[STACKS.NODE](be.version);
      const beStageName = `${dir.replace(/\//g, '-')}-build`;

      // ── If backend has its own build step, add a dedicated build stage ──
      if (be.hasBuild) {
        const rootConfigCopy = rootConfigFiles.length > 0
          ? `# Copy root config files needed during build\nCOPY ${rootConfigFiles.join(' ')} ./`
          : '';

        let beBuildDepsSection, beBuildInstallSection, beBuildCmd;
        if (be.lockFileAtRoot) {
          const allPkgJsonCopies = services
            .filter(s => s.lockFileAtRoot)
            .map(s => `COPY ${s.serviceDir}/package.json ./${s.serviceDir}/`)
            .join('\n');
          beBuildDepsSection = `COPY ${be.lockFile} package.json ./\n${allPkgJsonCopies}`;
          beBuildInstallSection = be.packageManager === 'pnpm'
            ? `RUN ${installPnpmGlobalCmd()} && pnpm install --frozen-lockfile && pnpm store prune`
            : be.packageManager === 'yarn'
              ? `RUN yarn install --frozen-lockfile && yarn cache clean`
              : `RUN npm ci && npm cache clean --force`;
          beBuildCmd = be.packageManager === 'yarn'
            ? `RUN export PATH="/build/node_modules/.bin:$PATH" && cd ${dir} && yarn build`
            : be.packageManager === 'pnpm'
              ? `RUN pnpm --filter ./${dir} build`
              : `RUN npm run build --workspace=${dir}`;
        } else {
          beBuildDepsSection = `COPY ${dir}/${be.lockFile} ${dir}/package.json ./${dir}/`;
          beBuildInstallSection = be.packageManager === 'pnpm'
            ? `RUN ${installPnpmGlobalCmd()} && cd ${dir} && pnpm install --frozen-lockfile && pnpm store prune`
            : be.packageManager === 'yarn'
              ? `RUN cd ${dir} && yarn install --frozen-lockfile && yarn cache clean`
              : `RUN cd ${dir} && npm ci && npm cache clean --force`;
          beBuildCmd = `RUN cd ${dir} && ${be.buildCommand}`;
        }

        stages.push(`
# ─── Stage: Build ${dir} ─────────────────────────────────────────────────
${builderFrom(baseImage, beStageName)}

WORKDIR /build

${beBuildDepsSection}
${beBuildInstallSection}
${rootConfigCopy ? '\n' + rootConfigCopy : ''}
COPY ${dir}/ ./${dir}/
${beBuildCmd}`.trim());

        improvements.push(`Backend (${dir}): compiled in isolated build stage — source and dev tools never reach runtime image`);
      }

      // ── Runtime stage ──
      let copyDepsSection, installSection;
      if (be.lockFileAtRoot) {
        const allPkgJsonCopies = services
          .filter(s => s.lockFileAtRoot)
          .map(s => `COPY ${s.serviceDir}/package.json ./${s.serviceDir}/`)
          .join('\n');
        let installCmd;
        if (be.packageManager === 'pnpm') {
          const filter = be.isWorkspace ? ` --filter ${dir}` : '';
          installCmd = `RUN ${installPnpmGlobalCmd()} && pnpm install --frozen-lockfile --prod${filter} && pnpm store prune`;
        } else if (be.packageManager === 'yarn') {
          installCmd = be.isWorkspace
            ? `RUN yarn --cwd ./${dir} install --frozen-lockfile --production && yarn cache clean`
            : `RUN yarn install --frozen-lockfile --production && yarn cache clean`;
        } else {
          installCmd = `RUN npm ci --omit=dev && npm cache clean --force`;
        }
        copyDepsSection = `COPY ${be.lockFile} package.json ./\n${allPkgJsonCopies}`;
        installSection = installCmd;
      } else {
        const installCmd = be.packageManager === 'pnpm'
          ? `RUN ${installPnpmGlobalCmd()} && cd ${dir} && pnpm install --frozen-lockfile --prod && pnpm store prune`
          : be.packageManager === 'yarn'
            ? `RUN cd ${dir} && yarn install --frozen-lockfile --production && yarn cache clean`
            : `RUN cd ${dir} && npm ci --omit=dev && npm cache clean --force`;
        copyDepsSection = `COPY ${dir}/${be.lockFile} ${dir}/package.json ./${dir}/`;
        installSection = installCmd;
      }

      // Runtime copies either compiled dist OR raw source (when no build step)
      const sourceSection = be.hasBuild
        ? `# Copy compiled output from build stage\nCOPY --from=${beStageName} /build/${dir}/${be.buildOutputDir || 'dist'} ./${dir}/${be.buildOutputDir || 'dist'}`
        : `COPY ${dir}/ ./${dir}/`;

      const startCmdJson = JSON.stringify(runtimeStartCmd(be));

      stages.push(`
# ─── Stage: Runtime ${dir} ───────────────────────────────────────────────
FROM ${baseImage}

WORKDIR /app

${buildEnvBlock(envVars)}

${copyDepsSection}
${installSection}

${sourceSection}
${sharedCopies ? sharedCopies + '\n' : ''}${frontendCopies ? frontendCopies + '\n' : ''}
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

${nodeStopSignalBlock()}
EXPOSE ${be.port}
${simpleHttpHealthcheck(be.port)}
WORKDIR /app/${dir}
CMD ${startCmdJson}`.trim());

    } else if (be.stack === STACKS.PYTHON) {
      const baseImage = BASE_IMAGES[STACKS.PYTHON](be.version);
      stages.push(`
# ─── Stage: Runtime ${dir} ───────────────────────────────────────────────
FROM ${baseImage}

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY ${dir}/${be.requirementsFile} ./${dir}/
${pythonInstallBlock(be, `cd ${dir} && `)}

COPY ${dir}/ ./${dir}/
${sharedCopies ? sharedCopies : ''}

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

EXPOSE ${be.port}
WORKDIR /app/${dir}
CMD ${JSON.stringify(dockerCmdArray(be.startCmd, ['python', be.entryPoint]))}`.trim());

    } else if (be.stack === STACKS.DOTNET) {
      const runtimeImage = BASE_IMAGES[STACKS.DOTNET].runtime(be.version);
      const sdkImage     = BASE_IMAGES[STACKS.DOTNET].sdk(be.version);
      const stageName    = `${dir.replace(/\//g, '-')}-dotnet-build`;
      stages.push(`
# ─── Stage: Build ${dir} (.NET) ──────────────────────────────────────────
${builderFrom(sdkImage, stageName)}

WORKDIR /src

COPY ${dir}/${be.csprojPath} ./${dir}/
RUN dotnet restore "${dir}/${be.csprojPath}"

COPY ${dir}/ ./${dir}/
${dotnetPublishLine(`${dir}/${be.csprojPath}`, runtimeImage)}

# ─── Stage: Runtime ${dir} ───────────────────────────────────────────────
FROM ${runtimeImage}

WORKDIR /app

ENV DOTNET_RUNNING_IN_CONTAINER=true \\
    ASPNETCORE_URLS=http://+:${be.port}

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

COPY --from=${stageName} /app/publish .

EXPOSE ${be.port}
ENTRYPOINT ["dotnet", "${be.projectName}.dll"]`.trim());
    }
  }

  const header = `# ⚠️  IMPORTANT: Replace your .dockerignore with the generated one from the .dockerignore tab.\n# Without it, COPY commands may fail if your existing .dockerignore uses a whitelist.\n`;
  const dockerfile = header + stages.join('\n\n');
  const dockerignore = buildDockerignore(services);

  if (frontends.length > 0 && backends.length > 0) {
    improvements.push('Multi-stage build: frontend compiled separately, backend runs lean runtime image');
  }
  improvements.push('HEALTHCHECK should probe /health for each runtime service; add a /health endpoint returning 2xx where missing');

  const collectedNginxConf = frontends.length > 0 ? nginxConf(frontends[0].port) : undefined;
  return { dockerfile, dockerignore, improvements, nginxConf: collectedNginxConf };
}

// ── Node at root (original behaviour) ───────────────────────────────────────

function generateNodeRoot(a, envVars = [], rootConfigFiles = []) {
  const baseImage = BASE_IMAGES[STACKS.NODE](a.version);
  const improvements = [];
  const startCmdJson = JSON.stringify(runtimeStartCmd(a));
  const extraConfigs = rootConfigFiles.filter(f => !['package.json', a.lockFile].includes(f));
  const configCopyLine = extraConfigs.length > 0 ? `COPY ${extraConfigs.join(' ')} ./\n` : '';
  const frontendAssetCopyLine = (a.role === 'frontend' || a.framework === 'cra') ? 'COPY public/ ./public/\n' : '';

  let dockerfile;

  if (a.hasBuild) {
    const buildInstall = nodeInstallLine(a.packageManager, false, { hasScopedPackages: a.hasScopedPackages });
    const buildPrefix = buildCommandPrefix(a);
    const buildOut = a.buildOutputDir || 'dist';
    const sourceCopyBlock = nodeSourceCopyBlock(a, configCopyLine, frontendAssetCopyLine);

    // CRA / pure-frontend: runtime is a static file server, not a Node app.
    // react-scripts is a devDep — it won't be present after --production install,
    // and react-scripts start is a dev server anyway.
    if (a.role === 'frontend' || a.framework === 'cra') {
      dockerfile = `
# ─── Stage 1: Build ───────────────────────────────────────
${builderFrom(baseImage, 'builder')}

WORKDIR /app

COPY ${a.lockFile} package.json ./
${buildInstall}

# Copy source
${sourceCopyBlock}
RUN ${buildPrefix}${a.buildCommand}

# ─── Stage 2: Runtime ─────────────────────────────────────
FROM ${STATIC_RUNTIME_IMAGE}

COPY --from=builder /app/${buildOut} /usr/share/nginx/html
${nginxStaticServerBlock(a.port)}

EXPOSE ${a.port}
${simpleHttpHealthcheck(a.port)}
CMD ["nginx", "-g", "daemon off;"]`.trim();

      const validationDockerfile = dockerfile;
      improvements.push(`Frontend-only: built then served with ${STATIC_RUNTIME_IMAGE}. No Node runtime or node_modules in final image.`);
      return withValidationVariant({ dockerfile, dockerignore: nodeDockerignore(), nginxConf: nginxConf(a.port), improvements }, validationDockerfile);

    } else {
      const pruneCmd = nodePruneLine(a.packageManager);
      dockerfile = `
# ─── Stage 1: Build ───────────────────────────────────────
${builderFrom(baseImage, 'builder')}

WORKDIR /app

COPY ${a.lockFile} package.json ./
${buildInstall}

# Copy source
${sourceCopyBlock}
RUN ${buildPrefix}${a.buildCommand}
${pruneCmd}

# ─── Stage 2: Runtime ─────────────────────────────────────
FROM ${baseImage}

WORKDIR /app

${buildEnvBlock(envVars)}

COPY ${a.lockFile} package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/${buildOut} ./${buildOut}

${runtimeUserBlock(true)}

${nodeStopSignalBlock()}
EXPOSE ${a.port}
${simpleHttpHealthcheck(a.port)}
CMD ${startCmdJson}`.trim();
    }
  } else {
    dockerfile = `
FROM ${baseImage}

WORKDIR /app

${buildEnvBlock(envVars)}

COPY ${a.lockFile} package.json ./
${nodeInstallLine(a.packageManager, true, { hasScopedPackages: a.hasScopedPackages })}

# Copy source
${nodeSourceCopyBlock(a, configCopyLine)}

${runtimeUserBlock(true)}

${nodeStopSignalBlock()}
EXPOSE ${a.port}
${simpleHttpHealthcheck(a.port)}
CMD ${startCmdJson}`.trim();
  }

  improvements.push('HEALTHCHECK probes /health; add a /health endpoint returning 2xx if your app does not already expose one');
  if (!a.hasBuild) improvements.push('If you add a build step later, use multi-stage builds to keep image small');
  if (a.framework === null) {
    improvements.push('WARNING: Unknown Node backend source layout - verify your source is not under src/ before using the generated COPY src/ line.');
  }
  if (a.hasScopedPackages) {
    improvements.push('Scoped packages detected: pass private registry credentials with docker build --secret id=npmrc,src=.npmrc');
  }
  improvements.push('Verify your source lives in src/ — if not, update the COPY src/ line in the build stage to match your actual source directory.');

  improvements.push('Add a SIGTERM handler: process.on(\'SIGTERM\', () => server.close())');

  return { dockerfile, dockerignore: nodeDockerignore(), improvements };
}

// ── Node in a subdirectory ───────────────────────────────────────────────────

function generateNodeSub(a, dir, sharedDirs, staticAssets = [], rootConfigFiles = [], envVars = [], workspacePackageDirs = [], workspaceSharedConfigs = []) {
  const baseImage = BASE_IMAGES[STACKS.NODE](a.version);
  const improvements = [];
  const sharedCopies = sharedDirs.map(s => `COPY ${s}/ ./${s}/`).join('\n');
  const staticCopies = staticAssets.map(s => `COPY ${s}/ ./${s}/`).join('\n');
  // Sibling dirs detected via require('../xxx') in the entry point — deduplicated against sharedDirs
  const siblingOnlyCopies = (a.siblingDeps || [])
    .filter(d => !sharedDirs.includes(d))
    .map(d => `COPY ${d}/ ./${d}/`)
    .join('\n');

  let dockerfile;

  if (a.hasBuild && a.role === 'frontend') {
    // Frontend build → serve static via nginx
    const stageName = 'build';

    // When lock file is at project root, copy root files + service package.json and
    // use workspace-scoped build. Build output lands at /build/<dir>/dist in that case.
    let lockCopy, buildInstall, sourceCopy, buildRun, buildOutput;
    if (a.lockFileAtRoot) {
      // Workspace monorepo: copy root lockfile + this service's package.json,
      // then copy service source explicitly.
      // COPY . . is banned — leaks .env and secrets into build context.
      if (a.packageManager === 'yarn') {
        // Copy root lockfile + package.json + ALL workspace member package.json files.
        // Yarn hoists devDeps from ALL workspace members to root node_modules/.bin.
        // Missing members = their devDeps (cross-env, vite, etc.) not installed at all.
        // COPY . . solved this by accident; we replicate it selectively here.
        const extraPkgCopies = workspacePackageDirs
          .filter(d => d !== dir)
          .map(d => `COPY ${d}/package.json ./${d}/package.json`)
          .join('\n');
        lockCopy     = `COPY ${a.lockFile} package.json ./\nCOPY ${dir}/package.json ./${dir}/package.json${extraPkgCopies ? '\n' + extraPkgCopies : ''}`;
      buildInstall = `RUN ${nodeSecretMount(a)}yarn install --frozen-lockfile`;
      } else {
        lockCopy     = `COPY ${a.lockFile} package.json ./\nCOPY ${dir}/package.json ./${dir}/package.json`;
        buildInstall = installLine(a.packageManager, false);
      }
      sourceCopy   = `COPY ${dir}/ ./${dir}/`;
      // Copy root-level dirs imported by vite config (e.g. scripts/) — needed at build time
      const rootDepCopies = (a.rootBuildDeps || []).map(d => `COPY ${d}/ ./${d}/`).join('\n');
      if (rootDepCopies) sourceCopy += '\n' + rootDepCopies;
      // Workspace packages are local source imports — vite resolves them at build time
      const workspaceSrcCopies = workspacePackageDirs
        .filter(d => d !== dir)
        .map(d => `COPY ${d}/ ./${d}/`)
        .join('\n');
      if (workspaceSrcCopies) sourceCopy += '\n' + workspaceSrcCopies;
      const buildPrefix = buildCommandPrefix(a);
      buildRun     = a.packageManager === 'yarn'
        // Explicitly prepend /build/node_modules/.bin to PATH before build.
        // Hoisted devDeps (cross-env, vite, etc.) land in root node_modules/.bin,
        // but yarn 1.x script runner does not reliably add them when running via
        // --cwd or from a sub-yarn call. export PATH is inherited by all child
        // processes (yarn build:app → shell → cross-env) so this covers nested calls.
        ? `RUN export PATH="/build/node_modules/.bin:$PATH" && cd ${dir} && ${buildPrefix}yarn build`
        : a.packageManager === 'pnpm'
          ? `RUN ${buildPrefix}pnpm --filter ./${dir} build`
          : `RUN ${buildPrefix}npm run build --workspace=${dir}`;
      buildOutput  = `/build/${dir}/${a.buildOutputDir || 'build'}`;
    } else {
      lockCopy     = `COPY ${dir}/${a.lockFile} ${dir}/package.json ./`;
      buildInstall = installLine(a.packageManager, false);
      sourceCopy   = `COPY ${dir}/ .`;
      buildRun     = `RUN ${buildCommandPrefix(a)}${a.buildCommand}`;
      buildOutput  = `/build/${a.buildOutputDir || 'build'}`;
    }

    const rootConfigCopy = rootConfigFiles.length > 0
      ? `# Copy root config files needed during build\nCOPY ${rootConfigFiles.join(' ')} ./\n`
      : '';
    const sharedConfigCopy = workspaceSharedConfigs.length > 0
      ? workspaceSharedConfigs.map(f => `COPY ${f} ./${path.dirname(f)}/`).join('\n') + '\n'
      : '';

    dockerfile = `
# ─── Stage 1: Build ───────────────────────────────────────
${builderFrom(baseImage, stageName)}

WORKDIR /build

${lockCopy}
${buildInstall}
${rootConfigCopy}
${sourceCopy}
${sharedConfigCopy}${buildRun}

# ─── Stage 2: Serve ───────────────────────────────────────
FROM ${STATIC_RUNTIME_IMAGE}

COPY --from=${stageName} ${buildOutput} /usr/share/nginx/html
${nginxStaticServerBlock(a.port)}

EXPOSE ${a.port}
${simpleHttpHealthcheck(a.port)}
CMD ["nginx", "-g", "daemon off;"]`.trim();

    const validationDockerfile = dockerfile;
    improvements.push(`Frontend-only: built then served with ${STATIC_RUNTIME_IMAGE}. If a backend also serves the files, merge into one multi-service build.`);
    return withValidationVariant({ dockerfile, dockerignore: nodeDockerignore(), nginxConf: nginxConf(a.port), improvements }, validationDockerfile);


  } else {
    // Backend/service in subdirectory
    const startCmdJson = JSON.stringify(runtimeStartCmd(a));
    const outputDir = a.buildOutputDir || 'dist';

    let lockCopy, installStep;
    if (a.lockFileAtRoot) {
      lockCopy = `COPY ${a.lockFile} package.json ./\nCOPY ${dir}/package.json ./${dir}/`;
      if (a.packageManager === 'pnpm') {
        const filter = a.isWorkspace ? ` --filter ${dir}` : '';
        installStep = `RUN ${nodeSecretMount(a)}${installPnpmGlobalCmd()} && pnpm install --frozen-lockfile --prod${filter} && pnpm store prune`;
      } else if (a.packageManager === 'yarn') {
        installStep = a.isWorkspace
          ? `RUN ${nodeSecretMount(a)}yarn --cwd ./${dir} install --frozen-lockfile --production && yarn cache clean`
          : `RUN ${nodeSecretMount(a)}yarn install --frozen-lockfile --production && yarn cache clean`;
      } else {
        installStep = `RUN ${nodeSecretMount(a)}npm ci --omit=dev && npm cache clean --force`;
      }
    } else {
      lockCopy = `COPY ${dir}/${a.lockFile} ${dir}/package.json ./${dir}/`;
      installStep = a.packageManager === 'pnpm'
        ? `RUN ${nodeSecretMount(a)}${installPnpmGlobalCmd()} && cd ${dir} && pnpm install --frozen-lockfile --prod && pnpm store prune`
        : a.packageManager === 'yarn'
          ? `RUN ${nodeSecretMount(a)}cd ${dir} && yarn install --frozen-lockfile --production && yarn cache clean`
          : `RUN ${nodeSecretMount(a)}cd ${dir} && npm ci --omit=dev && npm cache clean --force`;
    }

    // When backend has a build step, add a build stage and copy only compiled output
    if (a.hasBuild) {
      const rootConfigCopy = rootConfigFiles.length > 0
        ? `# Copy root config files needed during build\nCOPY ${rootConfigFiles.join(' ')} ./\n`
        : '';
      const buildInstall = a.lockFileAtRoot
        ? (a.packageManager === 'pnpm'
            ? `RUN ${nodeSecretMount(a)}${installPnpmGlobalCmd()} && pnpm install --frozen-lockfile && pnpm store prune`
            : a.packageManager === 'yarn'
              ? `RUN ${nodeSecretMount(a)}yarn install --frozen-lockfile && yarn cache clean`
              : `RUN ${nodeSecretMount(a)}npm ci && npm cache clean --force`)
        : (a.packageManager === 'pnpm'
            ? `RUN ${nodeSecretMount(a)}${installPnpmGlobalCmd()} && cd ${dir} && pnpm install --frozen-lockfile && pnpm store prune`
            : a.packageManager === 'yarn'
              ? `RUN ${nodeSecretMount(a)}cd ${dir} && yarn install --frozen-lockfile && yarn cache clean`
              : `RUN ${nodeSecretMount(a)}cd ${dir} && npm ci && npm cache clean --force`);
      const buildCmd = a.lockFileAtRoot
        ? (a.packageManager === 'yarn' ? `RUN export PATH="/build/node_modules/.bin:$PATH" && cd ${dir} && yarn build`
            : a.packageManager === 'pnpm' ? `RUN pnpm --filter ./${dir} build`
            : `RUN npm run build --workspace=${dir}`)
        : `RUN cd ${dir} && ${a.buildCommand}`;

      const buildStageName = `${dir.replace(/\//g, '-')}-build`;
      const pruneCmd = nodePruneLine(a.packageManager, a.lockFileAtRoot ? '' : dir);
      const runtimeNodeModulesCopy = a.lockFileAtRoot
        ? `COPY --from=${buildStageName} /build/node_modules ./node_modules`
        : `COPY --from=${buildStageName} /build/${dir}/node_modules ./${dir}/node_modules`;
      dockerfile = `
# ─── Stage 1: Build ───────────────────────────────────────
${builderFrom(baseImage, buildStageName)}

WORKDIR /build

# Install all deps (dev included) for build
${lockCopy}
${buildInstall}
${rootConfigCopy}
COPY ${dir}/ ./${dir}/
${buildCmd}
${pruneCmd}

# ─── Stage 2: Runtime ─────────────────────────────────────
FROM ${baseImage}

WORKDIR /app

${buildEnvBlock(envVars)}

# Install prod deps only
${lockCopy}
${runtimeNodeModulesCopy}

# Copy compiled output from build stage — no raw source in runtime
COPY --from=${buildStageName} /build/${dir}/${outputDir} ./${dir}/${outputDir}
${sharedCopies ? `\n# Copy shared utilities\n${sharedCopies}` : ''}${siblingOnlyCopies ? `\n# Copy sibling dirs required via require('../xxx')\n${siblingOnlyCopies}` : ''}
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

${nodeStopSignalBlock()}
EXPOSE ${a.port}
${simpleHttpHealthcheck(a.port)}
WORKDIR /app/${dir}
CMD ${startCmdJson}`.trim();

      improvements.push(`Backend (${dir}): compiled in isolated build stage — source and dev tools stay out of runtime image`);
    } else {
      dockerfile = `
FROM ${baseImage}

WORKDIR /app

${buildEnvBlock(envVars)}

# Install prod deps — separate layer so Docker cache busts only on dependency changes
${lockCopy}
${installStep}

# Copy service source
COPY ${dir}/ ./${dir}/
${sharedCopies ? `\n# Copy shared utilities\n${sharedCopies}` : ''}${siblingOnlyCopies ? `\n# Copy sibling dirs required via require('../xxx')\n${siblingOnlyCopies}` : ''}
${staticCopies ? `\n# Copy static assets served by the backend\n${staticCopies}` : ''}
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

${nodeStopSignalBlock()}
EXPOSE ${a.port}

# Set working dir to service root so relative require() paths resolve correctly
${simpleHttpHealthcheck(a.port)}
WORKDIR /app/${dir}
CMD ${startCmdJson}`.trim();
    }

    if (sharedDirs.length > 0) {
      improvements.push(`Shared dirs copied: ${sharedDirs.join(', ')} — mounted alongside service so relative imports resolve`);
    }
    if ((a.siblingDeps || []).length > 0) {
      improvements.push(`Sibling dirs detected and copied: ${a.siblingDeps.join(', ')} — referenced via require('../xxx') in your entry point`);
    }
  }

  improvements.push('HEALTHCHECK probes /health; add a /health endpoint returning 2xx if your app does not already expose one');
  improvements.push('Add a SIGTERM handler: process.on(\'SIGTERM\', () => server.close())');

  return { dockerfile, dockerignore: nodeDockerignore(), improvements };
}

// ── Python at root ───────────────────────────────────────────────────────────

function generatePythonRoot(a, rootConfigFiles = []) {
  const baseImage = BASE_IMAGES[STACKS.PYTHON](a.version);
  const builderImage = pythonBuilderImage(a);
  const improvements = [];

  // Copy root config files if any exist (e.g. pyproject.toml, setup.cfg)
  const extraConfigs = rootConfigFiles.filter(f => f !== a.requirementsFile);
  const configCopyLine = extraConfigs.length > 0
    ? `COPY ${extraConfigs.join(' ')} ./\n`
    : '';

  // Explicit source copy — COPY . . is banned.
  // Django: manage.py lives at root; user must add app dirs themselves.
  // FastAPI/Flask: copy the detected entry point.
  const sourceCopyBlock = a.framework === 'django'
    ? `COPY manage.py ./\n# TODO: add your Django app directories below, e.g.:\n# COPY myapp/ ./myapp/`
    : `COPY ${a.entryPoint} ./`;

  const detectedDjangoCopyBlock = a.framework === 'django' && (a.djangoAppDirs || []).length > 0
    ? `COPY manage.py ./\n${a.djangoAppDirs.map(d => `COPY ${d}/ ./${d}/`).join('\n')}`
    : sourceCopyBlock;

  {
    const dockerfile = `
${builderFrom(builderImage, 'builder')}

ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /app

COPY ${a.requirementsFile} ./
${pythonInstallBlock(a)}

FROM ${baseImage}

ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PYTHONPATH=/app

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
${configCopyLine}${detectedDjangoCopyBlock}

${runtimeUserBlock(false)}

EXPOSE ${a.port}
CMD ${JSON.stringify(dockerCmdArray(a.startCmd, ['python', a.entryPoint]))}`.trim();

    if (a.hasNativeDeps) {
      improvements.push(`Native Python dependencies detected (${(a.nativeDeps || []).join(', ')}) - installed in a builder venv so build tooling stays out of runtime`);
    }
    improvements.push('Pin all dependency versions in requirements.txt for reproducible builds');
    if (!a.requirementsHasHashes) {
      improvements.push('Use pip-tools hashes in requirements.txt to enable pip --require-hashes');
    }
    improvements.push('Verify all source directories are explicitly COPYed - add COPY <yourdir>/ ./<yourdir>/ for each module');
    if (a.framework === 'django') {
      improvements.push('Run collectstatic as part of your build or entrypoint for production');
      improvements.push('Use gunicorn instead of the Django dev server in production');
    }
    if (a.framework === 'fastapi') {
      improvements.push('Tune FastAPI --workers for the CPU quota assigned to the container');
    }
    return { dockerfile, dockerignore: pythonDockerignore(), improvements };
  }

}

// ── Python in subdirectory ───────────────────────────────────────────────────

function generatePythonSub(a, dir, sharedDirs) {
  const baseImage = BASE_IMAGES[STACKS.PYTHON](a.version);
  const builderImage = pythonBuilderImage(a);
  const sharedCopies = sharedDirs.map(s => `COPY ${s}/ ./${s}/`).join('\n');

  {
    const dockerfile = `
${builderFrom(builderImage, 'builder')}

ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /app

COPY ${dir}/${a.requirementsFile} ./${dir}/
${pythonInstallBlock(a, `cd ${dir} && `)}

FROM ${baseImage}

ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PYTHONPATH=/app

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY ${dir}/ ./${dir}/
${sharedCopies ? `\n# Copy shared utilities\n${sharedCopies}` : ''}

${runtimeUserBlock(false)}

EXPOSE ${a.port}
WORKDIR /app/${dir}
CMD ${JSON.stringify(dockerCmdArray(a.startCmd, ['python', a.entryPoint]))}`.trim();

    const improvements = [];
    if (a.hasNativeDeps) {
      improvements.push(`Native Python dependencies detected (${(a.nativeDeps || []).join(', ')}) - installed in a builder venv so build tooling stays out of runtime`);
    }
    return { dockerfile, dockerignore: pythonDockerignore(), improvements };
  }

}

// ── .NET at root ─────────────────────────────────────────────────────────────

function generateDotnetRoot(a) {
  const runtimeImage = BASE_IMAGES[STACKS.DOTNET].runtime(a.version);
  const sdkImage     = BASE_IMAGES[STACKS.DOTNET].sdk(a.version);

  // Determine source root — csprojPath is relative, e.g. "MyApp.csproj" or "src/MyApp.csproj"
  // If the .csproj is in a subdirectory, copy that subdirectory. Otherwise copy common C# dirs.
  const csprojDir = a.csprojPath.includes('/')
    ? a.csprojPath.split('/').slice(0, -1).join('/')
    : null;

  let sourceCopyBlock = csprojDir
    ? `COPY ${csprojDir}/ ./${csprojDir}/`
    : `# Copy source - add explicit COPY for each source directory in your project\nCOPY *.cs ./\nCOPY Properties/ ./Properties/`;

  if (!csprojDir && a.dotnetSourceDirs && a.dotnetSourceDirs.length > 0) {
    sourceCopyBlock = ['COPY *.cs ./', ...a.dotnetSourceDirs.map(d => `COPY ${d}/ ./${d}/`)].join('\n');
  }

  const dockerfile = `
# ─── Stage 1: Build ───────────────────────────────────────
${builderFrom(sdkImage, 'builder')}

WORKDIR /src

COPY ${a.csprojPath} ./
RUN dotnet restore "${a.csprojPath}"

${sourceCopyBlock}
${dotnetPublishLine(a.csprojPath, runtimeImage)}

# ─── Stage 2: Runtime ─────────────────────────────────────
FROM ${runtimeImage}

WORKDIR /app

ENV DOTNET_RUNNING_IN_CONTAINER=true \\
    ASPNETCORE_URLS=http://+:${a.port}

COPY --from=builder /app/publish .

${runtimeUserBlock(false)}

EXPOSE ${a.port}
ENTRYPOINT ["dotnet", "${a.projectName}.dll"]`.trim();

  return {
    dockerfile,
    dockerignore: dotnetDockerignore(),
    improvements: [
      'Set ASPNETCORE_ENVIRONMENT=Production in your container runtime config, not in the Dockerfile',
      'Consider adding a health check endpoint (/health) and HEALTHCHECK instruction',
      'Add explicit COPY instructions for each source directory (Controllers/, Models/, Services/, etc.) to avoid leaking secrets into build context',
    ],
  };
}

// ── .NET in subdirectory ─────────────────────────────────────────────────────

function generateDotnetSub(a, dir, sharedDirs) {
  const runtimeImage = BASE_IMAGES[STACKS.DOTNET].runtime(a.version);
  const sdkImage     = BASE_IMAGES[STACKS.DOTNET].sdk(a.version);

  const dockerfile = `
# ─── Stage 1: Build ───────────────────────────────────────
${builderFrom(sdkImage, 'builder')}

WORKDIR /src

COPY ${dir}/${a.csprojPath} ./${dir}/
RUN dotnet restore "${dir}/${a.csprojPath}"

COPY ${dir}/ ./${dir}/
${dotnetPublishLine(`${dir}/${a.csprojPath}`, runtimeImage)}

# ─── Stage 2: Runtime ─────────────────────────────────────
FROM ${runtimeImage}

WORKDIR /app

ENV DOTNET_RUNNING_IN_CONTAINER=true \\
    ASPNETCORE_URLS=http://+:${a.port}

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

COPY --from=builder /app/publish .

EXPOSE ${a.port}
ENTRYPOINT ["dotnet", "${a.projectName}.dll"]`.trim();

  return { dockerfile, dockerignore: dotnetDockerignore(), improvements: [] };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function installLine(packageManager, prodOnly) {
  if (packageManager === 'pnpm') {
    return prodOnly
      ? `RUN ${installPnpmGlobalCmd()} && pnpm install --frozen-lockfile --prod`
      : `RUN ${installPnpmGlobalCmd()} && pnpm install --frozen-lockfile`;
  }
  if (packageManager === 'yarn') {
    return prodOnly
      ? 'RUN yarn install --frozen-lockfile --production'
      : 'RUN yarn install --frozen-lockfile';
  }
  return prodOnly ? 'RUN npm ci --omit=dev' : 'RUN npm ci';
}

function buildDockerignore(services) {
  const hasNode   = services.some(s => s.stack === STACKS.NODE);
  const hasPython = services.some(s => s.stack === STACKS.PYTHON);
  const hasDotnet = services.some(s => s.stack === STACKS.DOTNET);

  const lines = ['.git', '.gitignore', '*.md', '.env', '.env.*', 'Dockerfile', '.dockerignore'];

  if (hasNode)   lines.push('**/node_modules', '**/npm-debug.log', '**/.next', '**/dist', '**/coverage');
  if (hasPython) lines.push('**/__pycache__', '**/*.pyc', '**/.venv', '**/venv', '**/*.egg-info');
  if (hasDotnet) lines.push('**/bin', '**/obj', '**/*.user', '**/TestResults');

  // Explicitly un-exclude all top-level service dirs so existing whitelist dockerignores
  // don't silently block COPY commands. Safe no-op on repos without a whitelist.
  const topLevelServiceDirs = [...new Set(
    services
      .map(s => s.serviceDir.split('/')[0])
      .filter(d => d && d !== '.')
  )];
  if (topLevelServiceDirs.length > 0) {
    lines.push('', '# Ensure service dirs are always in build context');
    topLevelServiceDirs.forEach(d => lines.push(`!${d}/`));
  }

  return lines.join('\n');
}

function nodeDockerignore() {
  return `node_modules
npm-debug.log
yarn-error.log
.pnpm-debug.log
.git
.gitignore
.env
.env.*
!.env.example
!.env.sample
*.md
dist
coverage
.nyc_output
.next
.nuxt
Dockerfile
.dockerignore`.trim();
}

function pythonDockerignore() {
  return `__pycache__
*.pyc
*.pyo
*.pyd
.Python
.venv
venv
env
ENV
.git
.gitignore
.env
.env.*
*.md
*.egg-info
dist
build
.pytest_cache
.mypy_cache
.ruff_cache
Dockerfile
.dockerignore`.trim();
}

function dotnetDockerignore() {
  return `bin
obj
.git
.gitignore
.env
*.md
**/*.user
**/*.suo
.vs
TestResults
Dockerfile
.dockerignore`.trim();
}
module.exports = { generateDockerfile, addPowerDockerfileHeader };
