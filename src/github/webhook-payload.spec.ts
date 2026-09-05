import { describe, expect, it } from 'vitest';
import { readPullRequest } from './webhook.controller';

const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'opened',
  number: 7,
  pull_request: { head: { sha: 'abc123' }, base: { ref: 'main' } },
  repository: {
    name: 'widgets',
    clone_url: 'https://github.com/acme/widgets.git',
    owner: { login: 'acme' },
  },
  ...overrides,
});

describe('readPullRequest', () => {
  it('reads everything a review needs', () => {
    expect(readPullRequest(payload())).toEqual({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 7,
      headSha: 'abc123',
      baseRef: 'main',
      cloneUrl: 'https://github.com/acme/widgets.git',
    });
  });

  it('refuses a payload with no head sha', () => {
    // Reviewing the branch tip instead would review whatever happens to be there when the
    // worker gets to it, and anchor comments to a commit nobody asked about.
    expect(readPullRequest(payload({ pull_request: { base: { ref: 'main' } } }))).toBeNull();
  });

  it('refuses a payload with no base ref', () => {
    expect(readPullRequest(payload({ pull_request: { head: { sha: 'abc' } } }))).toBeNull();
  });

  it('refuses a payload with no repository', () => {
    expect(readPullRequest(payload({ repository: undefined }))).toBeNull();
  });

  it('refuses a payload with no clone url', () => {
    expect(
      readPullRequest(payload({ repository: { name: 'w', owner: { login: 'a' } } })),
    ).toBeNull();
  });

  it('refuses a pull number that is not a number', () => {
    // A string here would reach the database as a bad integer, or worse be coerced.
    expect(readPullRequest(payload({ number: '7' }))).toBeNull();
  });

  it('refuses null', () => {
    expect(readPullRequest(null)).toBeNull();
  });

  it('refuses an object-valued field rather than stringifying it', () => {
    expect(
      readPullRequest(payload({ repository: { name: {}, owner: { login: 'a' }, clone_url: 'u' } })),
    ).toBeNull();
  });
});
