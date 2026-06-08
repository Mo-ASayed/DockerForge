// Part of the @dockerforge/core engine.
// Walks the full project tree, finds every service root, analyses each one.

const path = require('path');
const fs = require('fs-extra');
const { STACKS, DEFAULT_VERSIONS, DEFAULT_PORTS, ROOT_CONFIG_FILES } = require('../constants');

// ── Constants ────────────────────────────────────────────────────────────────

// Dirs that are never service roots
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build',
  '__pycache__', '.pytest_cache', 'bin', 'obj', 'coverage',
  '.venv', 'venv', 'env', '.env', '.idea', '.vscode',
  'public', 'static', 'assets', 'media', '.cache', 'out', '.output',
  // Test infrastructure — fixtures are not real services
  '__tests__', '__mocks__', 'test', 'tests', 'fixtures', 'spec', 'specs',
  // Sample code and documentation — not deployable services
  'examples', 'example', 'samples', 'sample', 'demos', 'demo',
  'docs', 'doc', 'dev-docs', 'documentation', 'storybook-static',
]);

// Dirs at project root that are shared utilities, not services
const SHARED_DIR_NAMES = new Set([
  'shared', 'common', 'lib', 'libs', 'utils', 'core',
  'packages', 'types', 'helpers', 'internal', 'constants',
]);


// Detects root-level config files that exist in the project.
// Returned list is used by the generator to emit explicit COPY commands.
async function findRootConfigFiles(projectPath) {
  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    const fileNames = entries.filter(e => e.isFile()).map(e => e.name);

    const found = ROOT_CONFIG_FILES.filter(f => fileNames.includes(f));

    // Capture additional tsconfig.*.json variants that affect compilation (e.g. tsconfig.paths.json).
    // Exclude dev-only variants used by linters/test runners, not the compiler.
    const DEV_TSCONFIG = /eslint|test|spec|jest|vitest|storybook|lint/i;
    const extraTsconfigs = fileNames.filter(
      f => f.startsWith('tsconfig.') && f.endsWith('.json') && !found.includes(f) && !DEV_TSCONFIG.test(f)
    );

    // Build exclusion set from .dockerignore if present and non-empty.
    // Empty = ingestion placeholder, not a real file.
    const excluded = new Set();
    try {
      const raw = await fs.readFile(path.join(projectPath, '.dockerignore'), 'utf-8');
      if (raw.trim().length > 0) {
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
          const base = path.basename(trimmed);
          if (base && !base.includes('*') && !base.includes('/')) excluded.add(base);
        }
      }
    } catch { /* no .dockerignore */ }

    // Only include files with real content (not empty placeholders) and not excluded by .dockerignore.
    const result = await Promise.all(
      [...found, ...extraTsconfigs].map(async f => {
        if (excluded.has(f)) return null;
        try {
          const { size } = await fs.stat(path.join(projectPath, f));
          return size > 0 ? f : null;
        } catch { return null; }
      })
    );

    return result.filter(Boolean);
  } catch {
    return [];
  }
}

// Reads .env.example or .env.sample and returns variable names that have no default value.
// These are the ones that must be supplied at runtime (ARG/ENV in Dockerfile).
async function findEnvVars(projectPath) {
  for (const name of ['.env.example', '.env.sample']) {
    try {
      const raw = await fs.readFile(path.join(projectPath, name), 'utf-8');
      if (!raw.trim()) continue;
      const vars = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [key, value] = trimmed.split('=');
        if (key && key.trim()) {
          const trimmedValue = value?.trim() || '';
          vars.push({ key: key.trim(), value: trimmedValue, hasDefault: trimmedValue !== '' });
        }
      }
      return vars;
    } catch { /* file not present */ }
  }
  return [];
}

// Deps that indicate a frontend bundle
const FRONTEND_DEPS = new Set([
  'react', 'react-dom', 'vue', '@angular/core', 'next', 'nuxt',
  'svelte', '@sveltejs/kit', 'gatsby', 'remix', '@remix-run/react',
  'astro', 'vite', 'webpack', 'parcel', '@vitejs/plugin-react',
  'solid-js', 'preact',
]);

// Deps that indicate a backend server
const BACKEND_DEPS = new Set([
  'express', 'fastify', 'koa', '@koa/router', 'hapi', '@hapi/hapi',
  'restify', '@nestjs/core', 'adonis', '@adonisjs/core', 'polka',
  'connect', 'http', 'https',
]);

function extractQuotedConfigValue(content, key) {
  const match = content.match(new RegExp(`${key}\\s*:\\s*(['"\`])([^'"\`]+)\\1`));
  return match?.[2] || null;
}

// ── Tree Walker ──────────────────────────────────────────────────────────────

// Lockfiles that confirm a directory is a real managed service, not a stub.
// .NET has no standard lockfile requirement so its list is empty (always passes).
const LOCKFILE_MAP = {
  [STACKS.NODE]:   ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'],
  [STACKS.PYTHON]: [],   // pip projects have no lockfile; poetry/pipenv detected via their own manifests
  [STACKS.DOTNET]: [],
};

function hasLockfile(fileNames, stack) {
  const required = LOCKFILE_MAP[stack] || [];
  return required.length === 0 || required.some(lf => fileNames.includes(lf));
}

// Returns all service root dirs found in the tree, with their detected stack.
// Depth capped at 6 so we don't crawl into infinite nesting.
async function findServiceRoots(projectPath) {
  const roots = new Map(); // absolute dir path → STACKS constant

  const MANIFEST_MAP = {
    'package.json':      STACKS.NODE,
    'requirements.txt':  STACKS.PYTHON,
    'pyproject.toml':    STACKS.PYTHON,
    'setup.py':          STACKS.PYTHON,
    'Pipfile':           STACKS.PYTHON,
  };

  // Read root directory files once to detect workspace lockfiles (shared across workspace members)
  let rootFileNames = [];
  try {
    const rootEntries = await fs.readdir(projectPath, { withFileTypes: true });
    rootFileNames = rootEntries.filter(e => e.isFile()).map(e => e.name);
  } catch { /* skip if unreadable */ }

  const walk = async (dir, depth) => {
    if (depth > 6) return;

    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    const fileNames = entries.filter(e => e.isFile()).map(e => e.name);

    // Check manifests — register as service if:
    // 1. Has own lockfile (standalone package), OR
    // 2. Has manifest + root has lockfile (workspace member) AND has scripts.build or scripts.start
    //    (guards against library packages under packages/ that have no own lockfile and are never run directly)
    for (const [manifest, stack] of Object.entries(MANIFEST_MAP)) {
      if (fileNames.includes(manifest) && !roots.has(dir)) {
        const ownLockfile = hasLockfile(fileNames, stack);
        const rootLockfile = dir !== projectPath && hasLockfile(rootFileNames, stack);
        if (ownLockfile) {
          roots.set(dir, stack);
          break;
        }
        if (rootLockfile) {
          // Only treat as a deployable service if it has a runnable script.
          // Library packages (only main/exports, no scripts) are not services.
          let hasRunnableScript = false;
          if (stack === STACKS.NODE) {
            try {
              const pkg = await fs.readJson(path.join(dir, 'package.json'));
              hasRunnableScript = !!(pkg.scripts?.build || pkg.scripts?.start);
            } catch { /* skip unreadable package.json */ }
          } else {
            // Python / .NET have no script gating — root lockfile alone is sufficient
            hasRunnableScript = true;
          }
          if (hasRunnableScript) {
            roots.set(dir, stack);
            break;
          }
        }
      }
    }
    // .csproj — .NET has no standard lockfile requirement
    if (!roots.has(dir) && fileNames.some(f => f.endsWith('.csproj'))) {
      roots.set(dir, STACKS.DOTNET);
    }

    // Recurse
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        await walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };

  await walk(projectPath, 0);

  // If subdirectory services were found, drop any root-level service.
  // A package.json at project root is usually a Vercel/workspace config, not a runnable service.
  if (roots.size > 1 && roots.has(projectPath)) {
    roots.delete(projectPath);
  }

  return Array.from(roots.entries()).map(([dir, stack]) => ({ dir, stack }));
}

// ── Shared Dir Detection ─────────────────────────────────────────────────────

// Dir names that hold static web assets (no package.json — not a managed service)
const STATIC_DIR_NAMES = new Set([
  'frontend', 'client', 'web', 'ui', 'html', 'www', 'public',
]);

// Finds non-service dirs at project root that look like shared utilities.
async function findSharedDirs(projectPath, serviceRootDirs) {
  const shared = [];
  const staticAssets = [];
  let entries;
  try { entries = await fs.readdir(projectPath, { withFileTypes: true }); }
  catch { return { shared, staticAssets }; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(projectPath, entry.name);
    if (serviceRootDirs.includes(abs)) continue;
    // Skip dirs that are parents of service roots (e.g. "packages/" when services are inside it)
    if (serviceRootDirs.some(srd => srd.startsWith(abs + path.sep))) continue;
    const name = entry.name.toLowerCase();
    if (SHARED_DIR_NAMES.has(name))  shared.push(entry.name);
    if (STATIC_DIR_NAMES.has(name))  staticAssets.push(entry.name);
  }
  return { shared, staticAssets };
}

// ── Role Detection ───────────────────────────────────────────────────────────

// Returns 'frontend' | 'backend' | 'service'
async function detectRole(serviceDir, pkg) {
  const dirName = path.basename(serviceDir).toLowerCase();

  if (/^(frontend|client|web|ui|spa|app)$/.test(dirName)) return 'frontend';
  if (/^(backend|server|api|service|srv)$/.test(dirName))  return 'backend';

  const allDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

  if (allDeps.some(d => FRONTEND_DEPS.has(d))) return 'frontend';
  if (allDeps.some(d => BACKEND_DEPS.has(d)))  return 'backend';

  if (pkg.scripts?.build && !pkg.scripts?.start) return 'frontend';
  if (pkg.scripts?.start)                         return 'backend';

  return 'service';
}

// Dirs that must never appear as part of a deployable service path.
// Mirrors SKIP_DIRS + IGNORED_DIRS — belt-and-suspenders guard after service detection.
const NON_DEPLOYABLE_PATH_PARTS = new Set([
  '__tests__', '__mocks__', 'test', 'tests', 'fixtures', 'spec', 'specs',
  'examples', 'example', 'samples', 'sample', 'demos', 'demo',
  'docs', 'doc', 'dev-docs', 'documentation',
]);

// ── Workspace Member Discovery ───────────────────────────────────────────────

// Reads root package.json "workspaces" field, glob-expands patterns, and returns
// relative paths of all workspace member directories that actually have a package.json
// present in the workdir. Used by the generator to copy ALL workspace package.json
// files before install, ensuring hoisted devDeps (cross-env, vite, etc.) get installed
// even when they live in a non-service package (e.g. packages/excalidraw).
async function findWorkspacePackageDirs(projectPath) {
  try {
    const rootPkg = await fs.readJson(path.join(projectPath, 'package.json'));
    // "workspaces" can be a plain array ["pkg/*"] or an object { packages: ["pkg/*"] }
    let patterns = rootPkg.workspaces;
    if (patterns && !Array.isArray(patterns)) patterns = patterns.packages || [];
    if (!patterns || !patterns.length) return [];

    const dirs = [];
    for (const pattern of patterns) {
      const matches = globSync(pattern, { cwd: projectPath });
      for (const match of matches) {
        const abs = path.join(projectPath, match);
        try {
          const stat = await fs.stat(abs);
          if (!stat.isDirectory()) continue;
          if (!(await fs.pathExists(path.join(abs, 'package.json')))) continue;
          const rel = path.relative(projectPath, abs).replace(/\\/g, '/');
          if (rel && rel !== '.') dirs.push(rel);
        } catch { /* skip inaccessible */ }
      }
    }
    return [...new Set(dirs)];
  } catch {
    return [];
  }
}

async function findWorkspaceSharedConfigs(projectPath, workspacePackageDirs) {
  if (!workspacePackageDirs.length) return [];
  const parentDirs = [...new Set(
    workspacePackageDirs.map(d => path.dirname(d)).filter(d => d !== '.')
  )];
  const result = [];
  for (const parentDir of parentDirs) {
    const absParent = path.join(projectPath, parentDir);
    try {
      const entries = await fs.readdir(absParent, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const base = entry.name;
        if (!ROOT_CONFIG_FILES.includes(base) && !(base.startsWith('tsconfig.') && base.endsWith('.json'))) continue;
        const stat = await fs.stat(path.join(absParent, base));
        if (stat.size === 0) continue;
        result.push(path.join(parentDir, base).replace(/\\/g, '/'));
      }
    } catch { /* skip inaccessible */ }
  }
  return result;
}

// ── Main Entry ───────────────────────────────────────────────────────────────

async function analyseProject(projectPath, hints = {}) {
  const allRoots = await findServiceRoots(projectPath);

  // Drop any service whose relative path contains a non-deployable directory component.
  const roots = allRoots.filter(({ dir }) => {
    const rel = path.relative(projectPath, dir).replace(/\\/g, '/');
    const hasNonDeployable = rel.split('/').some(part => NON_DEPLOYABLE_PATH_PARTS.has(part));
    return !hasNonDeployable;
  });

  if (roots.length === 0) {
    throw new Error(
      'No supported stack found (Node.js, Python, .NET). ' +
      'Check the URL points at a folder containing source code.'
    );
  }

  const serviceRootDirs = roots.map(r => r.dir);
  const { shared: sharedDirs, staticAssets } = await findSharedDirs(projectPath, serviceRootDirs);

  // Detect workspace monorepo — npm/yarn use package.json "workspaces", pnpm uses pnpm-workspace.yaml
  let isWorkspace = false;
  try {
    const rootPkg = await fs.readJson(path.join(projectPath, 'package.json'));
    if (rootPkg.workspaces) isWorkspace = true;
  } catch {}
  if (!isWorkspace) {
    isWorkspace = await fs.pathExists(path.join(projectPath, 'pnpm-workspace.yaml'));
  }

  // Find ALL workspace member dirs that have a package.json in the workdir.
  // These are needed by the generator so it can copy their package.json files before
  // running yarn/npm/pnpm install — without them, workspace-hoisted devDeps (like
  // cross-env, vite, etc.) are never installed and build scripts fail with exit 127.
  const workspacePackageDirs = await findWorkspacePackageDirs(projectPath);
  const workspaceSharedConfigs = await findWorkspaceSharedConfigs(projectPath, workspacePackageDirs);

  const services = [];

  for (const { dir, stack } of roots) {
    const files = getFileList(dir);
    const resolvedStack = hints.stack || stack;

    let analysis;
    if (resolvedStack === STACKS.NODE)   analysis = await analyseNode(dir, files, hints, projectPath, isWorkspace);
    else if (resolvedStack === STACKS.PYTHON) analysis = await analysePython(dir, files, hints);
    else if (resolvedStack === STACKS.DOTNET) analysis = await analyseDotnet(dir, files, hints);
    else continue;

    // Attach location info relative to project root
    analysis.serviceDir    = path.relative(projectPath, dir).replace(/\\/g, '/') || '.';
    analysis.serviceDirAbs = dir;
    services.push(analysis);
  }

  if (services.length === 0) {
    throw new Error('Could not analyse any detected services.');
  }

  // Detect root-level config files for explicit COPY in build stages
  const rootConfigFiles = await findRootConfigFiles(projectPath);

  // Detect required env vars from .env.example or .env.sample
  const envVars = await findEnvVars(projectPath);

  // Detect whitelist-style .dockerignore and surface any service dirs it blocks.
  // Whitelist pattern: first non-comment line is bare `*` (ignore everything),
  // then explicit `!dir/` lines re-include specific paths.
  const dockerignoreBlockedDirs = await findDockerignoreBlockedServiceDirs(projectPath, services);

  return { services, sharedDirs, staticAssets, projectPath, rootConfigFiles, envVars, dockerignoreBlockedDirs, workspacePackageDirs, workspaceSharedConfigs };
}

// Returns top-level service dirs that a whitelist .dockerignore would block.
// Used by the generator to add explicit `!dir/` negation entries and warn the user.
async function findDockerignoreBlockedServiceDirs(projectPath, services) {
  try {
    const raw = await fs.readFile(path.join(projectPath, '.dockerignore'), 'utf-8');
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    // Whitelist pattern: first effective line must be bare `*`
    if (lines[0] !== '*') return [];

    // Collect explicitly allowed top-level dirs from `!dir/` entries
    const allowed = new Set();
    for (const line of lines) {
      const m = line.match(/^!([^/]+)\/?$/);
      if (m) allowed.add(m[1]);
    }

    // Find top-level dirs of each service that are NOT in the allowed set
    const blocked = new Set();
    for (const s of services) {
      const topDir = s.serviceDir.split('/')[0];
      if (topDir && topDir !== '.' && !allowed.has(topDir)) {
        blocked.add(topDir);
      }
    }

    return [...blocked];
  } catch {
    return [];
  }
}

// ── Node.js Analysis ─────────────────────────────────────────────────────────

async function analyseNode(projectPath, files, hints, projectRootPath = null, isWorkspace = false) {
  const assumptions = [];
  const pkgPath = path.join(projectPath, 'package.json');
  let pkg = {};
  let allPackageDeps = {};
  let hasScopedPackages = false;

  try { pkg = await fs.readJson(pkgPath); }
  catch { assumptions.push('Could not read package.json, using defaults'); }

  allPackageDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
  hasScopedPackages = Object.keys(allPackageDeps).some(dep => dep.startsWith('@'));
  if (hasScopedPackages) {
    assumptions.push('Scoped packages detected - if any are private, pass an npmrc secret with docker build --secret id=npmrc,src=.npmrc');
  }

  // Version
  let version = hints.runtimeVersion;
  if (!version) {
    version = pkg?.engines?.node?.replace(/[^0-9.]/g, '').split('.')[0];
    if (!version) {
      version = DEFAULT_VERSIONS[STACKS.NODE];
      assumptions.push(`No engines.node found, defaulted to Node ${version}`);
    }
  }

  // Package manager + lock file location
  // For monorepos (workspace or not), the lock file often lives at project root, not in the package.
  // Strategy: check service dir first, then fall back to project root unconditionally.
  //
  // IMPORTANT: only check top-level files for lockfile detection. The recursive `files` list
  // contains every file in the subtree — including __tests__/fixtures — so a yarn.lock inside
  // a fixture would otherwise be detected as the service's own lockfile.
  const topLevelFileNames = files
    .filter(f => path.dirname(f) === projectPath)
    .map(f => path.basename(f));
  let packageManager = hints.packageManager;
  let lockFileAtRoot = false;

  if (!packageManager) {
    // Check service directory first (top-level only)
    if (topLevelFileNames.includes('pnpm-lock.yaml'))         packageManager = 'pnpm';
    else if (topLevelFileNames.includes('yarn.lock'))         packageManager = 'yarn';
    else if (topLevelFileNames.includes('package-lock.json')) packageManager = 'npm';

    // Not found in service dir — check project root.
    // Covers: npm workspaces, yarn workspaces, pnpm workspaces, and any repo
    // where the lock file simply lives at the top level.
    if (!packageManager && projectRootPath && projectRootPath !== projectPath) {
      try {
        const rootEntries = await fs.readdir(projectRootPath);
        if (rootEntries.includes('pnpm-lock.yaml'))         { packageManager = 'pnpm'; lockFileAtRoot = true; }
        else if (rootEntries.includes('yarn.lock'))         { packageManager = 'yarn'; lockFileAtRoot = true; }
        else if (rootEntries.includes('package-lock.json')) { packageManager = 'npm';  lockFileAtRoot = true; }
      } catch {}
    }

    packageManager = packageManager || 'npm';
  }

  // Lock file
  const lockFile =
    packageManager === 'pnpm' ? 'pnpm-lock.yaml' :
    packageManager === 'yarn' ? 'yarn.lock' :
    'package-lock.json';

  // Entry point — prefer explicit hint, then main, then parse start script
  let entryPoint = hints.entryPoint || pkg.main || 'index.js';
  const rawStartScript = pkg.scripts?.start || '';
  const nodeStartMatch = rawStartScript.match(/node\s+([\w./\-]+(?:\.js)?)/);
  if (nodeStartMatch) entryPoint = nodeStartMatch[1];

  // Build step
  const hasBuild     = !!(pkg.scripts?.build);
  const buildCommand = hasBuild ? `${packageManager} run build` : null;

  // Build output directory — detect framework-specific output paths
  let buildOutputDir = 'dist';
  let framework = null;
  // Root-level dirs referenced by vite config via '../dirname' imports.
  // Must be copied into build context before `vite build` runs.
  const rootBuildDeps = [];
  if (hasBuild) {
    const buildScript = pkg.scripts.build || '';
    if (buildScript.includes('react-scripts'))  { buildOutputDir = 'build'; framework = 'cra'; }
    else if (buildScript.includes('next build')) { buildOutputDir = '.next'; framework = 'nextjs'; }
    else if (buildScript.includes('nest build')) { buildOutputDir = 'dist'; framework = 'nestjs'; }
    else if (buildScript.includes('vite build')) { buildOutputDir = 'dist'; framework = 'vite'; }
    else if (buildScript.includes('remix build')) { buildOutputDir = 'build'; framework = 'remix'; }
    else if (buildScript.includes('astro build')) { buildOutputDir = 'dist'; framework = 'astro'; }
    else if (buildScript.includes('svelte-kit build') || buildScript.includes('vite build')) { buildOutputDir = 'build'; framework = 'sveltekit'; }
  }

  // Also detect framework via dependencies when build script is custom
  if (!framework) {
    const allDeps = allPackageDeps;
    if (allDeps['@nestjs/core']) framework = 'nestjs';
    else if (allDeps['vite']) { buildOutputDir = 'dist'; framework = 'vite'; }
    else if (allDeps['remix']) { buildOutputDir = 'build'; framework = 'remix'; }
    else if (allDeps['astro']) { buildOutputDir = 'dist'; framework = 'astro'; }
    else if (allDeps['@sveltejs/kit']) { buildOutputDir = 'build'; framework = 'sveltekit'; }
  }
  
  // Filesystem-based framework detection — catches cases where build script is indirect
  // (e.g. yarn build:app) and dep-based detection fails.
  if (!framework) {
    const viteConfigs = ['vite.config.mts', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
    for (const f of viteConfigs) {
      if (await fs.pathExists(path.join(projectPath, f))) {
        framework = 'vite';
        buildOutputDir = 'dist'; // will be overridden below by config read
        break;
      }
      // Fallback: check projectRootPath (monorepo vite config at root)
      if (!framework && projectRootPath && projectRootPath !== projectPath) {
        if (await fs.pathExists(path.join(projectRootPath, f))) {
          framework = 'vite';
          buildOutputDir = 'dist'; // will be overridden below by config read
          break;
        }
      }
    }
  }

  // Read config files to override defaults with actual configured output directories.
  // Must use serviceDir (= projectPath in this function), NOT projectRootPath —
  // in a monorepo these are different directories and the config lives in the service.
  const serviceDir = projectPath;

  if (framework === 'vite') {
    const viteConfigNames = ['vite.config.mts', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
    for (const configFile of viteConfigNames) {
      try {
        const configPath = path.join(serviceDir, configFile);
        if (await fs.pathExists(configPath)) {
          const content = await fs.readFile(configPath, 'utf-8');

          // Detect '../dirname' imports — root-level dirs needed at build time
          const relImportRe = /from\s+['"]\.\.\/([^/'"]+)/g;
          let relMatch;
          while ((relMatch = relImportRe.exec(content)) !== null) {
            const dep = relMatch[1];
            if (!rootBuildDeps.includes(dep)) rootBuildDeps.push(dep);
          }

          const val = extractQuotedConfigValue(content, 'outDir');
          if (val && val.length > 0 && val.length < 40) {
            buildOutputDir = val;
          }
          if (buildOutputDir !== 'dist') break;
        }
      } catch (e) { /* skip unreadable config */ }
    }
    // Fallback: check projectRootPath if not found in serviceDir (works for both monorepo and single-root)
    if (buildOutputDir === 'dist' && projectRootPath) {
      for (const configFile of viteConfigNames) {
        try {
          const configPath = path.join(projectRootPath, configFile);
          const exists = await fs.pathExists(configPath);

          if (exists) {
            const content = await fs.readFile(configPath, 'utf-8');

            const val = extractQuotedConfigValue(content, 'outDir');
            if (val && val.length > 0 && val.length < 40) {
              buildOutputDir = val;
            }
            if (buildOutputDir !== 'dist') break;
          }
        } catch (e) { /* skip unreadable config */ }
      }
    }
  } else if (framework === 'nextjs') {
    try {
      const configPath = path.join(serviceDir, 'next.config.js');
      if (await fs.pathExists(configPath)) {
        const content = await fs.readFile(configPath, 'utf-8');
        const match = content.match(/distDir\s*:\s*['"]([^'"]+)['"]/);
        if (match && match[1]) buildOutputDir = match[1];
      }
    } catch { /* skip on error */ }
  } else if (framework === 'astro') {
    const astroConfigNames = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'];
    for (const configFile of astroConfigNames) {
      try {
        const configPath = path.join(serviceDir, configFile);
        if (await fs.pathExists(configPath)) {
          const content = await fs.readFile(configPath, 'utf-8');
          const match = content.match(/outDir\s*:\s*new\s+URL\(['"]([^'"]+)['"]/);
          if (match && match[1]) { buildOutputDir = match[1]; break; }
        }
      } catch { /* skip on error */ }
    }
  } else if (framework === 'sveltekit') {
    try {
      const configPath = path.join(serviceDir, 'svelte.config.js');
      if (await fs.pathExists(configPath)) {
        const content = await fs.readFile(configPath, 'utf-8');
        const match = content.match(/outDir\s*:\s*['"]([^'"]+)['"]/);
        if (match && match[1]) buildOutputDir = match[1];
      }
    } catch { /* skip on error */ }
  } else if (framework === 'remix') {
    try {
      const configPath = path.join(serviceDir, 'remix.config.js');
      if (await fs.pathExists(configPath)) {
        const content = await fs.readFile(configPath, 'utf-8');
        const match = content.match(/assetsBuildDirectory\s*:\s*['"]([^'"]+)['"]/);
        if (match && match[1]) buildOutputDir = match[1];
      }
    } catch { /* skip on error */ }
  }

  // Port
  let port = hints.port;
  if (!port) {
    const portMatch = rawStartScript.match(/PORT[=\s]+(\d+)/);
    port = portMatch ? parseInt(portMatch[1]) : DEFAULT_PORTS[STACKS.NODE];
    if (!portMatch) assumptions.push(`Port not found in scripts, defaulted to ${port}`);
  }

  // Docker CMD — detect whether runtime needs 'node <file>' or 'npm run <script>'
  // Direct node invocation is preferred (better signal handling, no npm overhead)
  // but many production scripts use npm/yarn run for env setup, cross-env, etc.
  let startCmd;
  const npmRunMatch = rawStartScript.match(/^(?:npm\s+run|yarn\s+run|pnpm\s+run)\s+(\S+)/);
  if (hints.entryPoint) {
    startCmd = ['node', hints.entryPoint];
  } else if (nodeStartMatch) {
    startCmd = ['node', nodeStartMatch[1]];
  } else if (npmRunMatch) {
    const scriptName = npmRunMatch[1];
    startCmd = packageManager === 'yarn' ? ['yarn', scriptName]
      : packageManager === 'pnpm'        ? ['pnpm', 'run', scriptName]
      :                                    ['npm', 'run', scriptName];
  } else if (rawStartScript) {
    // Complex script (cross-env, concurrently, etc.) — wrap with package manager
    startCmd = packageManager === 'yarn' ? ['yarn', 'start']
      : packageManager === 'pnpm'        ? ['pnpm', 'run', 'start']
      :                                    ['npm', 'run', 'start'];
  } else {
    startCmd = ['node', entryPoint];
  }

  // NestJS: runtime must use compiled dist, not the dev CLI (nest start)
  if (framework === 'nestjs' && hasBuild && !hints.entryPoint) {
    const prodScript = pkg.scripts?.['start:prod'] || '';
    const prodNodeMatch = prodScript.match(/node\s+([\w./\-]+(?:\.js)?)/);
    startCmd = prodNodeMatch ? ['node', prodNodeMatch[1]] : ['node', 'dist/main.js'];
  }

  // Install command
  const installCmd =
    packageManager === 'pnpm' ? 'pnpm install --frozen-lockfile' :
    packageManager === 'yarn' ? 'yarn install --frozen-lockfile' :
    'npm ci';

  // Role
  const role = await detectRole(projectPath, pkg);

  // Detect which conventional source directories actually exist on disk, so the
  // generator copies real directories instead of guessing the layout (e.g. app/ vs src/).
  const SOURCE_DIR_CANDIDATES = [
    'src', 'app', 'pages', 'components', 'lib', 'styles',
    'public', 'server', 'config', 'content', 'i18n', 'locales', 'hooks', 'utils',
  ];
  const sourceDirs = [];
  for (const d of SOURCE_DIR_CANDIDATES) {
    try { if ((await fs.stat(path.join(projectPath, d))).isDirectory()) sourceDirs.push(d); }
    catch { /* absent */ }
  }

  // Detect framework build/runtime config files that exist, so we copy real filenames
  // instead of guessing a single hard-coded one. Next.js also reads its config at runtime.
  const FRAMEWORK_CONFIG_CANDIDATES = [
    'next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts',
    'tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs',
    'components.json', 'jsconfig.json',
    'remix.config.js', 'svelte.config.js', 'nuxt.config.ts', 'nuxt.config.js',
  ];
  const frameworkConfigFiles = [];
  for (const f of FRAMEWORK_CONFIG_CANDIDATES) {
    try { if ((await fs.stat(path.join(projectPath, f))).isFile()) frameworkConfigFiles.push(f); }
    catch { /* absent */ }
  }
  // The config Next.js reads on `next start` (first match wins) — must be in the runtime image.
  const nextRuntimeConfig = framework === 'nextjs'
    ? (frameworkConfigFiles.find(f => f.startsWith('next.config.')) || null)
    : null;

  // Detect sibling directories referenced via require('../xxx') in the entry point.
  // These are root-level dirs that sit alongside the service dir and must be COPYed
  // into the image so cross-directory requires resolve at runtime.
  const siblingDeps = await detectSiblingDeps(projectPath, projectRootPath, entryPoint);

  return {
    stack: STACKS.NODE,
    role,
    version,
    packageManager,
    entryPoint,
    hasBuild,
    buildCommand,
    framework,       // 'cra' | 'nextjs' | null
    buildOutputDir,  // 'dist' | 'build' | '.next' — where npm run build writes output
    startCmd,        // array form for Docker CMD, e.g. ['node','dist/index.js'] or ['npm','run','start:prod']
    port,
    installCmd,
    lockFile,
    lockFileAtRoot,  // true when lock file lives at project root (monorepo/workspace pattern)
    isWorkspace,     // true when formal workspace (npm/yarn/pnpm) — used for scoped install cmds
    rootBuildDeps,   // root-level dirs imported by vite config via '../dirname' — must be copied before build
    hasScopedPackages,
    siblingDeps,     // root-level dirs referenced via require('../xxx') — must be COPYed into runtime image
    sourceDirs,           // conventional source dirs that actually exist on disk (real, not guessed)
    frameworkConfigFiles, // framework build/runtime config files present (next.config, tailwind.config, ...)
    nextRuntimeConfig,    // the next.config.* file Next.js reads at runtime, or null
    assumptions,
  };
}

// ── Python Analysis ──────────────────────────────────────────────────────────

function modulePathFromPythonFile(projectPath, filePath) {
  const rel = path.relative(projectPath, filePath).replace(/\\/g, '/').replace(/\.py$/, '');
  const parts = rel.split('/').filter(Boolean);
  if (parts[parts.length - 1] === '__init__') parts.pop();
  return parts.join('.');
}

async function readPythonDependencyText(projectPath, fileNames) {
  const candidates = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'];
  const chunks = [];

  for (const fileName of candidates) {
    if (!fileNames.includes(fileName)) continue;
    const content = await fs.readFile(path.join(projectPath, fileName), 'utf-8').catch(() => '');
    if (content) chunks.push(content);
  }

  return chunks.join('\n').toLowerCase();
}

function detectPythonNativeDeps(dependencyText) {
  const nativePackages = [
    'psycopg2', 'psycopg2-binary', 'numpy', 'pillow', 'lxml',
    'cryptography', 'mysqlclient', 'pycurl', 'scipy', 'pandas',
    'orjson', 'uvloop', 'grpcio', 'pydantic-core', 'aiohttp',
    'greenlet', 'gevent', 'brotli', 'brotlicffi', 'shapely',
    'regex', 'cffi', 'tokenizers', 'transformers',
  ];
  const nativeBuildSystems = ['maturin', 'setuptools-rust', 'cython'];
  const nativeDeps = nativePackages.filter(pkg => {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_.-])${escaped}([^a-z0-9_.-]|$)`, 'i').test(dependencyText);
  });
  for (const pkg of nativeBuildSystems) {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9_.-])${escaped}([^a-z0-9_.-]|$)`, 'i').test(dependencyText)) {
      nativeDeps.push(pkg);
    }
  }
  return nativeDeps;
}

function detectRequirementsHashes(dependencyText) {
  return /--hash=sha256:/i.test(dependencyText);
}

async function findDjangoDirs(projectPath, files) {
  const dirs = new Set();
  for (const filePath of files) {
    if (!filePath.endsWith('.py')) continue;
    const rel = path.relative(projectPath, filePath).replace(/\\/g, '/');
    const parts = rel.split('/');
    if (parts.length < 2) continue;
    const fileName = parts[parts.length - 1];
    if (!['apps.py', 'models.py', 'views.py', 'wsgi.py', 'asgi.py', 'settings.py'].includes(fileName)) continue;
    const topDir = parts[0];
    if (topDir && !topDir.startsWith('.') && !SKIP_DIRS.has(topDir)) dirs.add(topDir);
  }
  return [...dirs].sort();
}

async function findDotnetSourceDirs(projectPath) {
  const common = [
    'Controllers', 'Services', 'Models', 'Pages', 'Views', 'Repositories',
    'Data', 'Middleware', 'Handlers', 'Features', 'Dtos', 'DTOs',
  ];
  const found = [];
  for (const dir of common) {
    try {
      const abs = path.join(projectPath, dir);
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) found.push(dir);
    } catch { /* absent */ }
  }
  return found;
}

async function readPythonFile(filePath) {
  return fs.readFile(filePath, 'utf-8').catch(() => '');
}

function sortPythonAppCandidates(projectPath, files) {
  const rank = filePath => {
    const rel = path.relative(projectPath, filePath).replace(/\\/g, '/');
    const base = path.basename(filePath);
    if (base === 'wsgi.py') return 0;
    if (base === 'asgi.py') return 1;
    if (base === 'app.py') return 2;
    if (base === 'main.py') return 3;
    if (base === 'application.py') return 4;
    if (base === '__init__.py') return 5;
    return rel.split('/').length + 10;
  };

  return files
    .filter(f => f.endsWith('.py'))
    .sort((a, b) => rank(a) - rank(b));
}

async function detectDjangoTarget(projectPath, files) {
  const managePath = path.join(projectPath, 'manage.py');
  if (await fs.pathExists(managePath)) {
    const manageContent = await readPythonFile(managePath);
    const settingsMatch = manageContent.match(/DJANGO_SETTINGS_MODULE['"]\s*,\s*['"]([^'"]+)['"]/);
    if (settingsMatch?.[1]) {
      const wsgiModule = settingsMatch[1].replace(/\.settings(?:\.[\w.]+)?$/, '.wsgi');
      return `${wsgiModule}:application`;
    }
  }

  for (const filePath of sortPythonAppCandidates(projectPath, files)) {
    if (path.basename(filePath) !== 'wsgi.py') continue;
    const content = await readPythonFile(filePath);
    if (!content.includes('get_wsgi_application')) continue;
    const modulePath = modulePathFromPythonFile(projectPath, filePath);
    if (modulePath) return `${modulePath}:application`;
  }

  return null;
}

async function detectFlaskTarget(projectPath, files) {
  for (const filePath of sortPythonAppCandidates(projectPath, files)) {
    const content = await readPythonFile(filePath);
    if (!content.includes('Flask')) continue;
    const modulePath = modulePathFromPythonFile(projectPath, filePath);
    if (!modulePath) continue;

    const variableMatch = content.match(/^([A-Za-z_]\w*)\s*=\s*Flask\s*\(/m);
    if (variableMatch?.[1]) return `${modulePath}:${variableMatch[1]}`;

    const factoryMatch = content.match(/^def\s+((?:create|make)_app)\s*\(/m);
    if (factoryMatch?.[1]) return `${modulePath}:${factoryMatch[1]}()`;
  }

  return null;
}

async function detectFastApiTarget(projectPath, files) {
  for (const filePath of sortPythonAppCandidates(projectPath, files)) {
    const content = await readPythonFile(filePath);
    if (!content.includes('FastAPI')) continue;
    const modulePath = modulePathFromPythonFile(projectPath, filePath);
    if (!modulePath) continue;

    const variableMatch = content.match(/^([A-Za-z_]\w*)\s*=\s*FastAPI\s*\(/m);
    if (variableMatch?.[1]) return `${modulePath}:${variableMatch[1]}`;
  }

  return null;
}

async function detectPythonFramework(projectPath, files, dependencyText) {
  if (/\bdjango\b/.test(dependencyText)) return 'django';
  if (/\bfastapi\b/.test(dependencyText)) return 'fastapi';
  if (/\bflask\b/.test(dependencyText)) return 'flask';

  if (await fs.pathExists(path.join(projectPath, 'manage.py'))) return 'django';

  for (const filePath of sortPythonAppCandidates(projectPath, files)) {
    const content = await readPythonFile(filePath);
    if (content.includes('FastAPI(')) return 'fastapi';
    if (content.includes('Flask(')) return 'flask';
    if (content.includes('DJANGO_SETTINGS_MODULE') || content.includes('get_wsgi_application')) return 'django';
  }

  return null;
}

async function analysePython(projectPath, files, hints) {
  const assumptions = [];
  const fileNames = files.map(f => path.basename(f));

  let version = hints.runtimeVersion;
  if (!version) {
    const pvPath = path.join(projectPath, '.python-version');
    if (await fs.pathExists(pvPath)) {
      version = (await fs.readFile(pvPath, 'utf-8')).trim().split('.').slice(0, 2).join('.');
    }
    if (!version && fileNames.includes('pyproject.toml')) {
      const content = await fs.readFile(path.join(projectPath, 'pyproject.toml'), 'utf-8');
      const match = content.match(/python\s*=\s*["'^>=~]+([0-9.]+)/);
      if (match) version = match[1].split('.').slice(0, 2).join('.');
    }
    if (!version) {
      version = DEFAULT_VERSIONS[STACKS.PYTHON];
      assumptions.push(`Python version not found, defaulted to ${version}`);
    }
  }

  let packageManager = hints.packageManager || 'pip';
  let requirementsFile = 'requirements.txt';
  let installCmd = 'pip install --no-cache-dir -r requirements.txt';

  if (fileNames.includes('Pipfile')) {
    packageManager = 'pipenv';
    installCmd = 'pipenv install --system --deploy';
  } else if (fileNames.includes('pyproject.toml')) {
    const content = await fs.readFile(path.join(projectPath, 'pyproject.toml'), 'utf-8');
    if (content.includes('[tool.poetry]')) {
      packageManager = 'poetry';
      installCmd = 'pip install poetry && poetry install --no-dev';
    }
  }

  const dependencyText = await readPythonDependencyText(projectPath, fileNames);
  const nativeDeps = detectPythonNativeDeps(dependencyText);
  const hasNativeDeps = nativeDeps.length > 0;
  const requirementsHasHashes = detectRequirementsHashes(dependencyText);
  let framework = await detectPythonFramework(projectPath, files, dependencyText);
  const djangoAppDirs = framework === 'django' ? await findDjangoDirs(projectPath, files) : [];
  let entryPoint = hints.entryPoint;

  if (!entryPoint) {
    if (framework === 'django' && fileNames.includes('manage.py')) entryPoint = 'manage.py';
    else if (fileNames.includes('main.py')) entryPoint = 'main.py';
    else if (fileNames.includes('app.py'))  entryPoint = 'app.py';
    else {
      entryPoint = 'main.py';
      assumptions.push('Entry point not found — defaulted to main.py');
    }
  }

  const port = hints.port || DEFAULT_PORTS[STACKS.PYTHON];

  let startCmd;
  let appTarget = null;
  if (framework === 'django') {
    appTarget = await detectDjangoTarget(projectPath, files);
    if (!appTarget) {
      appTarget = 'app.wsgi:application';
      assumptions.push('Django project module not detected - using app.wsgi:application; update this to your project package if needed');
    }
    startCmd = ['gunicorn', appTarget, '--bind', `0.0.0.0:${port}`];
  } else if (framework === 'fastapi') {
    appTarget = await detectFastApiTarget(projectPath, files);
    if (!appTarget) {
      appTarget = 'main:app';
      assumptions.push('FastAPI app target not detected - using main:app; update this if your app uses a different module or variable');
    }
    startCmd = ['uvicorn', appTarget, '--host', '0.0.0.0', '--port', String(port), '--workers', '4'];
  } else if (framework === 'flask') {
    appTarget = await detectFlaskTarget(projectPath, files);
    if (!appTarget) {
      const moduleName = path.basename(entryPoint, path.extname(entryPoint));
      appTarget = `${moduleName}:app`;
      assumptions.push('Flask app target not detected - using app variable on the entry point; update the Gunicorn target if needed');
    }
    startCmd = ['gunicorn', appTarget, '--bind', `0.0.0.0:${port}`];
  } else {
    startCmd = ['python', entryPoint];
  }

  const needsGunicornInstall =
    ['django', 'flask'].includes(framework) &&
    !dependencyText.includes('gunicorn');

  return {
    stack: STACKS.PYTHON,
    role: 'backend',
    version,
    packageManager,
    requirementsFile,
    installCmd,
    entryPoint,
    appTarget,
    startCmd,
    framework,
    needsGunicornInstall,
    hasNativeDeps,
    nativeDeps,
    requirementsHasHashes,
    djangoAppDirs,
    port,
    hasBuild: hasNativeDeps,
    assumptions,
  };
}

// ── .NET Analysis ────────────────────────────────────────────────────────────

async function analyseDotnet(projectPath, files, hints) {
  const assumptions = [];

  const csprojFiles = files.filter(f => f.endsWith('.csproj'));
  const csprojPath = csprojFiles[0];
  let csprojContent = '';

  try { csprojContent = await fs.readFile(csprojPath, 'utf-8'); }
  catch { assumptions.push('Could not read .csproj, using defaults'); }

  let version = hints.runtimeVersion;
  if (!version) {
    const match = csprojContent.match(/<TargetFramework>net([0-9.]+)<\/TargetFramework>/);
    if (match) { version = match[1]; }
    else {
      version = DEFAULT_VERSIONS[STACKS.DOTNET];
      assumptions.push(`TargetFramework not found, defaulted to .NET ${version}`);
    }
  }

  const projectName = path.basename(csprojPath, '.csproj');
  const isWebApp = csprojContent.includes('Microsoft.NET.Sdk.Web') || csprojContent.includes('Aspnet');
  const port = hints.port || DEFAULT_PORTS[STACKS.DOTNET];
  const dotnetSourceDirs = await findDotnetSourceDirs(projectPath);

  return {
    stack: STACKS.DOTNET,
    role: 'backend',
    version,
    projectName,
    csprojPath: path.relative(projectPath, csprojPath),
    isWebApp,
    dotnetSourceDirs,
    port,
    hasBuild: true,
    assumptions,
  };
}

// ── File List Helper ─────────────────────────────────────────────────────────

const { globSync } = require('glob');

// Scans common entry point files in a service directory for require('../xxx') and
// import ... from '../xxx' patterns. Returns a sorted list of unique top-level
// sibling directory names that exist at the project root — these must be COPYed
// into the image so that cross-directory requires resolve at runtime.
async function detectSiblingDeps(serviceDir, projectRootPath, entryPoint) {
  if (!projectRootPath) return [];
  const rel = path.relative(projectRootPath, serviceDir).replace(/\\/g, '/');
  // Only handle services exactly one level deep — deeper nesting has more complex relative paths
  if (!rel || rel === '.' || rel.includes('/')) return [];

  const candidateFiles = [...new Set([
    path.join(serviceDir, entryPoint || 'index.js'),
    path.join(serviceDir, 'server.js'),
    path.join(serviceDir, 'server.ts'),
    path.join(serviceDir, 'app.js'),
    path.join(serviceDir, 'index.js'),
    path.join(serviceDir, 'main.js'),
  ])];

  const siblingDirs = new Set();
  // Matches: require('../dirname') or require('../dirname/anything')
  const requireRe = /require\(['"]\.\.\/([^/'"]+)/g;
  // Matches: import ... from '../dirname' or import ... from '../dirname/anything'
  const importRe = /from\s+['"]\.\.\/([^/'"]+)/g;

  for (const filePath of candidateFiles) {
    const content = await fs.readFile(filePath, 'utf-8').catch(() => null);
    if (!content) continue;
    for (const re of [requireRe, importRe]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(content)) !== null) {
        siblingDirs.add(match[1]);
      }
    }
  }

  // Filter to dirs that actually exist at the project root
  const result = [];
  for (const dir of siblingDirs) {
    try {
      const stat = await fs.stat(path.join(projectRootPath, dir));
      if (stat.isDirectory()) result.push(dir);
    } catch { /* doesn't exist or not a dir — skip */ }
  }
  return result.sort();
}

function getFileList(projectPath) {
  return globSync('**/*', {
    cwd: projectPath,
    nodir: false,
    absolute: true,
    ignore: [
      '**/node_modules/**', '**/.git/**', '**/bin/**', '**/obj/**',
      '**/__tests__/**', '**/__mocks__/**', '**/test/**', '**/tests/**',
      '**/fixtures/**', '**/spec/**', '**/specs/**',
      '**/examples/**', '**/example/**', '**/samples/**', '**/sample/**',
      '**/demos/**', '**/demo/**', '**/docs/**', '**/doc/**',
      '**/dev-docs/**', '**/documentation/**', '**/storybook-static/**',
    ],
  });
}

module.exports = { analyseProject, findRootConfigFiles, analyseNode };
