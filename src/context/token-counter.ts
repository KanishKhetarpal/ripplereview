import { Injectable, Logger } from '@nestjs/common';
import { Tiktoken, getEncoding } from 'js-tiktoken';

export interface TokenCounter {
  /** Recorded on the run, so a budget decision can be traced to how it was counted. */
  readonly name: string;
  count(text: string): number;
}

/**
 * Real BPE, the encoding current OpenAI models use.
 *
 * The cheap `length / 4` heuristic was measured against it before this was written, and it
 * is not safe for the text this tool sends. On ordinary TypeScript it over-counts by about
 * 8-11% — wasteful but harmless. On dense punctuation (`{}[]();=>...!==&&||??`) it
 * **under-counts by 41%**, and under-counting is the failure direction: the assembled
 * prompt overflows the model's context and the request fails outright, after the graph
 * engine has already done all its work.
 *
 * Cost measured at 40ms for 87k characters, which is affordable for something the packer
 * calls once per candidate item.
 */
@Injectable()
export class BpeTokenCounter implements TokenCounter {
  readonly name = 'o200k_base';
  private encoder: Tiktoken | null = null;

  count(text: string): number {
    if (text === '') return 0;
    return this.encoding().encode(text).length;
  }

  /** Loaded on first use: the rank table is large and a run may never need it. */
  private encoding(): Tiktoken {
    this.encoder ??= getEncoding('o200k_base');
    return this.encoder;
  }
}

/**
 * The degraded fallback, reached only when the BPE table cannot be loaded — a broken
 * install, not a normal path.
 *
 * The divisor is 1.25, which looks absurd next to the familiar "about 4 characters per
 * token" and is the measured worst case rather than a guess. Characters per token, by
 * shape:
 *
 *     tabs/newlines  6.00      typical TypeScript  4.07
 *     punctuation    2.36      spaced characters   2.00
 *     minified JS    1.71      base64              1.63
 *     symbols        1.50      emoji               1.25
 *
 * A first attempt used 2.5, on the assumption that punctuation-dense code was the worst
 * case. It is not, and a comment string with emoji in it would have overflowed the model's
 * context — the one failure this counter exists to prevent.
 *
 * The cost is real: this over-counts ordinary source by more than 3x, so a review running
 * on the fallback will drop most of its evidence. That is why it warns, and why the
 * assembler reports every dropped item rather than quietly shrinking the context.
 */
@Injectable()
export class HeuristicTokenCounter implements TokenCounter {
  readonly name = 'heuristic-1.25';

  count(text: string): number {
    return Math.ceil(text.length / 1.25);
  }
}

export const TOKEN_COUNTER = Symbol('TOKEN_COUNTER');

/** Picks the real counter, falling back loudly rather than silently. */
export function createTokenCounter(logger = new Logger('TokenCounter')): TokenCounter {
  const bpe = new BpeTokenCounter();
  try {
    bpe.count('probe');
    return bpe;
  } catch (error) {
    logger.warn(
      `BPE token table unavailable (${(error as Error).message}); falling back to a ` +
        'conservative character heuristic. It over-counts ordinary source by more than 3x, ' +
        'so this review will see far less evidence than it should. Reinstall js-tiktoken.',
    );
    return new HeuristicTokenCounter();
  }
}
