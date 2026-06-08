'use strict';

// Typed error model for @dockerforge/core (see docs/contracts/core-contract.md, Section 4).
// Core throws these, never a bare Error, so callers can branch on `.code` reliably.

class DockerForgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

class PathNotFoundError extends DockerForgeError {
  constructor(message) { super(message, 'PATH_NOT_FOUND'); }
}

class NotADirectoryError extends DockerForgeError {
  constructor(message) { super(message, 'NOT_A_DIRECTORY'); }
}

class UnsupportedStackError extends DockerForgeError {
  constructor(message) { super(message, 'UNSUPPORTED_STACK'); }
}

class IngestError extends DockerForgeError {
  constructor(message) { super(message, 'INGEST_ERROR'); }
}

module.exports = {
  DockerForgeError,
  PathNotFoundError,
  NotADirectoryError,
  UnsupportedStackError,
  IngestError,
};
