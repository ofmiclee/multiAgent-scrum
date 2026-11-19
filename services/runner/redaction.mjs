// Copyright 2026 ofmiclee and contributors. SPDX-License-Identifier: Apache-2.0
// Origin: the author's FruitBuddy redaction.mjs; see THIRD_PARTY_NOTICES.md.
const SENSITIVE_KEY = /(?:access.?token|refresh.?token|exchange.?secret|authorization|cookie|password|secret|session|csrf|reset.?(?:token|url|secret|digest)|ciphertext|private.?key|api.?key|stack)/i
const SENSITIVE_QUERY = /([?&](?:(?:access|refresh)[._-]?token|exchange[._-]?secret|authorization|cookie|(?:new[._-]?)?password(?:[._-]?hash)?|secret|session(?:[._-]?(?:id|token|digest))?|csrf(?:[._-]?(?:token|digest))?|reset[._-]?(?:token|url|secret|digest)|bootstrap(?:[._-]?(?:secret|token|digest))?|ciphertext|private[._-]?key|api[._-]?key|token)=)[^&]*/gi
const SENSITIVE_TEXT_TAIL = /(^|[^?&A-Za-z0-9_])(?:bearer\s+|postgres(?:ql)?:\/\/|kms\s+|(?:(?:access|refresh)[\s_-]?token|exchange[\s_-]?secret|authorization|cookie|(?:new[\s_-]?)?password(?:[\s_-]?hash)?|secret|session(?:[\s_-]?(?:id|token|digest))?|csrf(?:[\s_-]?(?:token|digest))?|reset[\s_-]?(?:token|url|secret|digest)|bootstrap(?:[\s_-]?(?:secret|token|digest))?|ciphertext|private[\s_-]?key|api[\s_-]?key)\s*[:=])[\s\S]*$/i

function sensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key).replace(/[^a-zA-Z0-9]+/g, ''))
}

function redactError(error, seen) {
  if (seen.has(error)) return '[REDACTED]'
  seen.add(error)
  const name = typeof error.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
    ? error.name
    : 'Error'
  const redacted = { name, message: '[REDACTED]' }
  for (const [key, child] of Object.entries(error)) {
    if (key === 'name' || key === 'message') continue
    redacted[key] = sensitiveKey(key) ? '[REDACTED]' : redactValue(child, seen)
  }
  if (Object.hasOwn(error, 'cause') && !Object.hasOwn(redacted, 'cause')) {
    redacted.cause = redactValue(error.cause, seen)
  }
  seen.delete(error)
  return redacted
}

export function redactValue(value, seen = new WeakSet()) {
  if (value instanceof Error) return redactError(value, seen)
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value
      .replace(SENSITIVE_QUERY, '$1[REDACTED]')
      .replace(SENSITIVE_TEXT_TAIL, '$1[REDACTED]')
  }
  if (typeof value !== 'object') return '[REDACTED]'
  if (seen.has(value)) return '[REDACTED]'
  seen.add(value)
  const redacted = Array.isArray(value)
    ? value.map((item) => redactValue(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    sensitiveKey(key) ? '[REDACTED]' : redactValue(child, seen),
  ]))
  seen.delete(value)
  return redacted
}
export function createRedactingLogger(logger = console) {
  return Object.freeze(Object.fromEntries(['debug', 'info', 'warn', 'error', 'log'].map((level) => [
    level,
    (message, detail = undefined) => logger[level](
      redactValue(message),
      detail === undefined ? undefined : redactValue(detail),
    ),
  ])))
}
