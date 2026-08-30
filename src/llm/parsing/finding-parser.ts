import { Finding, findingsPayloadSchema, findingSchema } from '../../core/types/finding';

export interface ParseSuccess {
  ok: true;
  findings: Finding[];
}

export interface ParseFailure {
  ok: false;
  /** Human-readable reason, safe to log. */
  reason: string;
  /** Message to send back to the model so it can correct itself. */
  repairInstruction: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Turns whatever the model returned into validated findings.
 *
 * Models wrap JSON in prose and code fences even when told not to, so the payload is
 * located by scanning for a balanced JSON value rather than trusting the response to be
 * JSON end to end. Nothing is coerced: a payload that does not satisfy the schema is a
 * failure with a repair instruction, never a half-parsed finding list.
 */
export function parseFindings(raw: string): ParseResult {
  const candidate = extractJsonValue(raw);
  if (candidate === null) {
    return {
      ok: false,
      reason: 'no JSON value found in the response',
      repairInstruction:
        'Your previous response contained no JSON. Reply with ONLY a JSON object of the ' +
        'form {"findings": [...]} and no prose, explanation, or code fence.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      reason: `response was not valid JSON: ${(error as Error).message}`,
      repairInstruction:
        'Your previous response was not valid JSON. Reply with ONLY a valid JSON object ' +
        'of the form {"findings": [...]}.',
    };
  }

  // A bare array is the most common deviation; accept it rather than burning a repair round.
  const normalized = Array.isArray(parsed) ? { findings: parsed } : parsed;

  const result = findingsPayloadSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return {
      ok: false,
      reason: `response did not match the findings schema: ${issues}`,
      repairInstruction:
        `Your previous response did not match the required schema. Problems: ${issues}. ` +
        `Reply with ONLY a JSON object matching this shape: ${schemaHint()}`,
    };
  }

  return { ok: true, findings: result.data.findings };
}

/** A compact description of the expected payload, used in repair prompts. */
export function schemaHint(): string {
  const shape = {
    findings: [
      {
        severity: 'critical|high|medium|low|info',
        category:
          'correctness|cross-module-regression|architecture|circular-dependency|security|performance|maintainability',
        file: 'repo/relative/path.ts',
        line: 0,
        summary: 'one sentence, max 200 chars',
        rationale: 'why this is a problem, referencing the cited evidence',
        evidenceRefs: ['E1'],
        confidence: 0.0,
      },
    ],
  };
  return JSON.stringify(shape);
}

/**
 * Finds the first balanced JSON object or array in `text`.
 *
 * Brace counting is string-literal aware: a `}` inside `"a } b"` must not close the value,
 * and a trailing sentence containing a brace must not be swallowed. Returns null when no
 * balanced value exists.
 */
export function extractJsonValue(text: string): string | null {
  const fenced = stripCodeFence(text);
  const source = fenced ?? text;

  for (let start = 0; start < source.length; start++) {
    const opener = source[start];
    if (opener !== '{' && opener !== '[') continue;

    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i++) {
      const char = source[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        if (inString) escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === opener) depth++;
      else if (char === closer) {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

/** Returns the body of the first fenced block, or null when the text has no fence. */
function stripCodeFence(text: string): string | null {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return match ? match[1] : null;
}

/** Re-exported so callers can validate a single hand-built finding (fixtures, eval). */
export const singleFindingSchema = findingSchema;
