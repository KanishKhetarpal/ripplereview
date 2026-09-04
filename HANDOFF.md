# RippleReview — engineering handoff

Everything needed to pick this project up cold: where it is, what is built, what is not,
and the measurements behind the decisions that look arbitrary.

---

## How this project is built

- **One commit per coherent unit**, made as the work finishes. The message describes what
  is actually in the commit and explains *why*, referencing the failure being closed.
- **Probe before you design.** Measure the real thing before writing the code that depends
  on it. Every good decision here came from a probe, and several overturned what the plan
  already said.
- **Verify against reality, not mocks.** Integration tests hit real git, a real ts-morph
  language service, a real PostgreSQL, a real HTTP server. Run the thing — "it compiles"
  and "the tests pass" are not "it works".
- **Mutation-check the tests.** Break an assertion deliberately and confirm the suite goes
  red. Do this especially when a suite passes on the first try; it has found a vacuous or
  self-referential test in *every* phase so far.
- **Say plainly what is unverified**, and keep saying it. Report real numbers. Never claim
  a CI run passed without reading the log.

---

## What this project is

An AI code reviewer that beats diff-only review by feeding the model **graph-grounded
blast-radius context** — what a change actually reaches across the repository, computed
deterministically and handed over as cited evidence.

**The thesis:** we do not out-reason the frontier model on a raw diff; everyone calls the
same model. We win on context engineering, and it has to be *measured*, not asserted.

Two rules that constrain everything:

1. **Structural claims come from the graph, never the model.** Enforced in code by
   `enforceGrounding()` (`src/core/grounding.ts`), which drops a structural finding that
   cites nothing and any finding citing an evidence id we never supplied.
2. **The eval harness is a first-class deliverable.** The claim only exists if measured.

---

## Where things are

- Repo: `KanishKhetarpal/ripplereview` (public). Local: `~/projects/RippleReview`.
- Sibling project it vendors parser/graph code from: `~/projects/arch-lens`.
- Branch `main`. Working tree clean, CI green.

---

## Current state

| Phase | State |
|---|---|
| 0 — Scaffold, config, LLM adapter, CLI, REST, CI | ✅ done |
| 1 — Graph MVP: ingest, blast radius, cycles, rules | ✅ done |
| 2 — Context assembler, real providers, full pipeline | ✅ done |
| 3 — Eval harness + corpus + scorecard | ✅ built, **number not produced** |
| 4 — Persistence, GitHub integration, Action, Docker | ✅ mostly, **dispatch not built** |
| 5 — pgvector duplicate-logic detection, dashboard | ⬜ optional |

**441 passing, 16 skipped locally (they need Postgres and run in CI).**

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

---

## ⚠️ The two things that are NOT verified

### 1. No live model call has ever been made

There is no OpenAI or Google API key on the machine this was built on. Every scorecard so
far ran against the offline `echo` stub, which has no opinion about code and reports
`0.0% vs 0.0%`. That is the harness working, not a negative result — the scorecard says so
in bold at the top. **Do not quote it.**

```bash
echo "LLM_PROVIDER=openai" >> .env
echo "OPENAI_API_KEY=sk-..." >> .env
node dist/cli/main-cli.js review . --base HEAD~1 --head HEAD   # one real call first
pnpm eval --runs 5                                             # then the number
```

To add another vendor, write `src/llm/providers/<name>-llm.provider.ts` extending
`HttpLlmProvider` (~40 lines — copy the Gemini one), add the name to `PROVIDER_NAMES` in
`src/config/env.validation.ts`, and a case in `selectProvider()` in `src/llm/llm.module.ts`.
Probe the live error shape first, as was done for the other two: both had a surprise in it.

### 2. No review has ever been posted to a real pull request

The GitHub client's paths, auth header and error shapes were probed against the live API
without creating anything (a review on a nonexistent PR answers 404; a bad token answers
401), and the rendering is fully tested. But the posting path itself is unexercised, and a
webhook delivery does not yet trigger a review — the endpoint verifies and acknowledges,
and dispatching needs a queue because GitHub retries after ten seconds.

---

## Architecture

```
ingest → graph engine → context assembler → LLM → grounding guard → output
         (deterministic,      (the             (provider-  (drops uncited
          no LLM)         differentiator)      agnostic)   structural claims)
```

| Path | What it is |
|---|---|
| `src/ingest/` | git change sets, unified-diff parser |
| `src/graph/` | module graph, symbol locator, blast radius, cycles, arch rules |
| `src/context/` | token counter, evidence builder, type extractor, **assembler** |
| `src/llm/` | provider interface, echo stub, OpenAI, Gemini, parser + repair loop |
| `src/review/` | pipeline orchestration, prompt, severity gate, HTTP surface |
| `src/db/` | optional PostgreSQL persistence |
| `src/github/` | webhook signature, PR review rendering, API client |
| `src/output/` | terminal + JSON renderers |
| `eval/` | corpus, matcher, metrics, runner, scorecard |

### Commands

```bash
pnpm build
node dist/cli/main-cli.js impact . --base HEAD~1 --head HEAD   # graph only, no model
node dist/cli/main-cli.js review . --fail-on high              # full pipeline
node dist/cli/main-cli.js review . --diff-only                 # eval baseline
node dist/main.js                                              # REST on :3000/api/v1
pnpm eval --runs 3                                             # score both arms
docker build -t ripplereview .
```

CLI exit codes are a contract CI depends on: `0` ran clean, `1` blocking findings at or
above `--fail-on`, `2` could not run. Collapsing 1 and 2 makes a broken reviewer look like
a failing build.

---

## Hard-won facts — do not re-derive these

**ts-morph / graph engine**

- `skipFileDependencyResolution: true` produces **identical** reference sets to a fully
  resolving load and uses ~25x less memory. Measured on a 677-file repo: 741ms/160MB vs
  25s/2.2GB — the resolving load OOM'd Node's default heap. The plan originally claimed a
  second loader mode was needed; that was wrong.
- First reference lookup pays the language service warm-up: **437ms on 135 files, 18.4s and
  ~3GB on 677 files.** Every lookup after is 10–100ms. CLI, eval and Docker all set
  `--max-old-space-size=8192`.
- Reference sets **include the import statements themselves**. Unfiltered, every importer
  becomes a false "call site" at module scope.
- A diff hunk header **spans its context lines**. Using the header's range attributes an
  edit to declarations up to 3 lines away. The parser walks hunk *bodies*; only `+` lines
  count, and a `-` line anchors to where it was removed.
- Recursive Tarjan dies between **1,000 and 5,000** chain depth. Ours is iterative.
- At column 0 the AST chain is `ConstKeyword → VariableDeclarationList → VariableStatement`
  — it never touches `VariableDeclaration`. Two separate guards are needed for local vs
  top-level variables; they cover different code shapes.
- `--head` must be the checked-out revision: the graph is built from files on disk, so any
  other ref resolves the diff's line numbers against different code.

**Tokens**

- `length / 4` **under-counts punctuation-dense code by 41%** — the direction that
  overflows the request. Real BPE (`o200k_base`) costs 40ms for 87k chars.
- Worst measured chars/token: tabs 6.00, typical TS 4.07, punctuation 2.36, spaced chars
  2.00, minified JS 1.71, base64 1.63, symbols 1.50, **emoji 1.25**. The conservative
  fallback divisor is 1.25 for that reason; 2.5 was chosen first and was unsafe.

**Providers (probed against the live APIs without a key)**

- OpenAI serves its **401 body as `text/plain`** — a content-type-driven `.json()` throws
  on the one response that explains the failure.
- Gemini reports an invalid key as **HTTP 400, not 401**, with `reason: "API_KEY_INVALID"`.

**GitHub (probed live, nothing created)**

- Error body is `{message, documentation_url, status}` for both 401 and 404.
- A review on a nonexistent PR is 404, not 401 — which is what proves the path is right.
- An inline comment can only attach to a line **in the diff**, and one rejected comment
  fails the whole review request. Blast-radius findings therefore can never be inline.

**Build**

- `nest build` copies **no non-TS assets** by default. `schema.sql` was missing from
  `dist/` on the first build; `assets` in `nest-cli.json` is what copies it. That failure
  only surfaces in production.
- `express` must be a **direct** dependency: `emitDecoratorMetadata` emits a runtime
  reference to it from `@Req() request: Request`, and a transitive-only install fails to
  resolve under Vitest.

**Cost of grounding** (135-file repo): grounded 6,525 prompt tokens / 1,839ms vs baseline
5,013 / 208ms — **+30% tokens, +1.6s** for 34 cited facts the baseline has none of.

---

## The eval harness

Five corpus cases, each a real two-commit git repository built programmatically:

| Case | Defect | Purpose |
|---|---|---|
| `signature-drift` | caller two modules away never updated, compiles fine | headline claim |
| `new-cycle` | new import closes a cycle | headline claim |
| `layering-breach` | domain imports infrastructure against a declared rule | headline claim |
| `local-bug` | off-by-one fully visible in the diff | **control** — graph should NOT help |
| `clean-refactor` | nothing wrong at all | **control** — does context invent findings? |

`eval/corpus/corpus.spec.ts` validates the corpus *before* it scores anything: every repo
must **compile at head**, and the graph must actually **surface** each structural defect.
If the cycle weren't detected, a tie would prove the corpus was broken, not anything about
context — invisible in the final numbers.

**Scoring is deterministic, no LLM judge.** Same file, within the defect's line tolerance,
and an accepted category. Duplicates credit the defect once. The verdict uses `separated()`
— the gap must exceed the combined run-to-run spread before it is called a difference.
`verdict()` is tested to produce all four sentences: win, loss, no measurable difference,
inconclusive.

---

## Known limits (all in the README)

The blast radius **under-reports** rather than inventing reach:

- Module-scope changes (an edited import) are walked through the reverse module graph at
  module granularity only, capped at 25 dependants.
- References in files the repo's tsconfig excludes are not found; listed in
  `unanalysedFiles`.
- DI by string token and computed `import()` are invisible to a static graph.
- Gemini token counts are estimated with OpenAI's tokenizer.
- The corpus is five small purpose-built repos — enough to detect a large effect, not a
  small one. Scaling to mutations of a real OSS repo is the obvious next step.
- Ranking weights in `evidence-builder.ts` are reasoned, not tuned against measured
  catch-rate. The Phase 3 number is what would justify them.

---

## What's next

**Highest value, one command:** produce the eval number. Everything else is built around it.

Then, in rough order:

- [ ] Dispatch a review from a webhook delivery — needs a queue (Bull/Redis or pg-boss),
      because GitHub retries after ten seconds and a review takes longer.
- [ ] Post a review to a real pull request and confirm the inline/summary split behaves.
- [ ] Publish the Docker image; deploy.
- [ ] Phase 5: pgvector duplicate-logic detection, and a dashboard reusing arch-lens's
      D3/Mermaid output.
