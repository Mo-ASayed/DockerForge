// constants.js (DockerForge engine shared constants)
// Shared between frontend and backend

const STACKS = {
  NODE: 'node',
  PYTHON: 'python',
  DOTNET: 'dotnet',
};

const DETECTION_FILES = {
  [STACKS.NODE]: ['package.json'],
  [STACKS.PYTHON]: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
  [STACKS.DOTNET]: ['.csproj'], // matched by extension
};

const BASE_IMAGES = {
  [STACKS.NODE]: (version) => `node:${version}-alpine3.21`,
  [STACKS.PYTHON]: (version) => `python:${version}-slim`,
  [STACKS.DOTNET]: {
    runtime: (version) => `mcr.microsoft.com/dotnet/aspnet:${version}`,
    sdk: (version) => `mcr.microsoft.com/dotnet/sdk:${version}`,
  },
};

const DEFAULT_VERSIONS = {
  [STACKS.NODE]: '20',
  [STACKS.PYTHON]: '3.12',
  [STACKS.DOTNET]: '8.0',
};

const DEFAULT_PORTS = {
  [STACKS.NODE]: 3000,
  [STACKS.PYTHON]: 8000,
  [STACKS.DOTNET]: 8080,
};

const IGNORED_DIRS = [
  '.git',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  'bin',
  'obj',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.venv',
  'venv',
  'env',
  // test infra
  '__tests__',
  '__mocks__',
  'test',
  'tests',
  'fixtures',
  'spec',
  'specs',
  // sample / docs — not deployable services
  'examples',
  'example',
  'samples',
  'sample',
  'demos',
  'demo',
  'docs',
  'doc',
  'dev-docs',
  'documentation',
];

// Root-level config files that affect compiled output and must be COPYed into build stages.
// Dev-only tools (eslint, prettier, stylelint, editorconfig) are deliberately excluded —
// they don't affect npm run build output and are typically in .dockerignore.
const ROOT_CONFIG_FILES = [
  // TypeScript compilation
  'tsconfig.json', 'tsconfig.base.json', 'tsconfig.build.json', 'tsconfig.app.json',
  // Babel
  'babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json',
  '.babelrc', '.babelrc.js', '.babelrc.json',
  // PostCSS (affects CSS output)
  'postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs',
  // ESLint — react-scripts/Next.js run ESLint during `npm run build`
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.mjs',
  '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
];

module.exports = {
  STACKS,
  DETECTION_FILES,
  BASE_IMAGES,
  DEFAULT_VERSIONS,
  DEFAULT_PORTS,
  IGNORED_DIRS,
  ROOT_CONFIG_FILES,
};
