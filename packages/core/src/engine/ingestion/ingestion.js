// Part of the @dockerforge/core engine.
// Fetches repo file tree + key files via provider APIs — no git binary needed.
// Works on Vercel, Railway, Render, etc.

const path = require('path');
const fs = require('fs-extra');
const { IGNORED_DIRS, ROOT_CONFIG_FILES } = require('../constants');

const IGNORED_SET = new Set(IGNORED_DIRS);

const KEY_FILES = [
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile',
  '.python-version', 'Procfile', 'manage.py', 'app.py', 'main.py',
  '.dockerignore', '.env.example', '.env.sample',
  // Node entry points — fetched so the analyser can scan require('../xxx') for sibling deps
  'server.js', 'server.ts', 'index.js', 'index.ts', 'app.js', 'app.ts', 'main.js', 'main.ts',
  // Framework config files — needed to detect buildOutputDir (vite: outDir, next: distDir, etc.)
  'vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.mts',
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'astro.config.js', 'astro.config.mjs', 'astro.config.ts',
  'svelte.config.js', 'svelte.config.ts',
];
const KEY_EXTENSIONS = ['.csproj', '.fsproj'];
const ROOT_CONFIG_SET = new Set(ROOT_CONFIG_FILES);
const TSCONFIG_VARIANT_RE = /^tsconfig\..+\.json$/;
const SOURCE_DIR_NAMES = new Set([
  'src', 'public', 'app', 'pages', 'components', 'lib', 'libs',
  'shared', 'common', 'utils', 'styles', 'assets',
  'backend', 'server', 'api', 'routes', 'controllers', 'services',
  'middleware', 'workers',
]);
const TEXT_SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.json', '.svg', '.txt', '.xml',
  '.yml', '.yaml', '.md', '.mdx',
]);
const FETCH_TIMEOUT_MS = 10_000;
const MAX_INDEXED_PATHS = 5000;
const MAX_ZIP_FILES = 2000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

function validateSubFolder(subFolder) {
  if (!subFolder) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(subFolder);
    for (let i = 0; i < 2 && decoded.includes('%'); i += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new Error('Invalid subfolder path in URL');
  }
  const normalized = decoded.replace(/\\/g, '/');
  if (
    path.isAbsolute(normalized) ||
    normalized.split('/').some(part => part === '..') ||
    normalized.includes('\0')
  ) {
    throw new Error('Invalid subfolder path in URL');
  }
  return normalized.replace(/^\/+|\/+$/g, '');
}

function assertSafeRelativePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path in input');
  }

  const normalized = filePath.replace(/\\/g, '/');
  if (
    path.isAbsolute(normalized) ||
    normalized.split('/').some(part => part === '..') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Unsafe file path rejected: ${filePath}`);
  }

  return normalized.replace(/^\/+/, '');
}

function safeJoin(root, filePath) {
  const safePath = assertSafeRelativePath(filePath);
  const dest = path.resolve(root, safePath);
  const resolvedRoot = path.resolve(root);
  if (dest !== resolvedRoot && !dest.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Unsafe file path rejected: ${filePath}`);
  }
  return dest;
}

function encodePathForUrl(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const promise = Promise.resolve().then(() => mapper(item));
    results.push(promise);
    executing.add(promise);
    promise.finally(() => executing.delete(promise));
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ── URL Normalisation ───────────────────────────────────────
function normaliseGitUrl(rawUrl) {
  const url = rawUrl.trim();
  const rawPath = url.split(/[?#]/)[0];
  if (/(?:^|\/)(?:\.{2}|%2e%2e)(?:\/|$)/i.test(rawPath)) {
    throw new Error('Invalid subfolder path in URL');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Unrecognised URL — only GitHub, GitLab, and Bitbucket are supported (e.g. https://github.com/owner/repo)`);
  }

  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.replace(/^\//, '').split('/');

    if (host === 'github.com') {
      const owner = parts[0];
      const repo  = parts[1]?.replace(/\.git$/, '');
      if (!owner || !repo) {
        throw new Error(`GitHub URL is missing the repository name — use https://github.com/owner/repo`);
      }
      // URL shape: /owner/repo/tree/<branch>[/subfolder/...]
      // parts[2]='tree', parts[3]=branch, parts[4+]=subfolder path
      const branch    = parts[2] === 'tree' ? parts[3] : null;
      const subFolder = validateSubFolder(parts[2] === 'tree' && parts.length > 4
        ? parts.slice(4).join('/')
        : null);
      return { provider: 'github', owner, repo, branch, subFolder };
    }

    if (host === 'gitlab.com') {
      const treeMatch = parsed.pathname.match(/^(.*?)\/-\/tree\/([^/]+)(\/(.+))?$/);
      if (treeMatch) {
        const repoParts = treeMatch[1].replace(/^\//, '').split('/');
        const repo      = repoParts.pop();
        const owner     = repoParts.join('/');
        const branch    = treeMatch[2];
        const subFolder = validateSubFolder(treeMatch[4] || null);
        return { provider: 'gitlab', owner, repo, branch, subFolder };
      }
      const repo = parts[parts.length - 1].replace(/\.git$/, '');
      const owner = parts.slice(0, -1).join('/');
      return { provider: 'gitlab', owner, repo, branch: null, subFolder: null };
    }

    if (host === 'bitbucket.org') {
      const owner = parts[0];
      const repo  = parts[1]?.replace(/\.git$/, '');
      // URL shape: /owner/repo/src/<branch>[/subfolder/...]
      const branch    = parts[2] === 'src' ? parts[3] : null;
      const subFolder = validateSubFolder(parts[2] === 'src' && parts.length > 4
        ? parts.slice(4).join('/')
        : null);
      return { provider: 'bitbucket', owner, repo, branch, subFolder };
    }
  throw new Error(`Unrecognised URL — only GitHub, GitLab, and Bitbucket are supported (e.g. https://github.com/owner/repo)`);
}

// ── Fetch helpers ───────────────────────────────────────────

/**
 * Maps an HTTP error status + URL context into a user-readable message.
 * hasAuth = true when an Authorization / PRIVATE-TOKEN header was sent.
 */
function classifyHttpError(status, url, hasAuth) {
  const isGitHub    = url.includes('api.github.com') || url.includes('raw.githubusercontent.com');
  const isGitLab    = url.includes('gitlab.com');
  const isBitbucket = url.includes('bitbucket.org');
  const provider    = isGitHub    ? 'GitHub'
                    : isGitLab    ? 'GitLab'
                    : isBitbucket ? 'Bitbucket'
                    : 'provider';

  switch (status) {
    case 401:
      return `${provider} authentication required — add an Access Token for private repos`;

    case 403:
      return hasAuth
        ? `${provider} access denied: token may lack "repo" read scope or is expired`
        : `${provider} access denied: this repo is private or you've hit the rate limit. Add an Access Token to continue`;

    case 404:
      return hasAuth
        ? `${provider} repo not found: double-check the URL, branch name, or subfolder path`
        : `${provider} repo not found: if it's private, add an Access Token; otherwise verify the URL is correct`;

    case 409:
      return `${provider} repo is empty: nothing to analyse`;

    case 422:
      return `${provider} rejected the request, check the URL format or branch name`;

    case 429:
      return `${provider} rate limit reached, add an Access Token to increase your quota`;

    default:
      if (status >= 500) return `${provider} server error (${status}) — try again in a moment`;
      return `${provider} returned HTTP ${status} — check the URL and try again`;
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Provider request timed out, try again later');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, headers = {}) {
  const res = await fetchWithTimeout(url, { headers });
  if (!res.ok) {
    const hasAuth = !!(headers['Authorization'] || headers['PRIVATE-TOKEN']);
    throw new Error(classifyHttpError(res.status, url, hasAuth));
  }
  return res.json();
}

async function fetchText(url, headers = {}) {
  const res = await fetchWithTimeout(url, { headers });
  if (!res.ok) return null;
  return res.text();
}

// ── Provider: GitHub ────────────────────────────────────────
async function fetchGitHub({ owner, repo, branch, subFolder }, pat) {
  const headers = { 'User-Agent': 'dockerfile-builder' };
  const token = pat || process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let ref = branch;
  if (!ref) {
    const meta = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, headers);
    ref = meta.default_branch;
  }

  // Always fetch the tree at repo root — subFolder filtering happens below
  const tree = await fetchJson(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, headers
  );
  if (tree.truncated) {
    throw new Error('GitHub repo tree is too large to analyse via API; use a subfolder URL or ZIP upload');
  }

  const prefix   = subFolder ? subFolder + '/' : '';
  const allBlobs = tree.tree.filter(f => f.type === 'blob').map(f => assertSafeRelativePath(f.path));

  // If a subfolder was specified, narrow to only those files and strip the prefix
  // so the analyser sees them as if they were at the project root
  const allPaths = prefix
    ? allBlobs.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length))
    : allBlobs;

  const wanted = allPaths.filter(p => shouldFetchContent(p));
  const files  = {};

  await mapLimit(wanted, 10, async (filePath) => {
    const remotePath = prefix + filePath; // full path in the repo
    const content = await fetchText(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${encodePathForUrl(remotePath)}`, headers
    );
    if (content !== null) files[filePath] = content;
  });

  return { files, allPaths };
}

// ── Provider: GitLab ────────────────────────────────────────
async function fetchGitLab({ owner, repo, branch, subFolder }, pat) {
  const headers = { 'User-Agent': 'dockerfile-builder' };
  const token = pat || process.env.GITLAB_TOKEN;
  if (token) headers['PRIVATE-TOKEN'] = token;

  const encodedNs = encodeURIComponent(`${owner}/${repo}`);
  const baseUrl = `https://gitlab.com/api/v4/projects/${encodedNs}`;

  let ref = branch;
  if (!ref) {
    const meta = await fetchJson(baseUrl, headers);
    ref = meta.default_branch;
  }

  const tree = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await fetchJson(
      `${baseUrl}/repository/tree?recursive=true&ref=${encodeURIComponent(ref)}&per_page=100&page=${page}`,
      headers
    );
    tree.push(...batch);
    if (batch.length < 100 || tree.length >= MAX_INDEXED_PATHS) break;
  }
  if (tree.length >= MAX_INDEXED_PATHS) {
    throw new Error(`GitLab repo tree exceeds ${MAX_INDEXED_PATHS} files; use a subfolder URL to narrow scope`);
  }

  const prefix   = subFolder ? subFolder + '/' : '';
  const allBlobs = tree.filter(f => f.type === 'blob').map(f => assertSafeRelativePath(f.path));

  const allPaths = prefix
    ? allBlobs.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length))
    : allBlobs;

  const wanted = allPaths.filter(p => shouldFetchContent(p));
  const files  = {};

  await mapLimit(wanted, 10, async (filePath) => {
    const remotePath = prefix + filePath;
    const content = await fetchText(
      `${baseUrl}/repository/files/${encodeURIComponent(remotePath)}/raw?ref=${encodeURIComponent(ref)}`, headers
    );
    if (content !== null) files[filePath] = content;
  });

  return { files, allPaths };
}

// ── Provider: Bitbucket ─────────────────────────────────────
async function fetchBitbucket({ owner, repo, branch, subFolder }, pat) {
  const headers = { 'User-Agent': 'dockerfile-builder' };
  const token = pat || process.env.BITBUCKET_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const baseUrl = `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}`;

  let ref = branch;
  if (!ref) {
    const meta = await fetchJson(baseUrl, headers);
    ref = meta.mainbranch?.name || 'main';
  }

  const srcPath = subFolder ? `${ref}/${subFolder}/` : `${ref}/`;
  const values = [];
  let nextUrl = `${baseUrl}/src/${srcPath}?pagelen=100&fields=values.path,values.type,next`;
  while (nextUrl && values.length < MAX_INDEXED_PATHS) {
    const page = await fetchJson(nextUrl, headers);
    values.push(...(page.values || []));
    nextUrl = page.next || null;
  }
  if (values.length >= MAX_INDEXED_PATHS) {
    throw new Error(`Bitbucket repo tree exceeds ${MAX_INDEXED_PATHS} files; use a subfolder URL to narrow scope`);
  }

  const prefix   = subFolder ? subFolder + '/' : '';
  const allBlobs = values.filter(f => f.type === 'commit_file').map(f => assertSafeRelativePath(f.path));

  const allPaths = prefix
    ? allBlobs.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length))
    : allBlobs;

  const wanted = allPaths.filter(p => shouldFetchContent(p));
  const files  = {};

  await mapLimit(wanted, 10, async (filePath) => {
    const remotePath = prefix + filePath;
    const content = await fetchText(`${baseUrl}/src/${encodeURIComponent(ref)}/${encodePathForUrl(remotePath)}`, headers);
    if (content !== null) files[filePath] = content;
  });

  return { files, allPaths };
}

// ── Key file filter ─────────────────────────────────────────
function isKeyFile(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(filePath);
  const parts = filePath.split('/');
  const depth = parts.length;
  if (depth > 6) return false;
  // Block if any directory component (not the filename itself) is ignored
  if (parts.slice(0, -1).some(part => IGNORED_SET.has(part))) return false;
  // Root config files (depth 1-2) are fetched so the analyser gets real content
  // Depth 2 catches e.g. packages/tsconfig.base.json in yarn workspaces
  if (depth <= 2 && ROOT_CONFIG_SET.has(base)) return true;
  if (depth <= 2 && TSCONFIG_VARIANT_RE.test(base)) return true;
  return KEY_FILES.includes(base) || KEY_EXTENSIONS.includes(ext);
}

// ── Main: ingestGitRepo ─────────────────────────────────────
function isBuildSourceFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const parts = filePath.split('/');
  if (parts.length > 10) return false;
  if (!TEXT_SOURCE_EXTENSIONS.has(ext)) return false;
  if (parts.slice(0, -1).some(part => IGNORED_SET.has(part))) return false;
  return parts.slice(0, -1).some(part => SOURCE_DIR_NAMES.has(part));
}

function shouldFetchContent(filePath) {
  return isKeyFile(filePath) || isBuildSourceFile(filePath);
}

async function ingestGitRepo(gitUrl, workDir, pat) {
  const info = normaliseGitUrl(gitUrl);
  console.log(`  Provider: ${info.provider} | ${info.owner}/${info.repo}${info.branch ? ` @ ${info.branch}` : ''}`);

  let result;
  if (info.provider === 'github')         result = await fetchGitHub(info, pat);
  else if (info.provider === 'gitlab')    result = await fetchGitLab(info, pat);
  else if (info.provider === 'bitbucket') result = await fetchBitbucket(info, pat);
  else throw new Error(`Unsupported provider: ${info.provider}`);

  const { files, allPaths } = result;

  if (Object.keys(files).length === 0 && allPaths.length === 0) {
    throw new Error('Could not read repo — check the URL is public, or set a token in .env');
  }

  // Write fetched files to workDir so the analyser reads them normally
  await fs.ensureDir(workDir);
  for (const [filePath, content] of Object.entries(files)) {
    const dest = safeJoin(workDir, filePath);
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, content, 'utf-8');
  }

  // Write empty placeholders for the rest (analyser detects stacks by filename).
  // Skip paths whose directory components are in IGNORED_SET — never materialise
  // example/test/docs directories so the analyser cannot detect them as services.
  for (const filePath of allPaths) {
    const safePath = assertSafeRelativePath(filePath);
    const parts = safePath.split('/');
    if (parts.slice(0, -1).some(part => IGNORED_SET.has(part))) continue;
    const dest = safeJoin(workDir, safePath);
    if (!(await fs.pathExists(dest))) {
      await fs.ensureDir(path.dirname(dest));
      await fs.writeFile(dest, '');
    }
  }

  console.log(`  Fetched ${Object.keys(files).length} key files, ${allPaths.length} total paths indexed`);
  return workDir;
}

// ── Zip Unpack ──────────────────────────────────────────────
async function ingestZip(zipPath, workDir) {
  const AdmZip = require('adm-zip');
  await fs.ensureDir(workDir);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  let fileCount = 0;
  let uncompressedBytes = 0;

  for (const entry of entries) {
    const entryName = assertSafeRelativePath(entry.entryName);
    if (entry.isDirectory) continue;

    fileCount += 1;
    const data = entry.getData();
    uncompressedBytes += data.byteLength;
    if (fileCount > MAX_ZIP_FILES) {
      throw new Error(`ZIP contains too many files; maximum is ${MAX_ZIP_FILES}`);
    }
    if (uncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new Error('ZIP uncompressed size is too large');
    }

    const dest = safeJoin(workDir, entryName);
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, data);
  }

  const rootEntries = await fs.readdir(workDir);
  if (rootEntries.length === 1) {
    const nested = path.join(workDir, rootEntries[0]);
    const stat = await fs.stat(nested);
    if (stat.isDirectory()) {
      const tmp = workDir + '_tmp';
      await fs.move(nested, tmp);
      await fs.remove(workDir);
      await fs.move(tmp, workDir);
    }
  }

  return workDir;
}

// ── Pasted File Tree ────────────────────────────────────────
async function ingestTree(treeText, workDir) {
  await fs.ensureDir(workDir);
  for (const line of treeText.split('\n')) {
    const cleaned = line.replace(/[├└│─]/g, '').replace(/^\s+/, '').trim();
    if (cleaned && !cleaned.endsWith('/')) {
      const filePath = safeJoin(workDir, cleaned);
      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, '');
    }
  }
  return workDir;
}

module.exports = {
  ingestGitRepo,
  ingestZip,
  ingestTree,
  normaliseGitUrl,
  validateSubFolder,
  isKeyFile,
  isBuildSourceFile,
  shouldFetchContent,
};
