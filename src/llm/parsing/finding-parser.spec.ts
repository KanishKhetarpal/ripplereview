import { describe, expect, it } from 'vitest';
import { extractJsonValue, parseFindings } from './finding-parser';

const validFinding = {
  severity: 'high',
  category: 'cross-module-regression',
  file: 'src/checkout/checkout.service.ts',
  line: 88,
  summary: 'Discount is not passed through from checkout',
  rationale: 'CheckoutService.confirm still calls total() with one argument.',
  evidenceRefs: ['E1'],
};

describe('extractJsonValue', () => {
  it('returns a bare object unchanged', () => {
    expect(extractJsonValue('{"a":1}')).toBe('{"a":1}');
  });

  it('unwraps a fenced json block', () => {
    const text = 'Here you go:\n```json\n{"findings": []}\n```\nHope that helps.';
    expect(extractJsonValue(text)).toBe('{"findings": []}');
  });

  it('unwraps an unlabelled fence', () => {
    expect(extractJsonValue('```\n[1, 2]\n```')).toBe('[1, 2]');
  });

  it('ignores braces inside string literals', () => {
    const text = '{"summary": "uses a } brace", "n": 1}';
    expect(extractJsonValue(text)).toBe(text);
  });

  it('ignores an escaped quote inside a string', () => {
    const text = '{"summary": "he said \\"} \\" once"}';
    expect(extractJsonValue(text)).toBe(text);
  });

  it('stops at the balanced close, not at trailing prose containing a brace', () => {
    const text = '{"a":1} and then some prose with a } in it';
    expect(extractJsonValue(text)).toBe('{"a":1}');
  });

  it('finds the object when the model prefixes prose', () => {
    expect(extractJsonValue('Sure! {"findings": []}')).toBe('{"findings": []}');
  });

  it('returns null when nothing balances', () => {
    expect(extractJsonValue('{"a": 1')).toBeNull();
    expect(extractJsonValue('no json here at all')).toBeNull();
  });
});

describe('parseFindings', () => {
  it('accepts the documented payload shape', () => {
    const result = parseFindings(JSON.stringify({ findings: [validFinding] }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
  });

  it('accepts a bare array without burning a repair round', () => {
    const result = parseFindings(JSON.stringify([validFinding]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.findings[0].file).toBe('src/checkout/checkout.service.ts');
  });

  it('defaults evidenceRefs to an empty array when omitted', () => {
    const { evidenceRefs: _omitted, ...withoutRefs } = validFinding;
    const result = parseFindings(JSON.stringify({ findings: [withoutRefs] }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.findings[0].evidenceRefs).toEqual([]);
  });

  it('rejects an unknown severity rather than coercing it', () => {
    const result = parseFindings(
      JSON.stringify({ findings: [{ ...validFinding, severity: 'blocker' }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('schema');
    expect(result.repairInstruction).toContain('severity');
  });

  it('rejects an unknown category', () => {
    const result = parseFindings(
      JSON.stringify({ findings: [{ ...validFinding, category: 'vibes' }] }),
    );
    expect(result.ok).toBe(false);
  });

  it('reports a repair instruction when there is no JSON at all', () => {
    const result = parseFindings('I could not find anything wrong.');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('no JSON');
    expect(result.repairInstruction).toContain('ONLY a JSON object');
  });

  it('reports invalid JSON distinctly from a schema mismatch', () => {
    const result = parseFindings('{"findings": [ }');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not valid JSON|no JSON value/);
  });
});
