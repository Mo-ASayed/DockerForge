// Part of the @dockerforge/core engine.
// Takes the same analysisResult shape as generator.js.
// Returns { compose: string, improvements: string[] }
'use strict';

// ── Infra detection patterns ──────────────────────────────────────────────────

const INFRA_PATTERNS = {
  postgres: [
    'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_HOST', 'DB_HOST',
    'DATABASE_HOST', 'POSTGRESQL_URL', 'PG_HOST', 'PGHOST',
  ],
  redis: [
    'REDIS_URL', 'REDIS_HOST', 'REDIS_URI', 'REDIS_TLS_URL',
  ],
  mongo: [
    'MONGO_URI', 'MONGODB_URI', 'MONGODB_URL', 'MONGO_URL', 'MONGO_HOST',
  ],
  rabbitmq: [
    'RABBITMQ_URL', 'AMQP_URL', 'RABBITMQ_HOST',
  ],
};

const INFRA_SERVICES = {
  postgres: {
    name: 'db',
    image: 'postgres:16-alpine',
    ports: ['5432:5432'],
    environment: [
      'POSTGRES_USER=${POSTGRES_USER:?POSTGRES_USER must be set}',
      'POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}',
      'POSTGRES_DB=${POSTGRES_DB:?POSTGRES_DB must be set}',
    ],
    volume: 'postgres_data:/var/lib/postgresql/data',
    volumeName: 'postgres_data',
    healthcheck: {
      test: '["CMD-SHELL", "pg_isready -U postgres"]',
      interval: '5s',
      timeout: '5s',
      retries: 5,
    },
  },
  redis: {
    name: 'redis',
    image: 'redis:7-alpine',
    ports: ['6379:6379'],
    environment: [],
    volume: 'redis_data:/data',
    volumeName: 'redis_data',
    healthcheck: {
      test: '["CMD", "redis-cli", "ping"]',
      interval: '5s',
      timeout: '5s',
      retries: 5,
    },
  },
  mongo: {
    name: 'mongo',
    image: 'mongo:7',
    ports: ['27017:27017'],
    environment: [
      'MONGO_INITDB_ROOT_USERNAME=${MONGO_INITDB_ROOT_USERNAME:?MONGO_INITDB_ROOT_USERNAME must be set}',
      'MONGO_INITDB_ROOT_PASSWORD=${MONGO_INITDB_ROOT_PASSWORD:?MONGO_INITDB_ROOT_PASSWORD must be set}',
    ],
    volume: 'mongo_data:/data/db',
    volumeName: 'mongo_data',
    healthcheck: {
      test: '["CMD", "mongosh", "--eval", "db.adminCommand(\'ping\')"]',
      interval: '10s',
      timeout: '5s',
      retries: 5,
    },
  },
  rabbitmq: {
    name: 'rabbitmq',
    image: 'rabbitmq:3-management-alpine',
    ports: ['5672:5672', '15672:15672'],
    environment: [
      'RABBITMQ_DEFAULT_USER=${RABBITMQ_DEFAULT_USER:?RABBITMQ_DEFAULT_USER must be set}',
      'RABBITMQ_DEFAULT_PASS=${RABBITMQ_DEFAULT_PASS:?RABBITMQ_DEFAULT_PASS must be set}',
    ],
    volume: 'rabbitmq_data:/var/lib/rabbitmq',
    volumeName: 'rabbitmq_data',
    healthcheck: {
      test: '["CMD", "rabbitmq-diagnostics", "ping"]',
      interval: '10s',
      timeout: '5s',
      retries: 5,
    },
  },
};

// ── Env var rewriting ─────────────────────────────────────────────────────────

const INFRA_REWRITES = {
  postgres: {
    DATABASE_URL:      'postgresql://${POSTGRES_USER:?POSTGRES_USER must be set}:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}@db:5432/${POSTGRES_DB:?POSTGRES_DB must be set}',
    POSTGRES_URL:      'postgresql://${POSTGRES_USER:?POSTGRES_USER must be set}:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}@db:5432/${POSTGRES_DB:?POSTGRES_DB must be set}',
    POSTGRES_HOST:     'db',
    DB_HOST:           'db',
    DATABASE_HOST:     'db',
    POSTGRESQL_URL:    'postgresql://${POSTGRES_USER:?POSTGRES_USER must be set}:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}@db:5432/${POSTGRES_DB:?POSTGRES_DB must be set}',
    PG_HOST:           'db',
    PGHOST:            'db',
    PGUSER:            '${POSTGRES_USER:?POSTGRES_USER must be set}',
    PGPASSWORD:        '${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}',
    PGDATABASE:        '${POSTGRES_DB:?POSTGRES_DB must be set}',
    POSTGRES_USER:     '${POSTGRES_USER:?POSTGRES_USER must be set}',
    POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}',
    POSTGRES_DB:       '${POSTGRES_DB:?POSTGRES_DB must be set}',
  },
  redis: {
    REDIS_URL:     'redis://redis:6379',
    REDIS_HOST:    'redis',
    REDIS_URI:     'redis://redis:6379',
    REDIS_TLS_URL: 'redis://redis:6379',
    REDIS_PORT:    '6379',
  },
  mongo: {
    MONGO_URI:                  'mongodb://${MONGO_INITDB_ROOT_USERNAME:?MONGO_INITDB_ROOT_USERNAME must be set}:${MONGO_INITDB_ROOT_PASSWORD:?MONGO_INITDB_ROOT_PASSWORD must be set}@mongo:27017/appdb',
    MONGODB_URI:                'mongodb://${MONGO_INITDB_ROOT_USERNAME:?MONGO_INITDB_ROOT_USERNAME must be set}:${MONGO_INITDB_ROOT_PASSWORD:?MONGO_INITDB_ROOT_PASSWORD must be set}@mongo:27017/appdb',
    MONGODB_URL:                'mongodb://${MONGO_INITDB_ROOT_USERNAME:?MONGO_INITDB_ROOT_USERNAME must be set}:${MONGO_INITDB_ROOT_PASSWORD:?MONGO_INITDB_ROOT_PASSWORD must be set}@mongo:27017/appdb',
    MONGO_URL:                  'mongodb://${MONGO_INITDB_ROOT_USERNAME:?MONGO_INITDB_ROOT_USERNAME must be set}:${MONGO_INITDB_ROOT_PASSWORD:?MONGO_INITDB_ROOT_PASSWORD must be set}@mongo:27017/appdb',
    MONGO_HOST:                 'mongo',
    MONGO_INITDB_ROOT_USERNAME: '${MONGO_INITDB_ROOT_USERNAME:?MONGO_INITDB_ROOT_USERNAME must be set}',
    MONGO_INITDB_ROOT_PASSWORD: '${MONGO_INITDB_ROOT_PASSWORD:?MONGO_INITDB_ROOT_PASSWORD must be set}',
  },
  rabbitmq: {
    RABBITMQ_URL:  'amqp://${RABBITMQ_DEFAULT_USER:?RABBITMQ_DEFAULT_USER must be set}:${RABBITMQ_DEFAULT_PASS:?RABBITMQ_DEFAULT_PASS must be set}@rabbitmq:5672',
    AMQP_URL:      'amqp://guest:guest@rabbitmq:5672',
    RABBITMQ_HOST: 'rabbitmq',
  },
};

// ── Infra detection ───────────────────────────────────────────────────────────

/**
 * @param {Array<{key: string}>} envVars
 * @returns {Set<string>}
 */
function detectInfra(envVars) {
  const found = new Set();
  const keys = new Set(envVars.map(v => v.key));
  for (const [type, patterns] of Object.entries(INFRA_PATTERNS)) {
    if (patterns.some(p => keys.has(p))) {
      found.add(type);
    }
  }
  return found;
}

// ── YAML helpers ──────────────────────────────────────────────────────────────

function indent(str, spaces) {
  const pad = ' '.repeat(spaces);
  return str.split('\n').map(l => (l.trim() === '' ? '' : pad + l)).join('\n');
}

function healthcheckBlock(hc) {
  return [
    `healthcheck:`,
    `  test: ${hc.test}`,
    `  interval: ${hc.interval}`,
    `  timeout: ${hc.timeout}`,
    `  retries: ${hc.retries}`,
  ].join('\n');
}

// ── Rewrite env vars for a service ───────────────────────────────────────────

function buildEnvLines(envVars, detectedInfra) {
  const rewrites = {};
  for (const type of detectedInfra) {
    Object.assign(rewrites, INFRA_REWRITES[type]);
  }

  const lines = [];
  lines.push('NODE_ENV=production');

  for (const { key, value } of envVars) {
    if (key === 'NODE_ENV') continue;
    if (rewrites[key]) {
      lines.push(`${key}=${rewrites[key]}`);
    } else {
      lines.push(`${key}=${value || ''}`);
    }
  }

  return lines;
}

// ── Service name helpers ──────────────────────────────────────────────────────

function serviceNameFromDir(serviceDir) {
  if (!serviceDir || serviceDir === '.') return 'app';
  return serviceDir.replace(/\//g, '-').replace(/[^a-z0-9-]/gi, '').toLowerCase();
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * @param {object} analysisResult — same shape returned by analyseProject
 * @returns {{ compose: string, improvements: string[] }}
 */
function generateCompose({ services, envVars = [], sharedDirs = [] }) {
  const improvements = [];
  const detectedInfra = detectInfra(envVars);

  const appServiceBlocks = [];
  const infraDependencies = [...detectedInfra].map(t => INFRA_SERVICES[t].name);

  for (const svc of services) {
    const name = serviceNameFromDir(svc.serviceDir);

    const envLines = buildEnvLines(envVars, detectedInfra);

    const lines = [
      `${name}:`,
      `  build:`,
      `    context: .`,
      `    dockerfile: Dockerfile`,
    ];

    lines.push(`  ports:`);
    lines.push(`    - "${svc.port}:${svc.port}"`);

    if (envLines.length > 0) {
      lines.push(`  environment:`);
      for (const l of envLines) {
        lines.push(`    - ${l}`);
      }
    }

    if (infraDependencies.length > 0) {
      lines.push(`  depends_on:`);
      for (const dep of infraDependencies) {
        lines.push(`    ${dep}:`);
        lines.push(`      condition: service_healthy`);
      }
    }

    lines.push(`  networks:`);
    lines.push(`    - app-network`);
    lines.push(`  restart: unless-stopped`);

    appServiceBlocks.push(lines.join('\n'));
  }

  const infraServiceBlocks = [];
  const volumeNames = [];

  for (const type of detectedInfra) {
    const cfg = INFRA_SERVICES[type];
    const lines = [
      `${cfg.name}:`,
      `  image: ${cfg.image}`,
    ];

    if (cfg.ports.length > 0) {
      lines.push(`  ports:`);
      for (const p of cfg.ports) {
        lines.push(`    - "${p}"`);
      }
    }

    if (cfg.environment.length > 0) {
      lines.push(`  environment:`);
      for (const e of cfg.environment) {
        lines.push(`    - ${e}`);
      }
    }

    lines.push(`  volumes:`);
    lines.push(`    - ${cfg.volume}`);
    lines.push(indent(healthcheckBlock(cfg.healthcheck), 2));
    lines.push(`  networks:`);
    lines.push(`    - app-network`);
    lines.push(`  restart: unless-stopped`);

    infraServiceBlocks.push(lines.join('\n'));
    volumeNames.push(cfg.volumeName);
  }

  const allBlocks = [...appServiceBlocks, ...infraServiceBlocks];

  let yaml = `# Generated by Dockerforge — https://containerise.dev\n`;
  yaml += `# Run: docker compose up --build\n\n`;
  yaml += `services:\n`;
  for (const block of allBlocks) {
    yaml += indent(block, 2) + '\n\n';
  }

  yaml += `networks:\n`;
  yaml += `  app-network:\n`;
  yaml += `    driver: bridge\n`;

  if (volumeNames.length > 0) {
    yaml += `\nvolumes:\n`;
    for (const v of volumeNames) {
      yaml += `  ${v}:\n`;
    }
  }

  if (detectedInfra.size > 0) {
    improvements.push(`Detected infra from env vars: ${[...detectedInfra].join(', ')} — added as Compose services with healthchecks`);
  }
  if (envVars.some(v => !v.hasDefault)) {
    improvements.push('Some env vars have no default value — fill them in docker-compose.yml before running');
  }
  improvements.push('For production, replace build: with image: tags pointing at your registry');
  if (services.some(s => s.role === 'frontend')) {
    improvements.push('Frontend service: consider adding a reverse proxy (nginx) to route traffic in production');
  }

  return { compose: yaml.trim(), improvements };
}

module.exports = { generateCompose, detectInfra };
