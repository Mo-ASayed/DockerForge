// Part of the @dockerforge/core engine.
// Checks for common Dockerfile security issues

function hasTaggedImage(image) {
  if (image.includes('@sha256:')) return true;
  const lastSegment = image.split('/').pop() || image;
  return lastSegment.includes(':');
}

function parseEnvAssignments(line) {
  const body = line.replace(/^ENV\s+/, '').trim();
  const assignments = [];
  const pairPattern = /([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s\\]+)/g;
  let match;

  while ((match = pairPattern.exec(body)) !== null) {
    assignments.push({
      key: match[1],
      value: match[2].replace(/^['"]|['"]$/g, ''),
    });
  }

  return assignments;
}

function isSecretLikeEnvKey(key = '') {
  return /(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH|CREDENTIAL|DATABASE_URL|DB_URL|MONGO|REDIS_URL|POSTGRES|JWT|ENCRYPTION|SIGNING_KEY|STRIPE)/i.test(key);
}

function isSecretLikeEnvValue(value = '') {
  return /(?:postgres:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/|redis:\/\/|sk_(?:live|test)_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(value);
}

function securityPass(result, analysis) {
  const notes = [];
  const dockerfile = result.dockerfile;

  // Check 1: Root user
  // nginx handles its own privilege drop internally (master runs as root, workers as nginx).
  // Only skip the USER check when the FINAL runtime stage is an nginx image, not an intermediate builder.
  const fromLines = dockerfile.split('\n').filter(l => /^FROM\s/i.test(l));
  const lastFrom = fromLines[fromLines.length - 1] || '';
  const usesNginxRuntime = /^FROM nginx:/i.test(lastFrom);
  if (!usesNginxRuntime && !/^USER\s+\S+/m.test(dockerfile)) {
    notes.push('⚠️  SECURITY: No USER instruction found - container will run as root. Add a non-root user.');
  }

  // Check 2: Base image pinning
  if (dockerfile.includes(':latest')) {
    notes.push('⚠️  SECURITY: Avoid using :latest tag - pin to a specific version for reproducibility and security.');
  }
  for (const line of dockerfile.split('\n')) {
    const match = line.trim().match(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?$/i);
    if (match && !hasTaggedImage(match[1])) {
      notes.push(`⚠️  SECURITY: Base image has no tag: "${match[1]}" - pin to a specific version.`);
    }
  }

  // Check 3: Secrets in ENV
  const envLines = dockerfile.split('\n').filter(l => l.trim().startsWith('ENV '));
  for (const line of envLines) {
    for (const env of parseEnvAssignments(line.trim())) {
      if (isSecretLikeEnvKey(env.key) || isSecretLikeEnvValue(env.value)) {
        notes.push(`⚠️  SECURITY: Possible secret in ENV instruction: "${env.key}" - use runtime secrets or env files instead.`);
      }
    }
  }

  // Check 4: .env not in dockerignore
  if (result.dockerignore && !result.dockerignore.includes('.env')) {
    notes.push('⚠️  SECURITY: Add .env to .dockerignore to prevent accidentally baking secrets into the image.');
  }

  // Check 5: curl/wget piped to shell
  if (/(?:curl|wget)\s+[^|\n]+\|\s*(?:ba)?sh\b/i.test(dockerfile)) {
    notes.push('⚠️  SECURITY: Detected curl | bash pattern - avoid piping remote scripts directly to a shell.');
  }

  // Check 6: ADD vs COPY
  if (dockerfile.includes('\nADD ') && !dockerfile.includes('ADD http')) {
    notes.push('💡 Use COPY instead of ADD unless you need tar auto-extraction or remote URL support. COPY is more explicit.');
  }

  return notes;
}

module.exports = {
  securityPass,
  isSecretLikeEnvKey,
  isSecretLikeEnvValue,
};
