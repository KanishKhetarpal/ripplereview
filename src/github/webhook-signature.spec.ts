import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sign, verifySignature } from './webhook-signature';

const SECRET = 'a-shared-secret';
const BODY = '{"action":"opened","number":7}';

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    expect(verifySignature(BODY, sign(BODY, SECRET), SECRET)).toEqual({ valid: true });
  });

  it('accepts the same body as a Buffer', () => {
    const raw = Buffer.from(BODY, 'utf8');
    expect(verifySignature(raw, sign(BODY, SECRET), SECRET)).toEqual({ valid: true });
  });

  it('REJECTS everything when no secret is configured', () => {
    // The tempting alternative — skip verification when unset — turns a forgotten
    // environment variable into an open door that looks like it is working, because the
    // happy path is byte-identical either way.
    expect(verifySignature(BODY, sign(BODY, SECRET), undefined)).toEqual({
      valid: false,
      reason: 'no-secret-configured',
    });
  });

  it('rejects an empty-string secret, which is how an unset env var arrives', () => {
    expect(verifySignature(BODY, sign(BODY, SECRET), '').valid).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(BODY, undefined, SECRET)).toEqual({
      valid: false,
      reason: 'missing-signature',
    });
  });

  it('rejects a header without the sha256= prefix', () => {
    const bare = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifySignature(BODY, bare, SECRET)).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects the older sha1 scheme rather than trying to accommodate it', () => {
    const sha1 = `sha1=${createHmac('sha1', SECRET).update(BODY).digest('hex')}`;
    expect(verifySignature(BODY, sha1, SECRET)).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects a same-length prefix carrying an otherwise valid digest', () => {
    // `sha512=` is exactly as long as `sha256=`, so slicing the prefix off blindly yields
    // a perfectly well-formed 64-char hex digest and every other check passes. Removing
    // the startsWith test survived a sha1= case for an unrelated reason (length), which is
    // how this hole stayed open.
    const digest = sign(BODY, SECRET).slice('sha256='.length);
    expect(verifySignature(BODY, `sha512=${digest}`, SECRET)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('rejects a non-hex digest', () => {
    expect(verifySignature(BODY, `sha256=${'z'.repeat(64)}`, SECRET)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('rejects a digest of the wrong length', () => {
    expect(verifySignature(BODY, 'sha256=abcdef', SECRET)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(BODY, sign(BODY, 'wrong-secret'), SECRET)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects a body altered after signing', () => {
    const signature = sign(BODY, SECRET);
    const tampered = BODY.replace('opened', 'closed');
    expect(verifySignature(tampered, signature, SECRET)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects a body whose whitespace changed, since GitHub signs the bytes it sent', () => {
    // This is why the RAW body is hashed. JSON.parse followed by JSON.stringify produces
    // an equivalent object and different bytes, and every signature would fail.
    const reserialised = JSON.stringify(JSON.parse(BODY));
    const spaced = '{"action": "opened", "number": 7}';
    expect(verifySignature(spaced, sign(reserialised, SECRET), SECRET).valid).toBe(false);
  });

  it('accepts an uppercase hex digest', () => {
    expect(
      verifySignature(BODY, sign(BODY, SECRET).toUpperCase().replace('SHA256=', 'sha256='), SECRET)
        .valid,
    ).toBe(true);
  });

  it('handles an empty body', () => {
    expect(verifySignature('', sign('', SECRET), SECRET)).toEqual({ valid: true });
  });

  it('handles a unicode body byte-for-byte', () => {
    const unicode = '{"title":"café ☕ 🚀"}';
    expect(verifySignature(unicode, sign(unicode, SECRET), SECRET)).toEqual({ valid: true });
  });

  it('does not accept a signature for a prefix of the body', () => {
    expect(verifySignature(BODY, sign(BODY.slice(0, 10), SECRET), SECRET).valid).toBe(false);
  });
});

describe('the comparison is constant-time', () => {
  it('uses timingSafeEqual, harvested from the implementation', () => {
    // Timing safety is not observable from behaviour: a plain `===` returns exactly the
    // same verdicts, and every functional test above passes against it. The only way to
    // pin it is to read the source. Crude, and the alternative is a guarantee nothing
    // checks — an attacker who can retry can walk a valid signature out of the timing.
    const source = readFileSync(join(__dirname, 'webhook-signature.ts'), 'utf8');

    // It must be CALLED, not merely imported. Asserting on the bare name passed against
    // a version where the call had been replaced, because the import line still mentions
    // it — the first cut of this test was itself vacuous.
    expect(source).toMatch(/timingSafeEqual\s*\(/);

    // And no line may compare the two digests with === or !==. Line-based rather than
    // one clever regex: the first attempt matched the LEGITIMATE length check that
    // timingSafeEqual requires, and failed against correct code.
    const comparingLines = source
      .split('\n')
      .filter((line) => /(===|!==)/.test(line))
      .filter((line) => line.includes('provided') && line.includes('expected'))
      // Comparing LENGTHS is required: timingSafeEqual throws on a mismatch, and the
      // length of a hex digest is public anyway.
      .filter((line) => !line.includes('.length'));

    expect(comparingLines).toEqual([]);
  });
});
