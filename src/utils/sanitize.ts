/**
 * Sanitization utilities for external text from PingCode API.
 *
 * Strips control characters and truncates to safe lengths to prevent
 * LLM prompt injection via tool results.
 */

// Control char ranges: U+0000-U+001F (except \t \n \r), U+007F-U+009F
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

const TRUNCATION_SUFFIX = '…[truncated]';

/**
 * Strip control characters and optionally truncate external text.
 * Returns undefined if input is null/undefined.
 */
export function sanitizeExternalText(
  text: string | undefined | null,
  opts?: { maxLength?: number }
): string | undefined {
  if (text == null) return undefined;

  let cleaned = text.replace(CONTROL_CHAR_RE, '');

  if (opts?.maxLength && cleaned.length > opts.maxLength) {
    cleaned = cleaned.slice(0, opts.maxLength - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
  }

  return cleaned;
}

/** Sanitize a title field (max 500 chars) */
export function sanitizeTitle(text: string | undefined | null): string | undefined {
  return sanitizeExternalText(text, { maxLength: 500 });
}

/** Sanitize a name/display_name field (max 200 chars) */
export function sanitizeName(text: string | undefined | null): string | undefined {
  return sanitizeExternalText(text, { maxLength: 200 });
}

/** Sanitize a description field (max 2000 chars) */
export function sanitizeDescription(text: string | undefined | null): string | undefined {
  return sanitizeExternalText(text, { maxLength: 2000 });
}
