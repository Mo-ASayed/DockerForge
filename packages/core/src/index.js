'use strict';

// @dockerforge/core - the offline DockerForge engine, public surface.
//
// Given a path to a local project, it analyses the stack and generates a Dockerfile,
// a .dockerignore, and a Compose file, and it lints existing Dockerfiles. This file is the
// stable public API (see docs/contracts/core-contract.md). The engine itself lives under
// ./engine.
//
// No-network guarantee: this module performs zero outbound network calls. It only reads the
// local filesystem under the resolved project path. Remote ingestion (git URL / zip URL) is
// intentionally NOT exposed here - that adapter lives in the proprietary cloud.

const path = require('path');
const fs = require('fs-extra');

const engine = require('./engine');
const errors = require('./errors');
const { lint } = require('./lint');

/**
 * Validate a local directory and return its resolved absolute path.
 * Throws typed errors (PathNotFoundError / NotADirectoryError) per the contract.
 * @param {string} targetPath
 * @returns {Promise<string>}
 */
async function ingestLocal(targetPath) {
  const resolved = path.resolve(targetPath);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new errors.PathNotFoundError(`Path not found: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new errors.NotADirectoryError(`Not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Run the offline engine pipeline. Only the documented OFFLINE input fields are accepted;
 * remote-ingest fields (gitUrl/zipPath/fileTree/workDir/pat) are deliberately not forwarded.
 * @param {{projectPath: string, hints?: object, optimise?: boolean, security?: boolean, validation?: object|null, pinDigests?: boolean, digestResolver?: Function}} input
 * @returns {Promise<object>} EngineResult (see contract Section 2.2)
 */
async function runDockerfileEngine(input = {}) {
  const { projectPath, hints, optimise, security, validation, pinDigests, digestResolver } = input;
  if (!projectPath) {
    throw new errors.IngestError(
      'projectPath is required: @dockerforge/core is offline. Remote ingestion (git URL/zip) lives in the cloud adapter, not core.'
    );
  }
  return engine.runDockerfileEngine({ projectPath, hints, optimise, security, validation, pinDigests, digestResolver });
}

module.exports = {
  ingestLocal,
  runDockerfileEngine,
  lint,
  // typed errors, re-exported so consumers import them from the package root
  ...errors,
};
