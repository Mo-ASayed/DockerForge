'use strict';

const crypto = require('node:crypto');

const DOCKER_HUB_REGISTRIES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

function hasRegistry(firstSegment) {
  return firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost';
}

function parseImageReference(imageRef) {
  const original = String(imageRef || '').trim();
  if (!original) throw new Error('Cannot digest-pin an empty image reference');
  if (original.includes('@sha256:')) {
    throw new Error(`Image is already digest-pinned: ${original}`);
  }

  const parts = original.split('/');
  let registry = 'docker.io';
  let repositoryParts = parts;

  if (parts.length > 1 && hasRegistry(parts[0])) {
    registry = parts[0];
    repositoryParts = parts.slice(1);
  }

  if (!DOCKER_HUB_REGISTRIES.has(registry)) {
    throw new Error(`Digest pinning currently supports Docker Hub images only: ${original}`);
  }

  const last = repositoryParts[repositoryParts.length - 1];
  const tagSeparator = last.lastIndexOf(':');
  if (tagSeparator === -1) {
    throw new Error(`Cannot digest-pin an image without an explicit tag: ${original}`);
  }

  const tag = last.slice(tagSeparator + 1);
  const name = last.slice(0, tagSeparator);
  if (!tag || !name) {
    throw new Error(`Cannot digest-pin an image without an explicit tag: ${original}`);
  }

  const repoParts = [...repositoryParts.slice(0, -1), name];
  const repository = repoParts.length === 1 ? `library/${repoParts[0]}` : repoParts.join('/');

  return {
    original,
    registry: 'docker.io',
    repository,
    tag,
    registryType: 'docker-hub',
  };
}

async function readErrorBody(response) {
  if (typeof response.text !== 'function') return '';
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function resolveDockerHubDigest(imageRef, options = {}) {
  const parsed = parseImageReference(imageRef);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Digest pinning requires fetch support in this Node.js runtime');
  }

  const tokenUrl = new URL('https://auth.docker.io/token');
  tokenUrl.searchParams.set('service', 'registry.docker.io');
  tokenUrl.searchParams.set('scope', `repository:${parsed.repository}:pull`);

  const tokenResponse = await fetchImpl(tokenUrl.toString());
  if (!tokenResponse.ok) {
    const body = await readErrorBody(tokenResponse);
    throw new Error(`Failed to request Docker Hub token for ${imageRef}: ${tokenResponse.status}${body ? ` ${body}` : ''}`);
  }

  const tokenPayload = await tokenResponse.json();
  const token = tokenPayload.token || tokenPayload.access_token;
  if (!token) throw new Error(`Docker Hub token response did not include a token for ${imageRef}`);

  const manifestUrl = `https://registry-1.docker.io/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`;
  const manifestResponse = await fetchImpl(manifestUrl, {
    headers: {
      accept: MANIFEST_ACCEPT,
      authorization: `Bearer ${token}`,
    },
  });

  if (!manifestResponse.ok) {
    const body = await readErrorBody(manifestResponse);
    throw new Error(`Failed to resolve digest for ${imageRef}: ${manifestResponse.status}${body ? ` ${body}` : ''}`);
  }

  const body = Buffer.from(await manifestResponse.arrayBuffer());
  const headerDigest = manifestResponse.headers && typeof manifestResponse.headers.get === 'function'
    ? manifestResponse.headers.get('docker-content-digest')
    : null;
  const digest = headerDigest || `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;

  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new Error(`Registry returned an invalid digest for ${imageRef}: ${digest}`);
  }

  return {
    original: imageRef,
    pinned: `${imageRef}@${digest}`,
    digest,
  };
}

function parseFromLine(line) {
  const match = line.match(/^(\s*FROM\s+)(.+?)(\s*)$/i);
  if (!match) return null;

  const prefix = match[1];
  const rest = match[2].trim();
  const trailing = match[3] || '';
  const tokens = rest.split(/\s+/);
  let index = 0;
  const flags = [];

  while (tokens[index] && tokens[index].startsWith('--')) {
    flags.push(tokens[index]);
    index += 1;
  }

  const image = tokens[index];
  if (!image) return null;

  const suffix = tokens.slice(index + 1).join(' ');
  return { prefix, flags, image, suffix, trailing };
}

function isStageReference(image, stageNames) {
  return stageNames.has(image);
}

function collectStageNames(lines) {
  const names = new Set();
  for (const line of lines) {
    const parsed = parseFromLine(line);
    if (!parsed || !parsed.suffix) continue;
    const aliasMatch = parsed.suffix.match(/^AS\s+(\S+)$/i);
    if (aliasMatch) names.add(aliasMatch[1]);
  }
  return names;
}

async function pinDockerfileDigests(dockerfile, options = {}) {
  const resolveDigest = options.resolveDigest || resolveDockerHubDigest;
  const lines = String(dockerfile || '').split('\n');
  const stageNames = collectStageNames(lines);
  const pinnedImages = [];

  const rewritten = [];
  for (const line of lines) {
    const parsed = parseFromLine(line);
    if (!parsed || isStageReference(parsed.image, stageNames) || parsed.image.includes('@sha256:')) {
      rewritten.push(line);
      continue;
    }

    const resolved = await resolveDigest(parsed.image);
    pinnedImages.push(resolved);

    const chunks = [
      parsed.prefix.trimEnd(),
      ...parsed.flags,
      resolved.pinned,
      parsed.suffix,
    ].filter(Boolean);
    rewritten.push(`${chunks.join(' ')}${parsed.trailing}`);
  }

  return {
    dockerfile: rewritten.join('\n'),
    pinnedImages,
  };
}

module.exports = {
  parseImageReference,
  pinDockerfileDigests,
  resolveDockerHubDigest,
};
