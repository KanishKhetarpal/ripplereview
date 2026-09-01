import { describe, expect, it } from 'vitest';
import { BpeTokenCounter, HeuristicTokenCounter, createTokenCounter } from './token-counter';

const bpe = new BpeTokenCounter();
const heuristic = new HeuristicTokenCounter();

describe('BpeTokenCounter', () => {
  it('counts an empty string as nothing', () => {
    expect(bpe.count('')).toBe(0);
  });

  it('counts real tokens, not characters', () => {
    expect(bpe.count('hello world')).toBeLessThan('hello world'.length);
    expect(bpe.count('hello world')).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const text = 'export function total(items: Item[]): number {}';
    expect(bpe.count(text)).toBe(bpe.count(text));
  });

  it('grows with the text', () => {
    expect(bpe.count('a'.repeat(400))).toBeGreaterThan(bpe.count('a'.repeat(40)));
  });

  it('charges punctuation-dense code far more per character than prose', () => {
    // The measurement behind choosing BPE over a character heuristic: chars/4 under-counts
    // this shape by 41%, and under-counting overflows the request.
    const punctuation = '{}[]();=>...!==&&||??`${}`'.repeat(50);
    const prose = 'the quick brown fox jumps over the lazy dog. '.repeat(30);

    const punctuationRatio = punctuation.length / bpe.count(punctuation);
    const proseRatio = prose.length / bpe.count(prose);

    expect(punctuationRatio).toBeLessThan(proseRatio);
    expect(punctuationRatio).toBeLessThan(4);
  });

  it('reports which encoding produced the number', () => {
    expect(bpe.name).toBe('o200k_base');
  });
});

describe('HeuristicTokenCounter', () => {
  it('over-counts rather than under-counts real source', () => {
    // The fallback exists to be safe, not accurate: dropping evidence that would have
    // fitted is recoverable, overflowing the model's context is not.
    const source = 'export function total(items: Item[]): number {\n  return 1;\n}\n'.repeat(20);
    expect(heuristic.count(source)).toBeGreaterThan(bpe.count(source));
  });

  it('does not under-count ANY measured shape, including the pathological ones', () => {
    // 2.5 was the first divisor, chosen on the assumption that punctuation-dense code was
    // the worst case. Emoji are worse (1.25 chars/token) and would have overflowed.
    const shapes = [
      '{}[]();=>...!==&&||??`${}`'.repeat(50),
      '~!@#$%^&*()_+-=[]{}|;:,.<>?'.repeat(60),
      '🙂🚀✨'.repeat(200),
      '这是一个测试字符串'.repeat(100),
      'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q='.repeat(40),
      'a=b?c:d,e=f(g,h),i={j:k,l:m};'.repeat(60),
    ];

    for (const shape of shapes) {
      expect(heuristic.count(shape)).toBeGreaterThanOrEqual(bpe.count(shape));
    }
  });

  it('counts an empty string as nothing', () => {
    expect(heuristic.count('')).toBe(0);
  });
});

describe('createTokenCounter', () => {
  it('returns the real BPE counter when the table loads', () => {
    expect(createTokenCounter().name).toBe('o200k_base');
  });
});
