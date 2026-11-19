const providerCodes = new Set([
  'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA_EXCEEDED',
  'RATE_LIMIT', 'SERVER_ERROR', 'TRANSPORT', 'CONTEXT_WINDOW_EXCEEDED',
  'AUTH_REJECTED', 'TIMEOUT', 'STREAM_CLOSED', 'MALFORMED_RESPONSE',
  'INVALID_REQUEST', 'EMPTY_RESPONSE',
]);

// Pinned native SDK codes are not the product-facing names. AUTH includes
// both 401 and 403, so it must not imply that the key itself is invalid.
function safeProviderCode(code: unknown): string {
  if (code === 'AUTH') return 'AUTH_REJECTED';
  if (code === 'QUOTA') return 'QUOTA_EXCEEDED';
  if (code === 'SERVER') return 'SERVER_ERROR';
  return typeof code === 'string' && providerCodes.has(code) ? code : 'TURN_FAILED';
}

/** Preserve only supported machine codes, never upstream message/cause/body. */
export class DshTurnError extends Error {
  readonly code: string;
  constructor(code: unknown) {
    const safe = safeProviderCode(code);
    super(`DSH turn did not complete successfully (${safe})`);
    this.code = safe;
  }
}

export function describeDshProbeFailure(error: unknown) {
  const messages: Record<string, string> = {
    'DSH execution timed out': 'TIMEOUT',
    'DSH probe timed out': 'TIMEOUT',
    'DSH smoke response did not match': 'UNEXPECTED_REPLY',
    'DSH RPC request failed': 'PROTOCOL_REJECTED',
    'DSH exited before completion': 'RUNTIME_EXIT',
    'DSH process could not start': 'RUNTIME_START',
    'DSH runtime dependency cohort is not verified': 'RUNTIME_COHORT',
    'DSH text runtime version is not verified': 'RUNTIME_VERSION',
    'DSH probe configuration is invalid': 'CONFIGURATION',
    'DSH text configuration is invalid': 'CONFIGURATION',
    'DSH local credential store is not a private regular file': 'CREDENTIAL_STORE',
  };
  const code = error instanceof DshTurnError ? safeProviderCode(error.code)
    : error instanceof Error && Object.hasOwn(messages, error.message) ? messages[error.message] : 'UNKNOWN';
  return {ok: false as const, code, error: 'DSH probe failed. No automatic retry was made.'};
}
