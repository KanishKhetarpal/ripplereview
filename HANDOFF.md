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
| 4 — Persistence, GitHub integration, queue, Action, Docker | ✅ done |
| 5 — Duplicate-logic detection, pgvector corpus, dashboard | ✅ done |

**546 passing locally, 50 skipped (they need Postgres). In CI, where a pgvector service
container runs, the skipped ones run instead — bar the handful that assert behaviour with
persistence switched OFF, which skip there.**

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

The whole path is built and drained by a worker — verify signature, queue, clone, review,
post — and every step is tested against a real dependency except the last. The GitHub
client's paths, auth header and error shapes were probed against the live API without
creating anything (a review on a nonexistent PR answers 404; a bad token answers 401), but
`POST /pulls/:n/reviews` has never actually run.

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
| `src/duplicates/` | function fingerprints, similarity search, pgvector corpus |
| `src/dashboard/` | server-rendered run history and blast-radius SVG |
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

**git, the queue, and the checkout**

- `git clone` **IGNORES `--depth` and `--filter` for a local path** — it says so in a
  warning. A test that clones from a bare filesystem path therefore exercises neither
  flag. Cloning over a `file://` URL applies them, which is what makes the depth assertion
  in `pr-checkout.service.spec.ts` mean anything. Found by mutation testing: swapping
  `--filter=blob:none` for `--depth=1` passed the whole suite.
- Measured over `file://`: with `--depth=1`, `git merge-base HEAD FETCH_HEAD` returns
  **nothing** — a shallow clone has no common ancestor — and the base silently falls back
  to the target branch tip. Every commit that landed on the target since the fork then
  reads as part of the pull request.
- The base must be the **merge base**, not the target branch tip, for the same reason.
- GitHub reuses its **delivery id across retries**, which is what makes it the correct
  idempotency key. `ON CONFLICT DO NOTHING`, not a prior SELECT: two instances handling the
  same retry would both find nothing and both insert.
- `FOR UPDATE SKIP LOCKED` is why several workers are safe. Attempts are counted on
  **claim**, not on failure, so a job that kills the worker still burns one; and a claim is
  a state change rather than a lease, so `requeueStale()` runs at boot to recover rows a
  crashed instance left `running`.

**Duplicate detection**

- The plan said "a graph cannot catch this; embeddings can". Half of that is right. A
  deterministic structural fingerprint separates clones from unrelated code by an enormous
  margin with no model at all: across two repositories, unrelated pairs sit at a median
  cosine of **0.05** and a p95 of 0.30–0.38, a renamed copy at **1.00**, and a copy with a
  statement changed at **0.92–0.96**. 0.85 is the empty space between the two populations.
- Run over a 4,000-file production codebase, the top of the ranking was real copy-paste
  every time — one helper duplicated across four services, another across two, a pair of
  event handlers that are the same function twice. On this repository's own source it found
  four hand-copied `ChangeImpact` fixture builders.
- **Keeping called method names in the token stream is what makes it precise.** Measured on
  the fixture: two functions with an identical skeleton calling different methods score
  **0.018**. With call names abstracted they would be near-identical. The cost is real —
  renaming a local that is itself *called* moves the fingerprint, so recall on a synthetic
  rename-everything clone is 74–92% rather than ~100%.
- Shingle width **k=5** and **256** dimensions, both measured. k=3 lets unrelated pairs run
  hot (median 0.20); k=7 separates best but is the most brittle to an edit. 512 dimensions
  are indistinguishable from 256 on separation, so the smaller wins.
- **A function matches a closure nested inside it at ~0.94**, because one body is literally
  part of the other. Excluded by line-range overlap. This was found in probe output, not in
  production.
- Brute force is fine at repository scale: **100 queries against 1,235 vectors in 61ms**. No
  ANN index, which would trade exactness on a claim that is supposed to be exact.
- `CREATE EXTENSION vector` must NOT go in `schema.sql`. That file is applied on every boot
  in one transaction, so a missing extension would stop the application from starting rather
  than merely disabling a feature. It is applied separately and its failure is caught.
- **`units.length < 2` was a real bug once a corpus existed.** The detector returned early
  when a repository held fewer than two comparable functions — correct while the only
  search was in-memory, wrong the moment other repositories were reachable: a
  single-function service could neither be told it had copied something nor contribute
  anything for the next repository. Found by writing the cross-repository test, not by
  reading the code. Now only "the change touched nothing" returns early.
- Repository identity must be the **origin URL**, not the path: a pull request is reviewed
  in a throwaway clone, so path identity makes every CI run a new repository and hands a
  project its own functions back as cross-repository duplicates. Strip credentials from it —
  the checkout injects a token into the clone URL, which would otherwise become a primary key.
- **The ten-slot cap was ranked by similarity alone and duplicated test fixtures filled it.**
  The very first real run of this detector — against this repository — reported ten matches,
  every one a copy-pasted test fixture; a copy-pasted production function would have scored
  no higher and could not have displaced any of them. Measured: on this repository a test
  file's module fan-in is 0 for 40 of 40 with no exception, against a median of 3 (max 28)
  for source files — near-binary, not fuzzy. Fixed by ranking on fan-in first and similarity
  only to break ties, using the fan-in the graph engine had already computed for the blast
  radius (`headMetrics`, threaded into `DuplicateDetectorService.detect` as `moduleFanIn`).
  **No path pattern anywhere** — a `*.spec.ts` glob was the obvious fix and was rejected: it
  is a guess about naming conventions this tool has never looked at outside its own repo, and
  it would still rank a genuinely unimported production file (an entry point, a deliberately
  standalone config module) below a heavily-copied test helper. Pinned by a fixture built to
  fail on the unfixed code: eleven zero-fan-in near-duplicate pairs plus one real copy-paste
  at fan-in 1 on each side — similarity-only ranking loses the one that matters, every time,
  because a pure rename scores higher than a realistic copy with one variable folded away.
  Five mutations, all red, including one that reverted only the two-line wiring change in
  `ChangeImpactService` — the ranking-only tests didn't catch that one; a separate test going
  through the real service, not calling the detector directly, was needed to pin it.

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

Eight corpus cases, each a real two-commit git repository built programmatically:

| Case | Defect | Purpose |
|---|---|---|
| `signature-drift` | caller two modules away never updated, compiles fine | headline claim |
| `new-cycle` | new import closes a cycle | headline claim |
| `layering-breach` | domain imports infrastructure against a declared rule | headline claim |
| `duplicate-logic` | new helper re-implements one the diff never mentions | headline claim |
| `real-repo-signature-drift` | the same signature-drift shape, grafted onto a vendored slice of a real codebase | headline claim, on real code |
| `real-repo-new-cycle` | the same slice, a different defect: an extracted helper closes a cycle | headline claim, on real code |
| `local-bug` | off-by-one fully visible in the diff | **control** — graph should NOT help |
| `clean-refactor` | nothing wrong at all | **control** — does context invent findings? |

`real-repo-signature-drift` and `real-repo-new-cycle` share one vendored slice — eleven
files, unmodified, from `arch-lens` (`eval/corpus/__fixtures__/arch-lens-slice/SOURCE.md`
has the pinned commit and file list — this project's own sibling, not public third-party
OSS, but real production code rather than another hand-typed snippet). Each case's `head`
independently overrides only the files its own defect touches, so the two never interfere.

`real-repo-signature-drift`: `resolveModuleSpecifier` gains an opt-in
`caseInsensitiveFilesystem` parameter; one real caller (`dependency-graph-builder.ts`) is
updated to pass it, the other real caller (`di-graph-builder.ts`, in a different top-level
folder) is not — mirroring `signature-drift`'s shape on code nobody wrote to make the point.

`real-repo-new-cycle`: the "which paths are known" set-building logic — duplicated
verbatim in both real builder files — is pulled out of `dependency-graph-builder.ts` into
an exported helper instead of into the leaf `module-specifier-resolver.ts` already sits in;
that leaf then imports the helper back so a caller holding symbols can reuse it. The
builder already imports `resolveModuleSpecifier` from the leaf, so the new import closes a
two-file cycle — the same "someone extracts a helper into the wrong file" mistake real
codebases actually make, not one invented to fit the corpus.

**Vendoring real framework code into a from-scratch fixture needs ambient shims.** The
harness never runs `pnpm install` for a corpus repo, so the vendored files' real
`@nestjs/common` and `node:path` imports have nothing to resolve against. A small
`declare module` `.d.ts` (`_harness-shims.d.ts`, documented as not-vendored-content in
SOURCE.md) satisfies them at the type level only. **The first attempt put that shim under a
plain `fixtures/` directory inside the root tsconfig's `include` — it leaked:** an ambient
module declaration is global to whatever TypeScript program contains it, so the stub's
one-export `@nestjs/common` silently shadowed the real one for the *whole project*, and
`pnpm lint`/`typecheck` broke everywhere `@nestjs/common` is used for anything but
`Injectable`. Renaming the directory to `__fixtures__` — the exact convention
`src/graph/__fixtures__` and `src/duplicates/__fixtures__` already use, already excluded by
`tsconfig.json` and `vitest.config.mts` — fixed it; `eslint.config.mjs` needed its own
explicit ignore added, since ESLint's ignore list is separate from both.

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
- The corpus is eight small repos — enough to detect a large effect, not a small one. Two
  (`real-repo-signature-drift`, `real-repo-new-cycle`) are now built from a vendored real
  codebase rather than a hand-typed snippet; scaling further with genuine third-party OSS
  repositories remains open.
- Ranking weights in `evidence-builder.ts` are reasoned, not tuned against measured
  catch-rate. The Phase 3 number is what would justify them.

---

## What's next

**Highest value, one command:** produce the eval number. Everything else is built around it.

Then, in rough order:

- [ ] Post a review to a real pull request and confirm the inline/summary split behaves.
      Everything up to that call is tested; the call itself has never run.
- [ ] Publish the Docker image; deploy.
- [x] Scale the corpus beyond six purpose-built repositories — `real-repo-signature-drift`
      grafts the same defect shape onto a vendored slice of a real codebase instead of a
      hand-typed one. Genuine third-party OSS repositories remain a further step.
