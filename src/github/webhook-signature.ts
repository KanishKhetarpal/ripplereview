import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureVerdict =
  | { valid: true }
  | {
      valid: false;
      reason: 'no-secret-configured' | 'missing-signature' | 'malformed' | 'mismatch';
    };

const PREFIX = 'sha256=';

/**
 * Verifies GitHub's `X-Hub-Signature-256` header.
 *
 * This is the only thing standing between a public endpoint and anyone who can guess the
 * URL, so it is written to fail closed at every step.
 *
 * **An unset secret rejects everything.** The tempting alternative — skip verification
 * when no secret is configured, as this project's own chatbot webhooks do — turns a
 * forgotten environment variable into an open door that looks like it is working, because
 * the happy path is identical either way.
 *
 * **The comparison is constant-time.** A byte-by-byte `===` leaks how much of a forged
 * signature was correct, and an attacker who can retry can walk a valid signature out of
 * the timing. `timingSafeEqual` throws on a length mismatch, so lengths are checked first —
 * and that check is safe to do early, since the length of a SHA-256 hex digest is public.
 *
 * **The RAW body must be hashed**, not a re-serialised object. `JSON.parse` followed by
 * `JSON.stringify` reorders nothing but does drop insignificant whitespace, and GitHub
 * signs the bytes it sent.
 */
export function verifySignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string | undefined,
): SignatureVerdict {
  if (!secret) return { valid: false, reason: 'no-secret-configured' };
  if (!signatureHeader) return { valid: false, reason: 'missing-signature' };
  if (!signatureHeader.startsWith(PREFIX)) return { valid: false, reason: 'malformed' };

  const provided = signatureHeader.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { valid: false, reason: 'malformed' };

  const expected = createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

  const providedBytes = Buffer.from(provided.toLowerCase(), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');

  if (providedBytes.length !== expectedBytes.length) return { valid: false, reason: 'malformed' };

  return timingSafeEqual(providedBytes, expectedBytes)
    ? { valid: true }
    : { valid: false, reason: 'mismatch' };
}

/** For tests and for signing outbound requests in a fixture. */
export function sign(rawBody: string, secret: string): string {
  return `${PREFIX}${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}
