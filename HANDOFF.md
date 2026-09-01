# RippleReview — session handoff

Paste this whole file into a fresh Claude Code session started in
`C:\Users\Kanish\projects\RippleReview`. It is the complete context needed to continue.

---

## Working agreement (carry this forward)

- **Every commit is authored and committed as me (KanishKhetarpal).** Never add a
  `Co-Authored-By` trailer; never mention Claude, Anthropic, "generated with", or any AI
  attribution in a commit message, PR body, or code comment. Verify before reporting done:
  `git log -5 --format='%an <%ae>'` and
  `git log -5 --format='%B' | grep -Ei "co-authored|generated with|claude" || echo clean`
- **Full autonomy.** Don't present menus or ask to confirm routine decisions. Ask only if
  proceeding either way would be unsafe or waste real work. If I repeat a request after
  you raise a concern, that's my decision — build it.
- **One commit per coherent unit**, made as the work finishes. The message must describe
  what is actually in the commit, and explain *why*, referencing the failure being closed.
- **Probe before you design.** Measure the real thing before writing the code that depends
  on it. Every good decision in this repo came from a probe, and several probes overturned
  what the plan already said.
- **Verify against reality, not mocks.** Integration tests hit real git, a real ts-morph
  language service, a real HTTP server. Run the thing — "it compiles" and "the tests pass"
  are not "it works".
- **Mutation-check your tests.** Break an assertion deliberately and confirm the suite goes
  red. Do this especially when a suite passes on the first try. This has found a vacuous or
  self-referential test in *every* phase so far.
- **Honesty in reporting.** Say plainly what is unverified and keep saying it. Report real
  numbers. Never claim a CI run passed without reading the log.
- **Tooling:** Git Bash for POSIX, PowerShell separately — don't mix syntax. Prefer the
  Write tool or a Python patch script with an `assert old in s` guard over large heredocs.
  Make patch scripts **idempotent** — a `python || py` fallback has run one twice and
  duplicated an edit.

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

- Repo: `C:\Users\Kanish\projects\RippleReview`
- GitHub: `KanishKhetarpal/ripplereview` — **private**. Make it public with:
  `gh repo edit KanishKhetarpal/ripplereview --visibility public --accept-visibility-change-consequences`
- Sibling project it vendors code from: `C:\Users\Kanish\projects\arch-lens` (public)
- Branch `main`, currently at `868881a`. Working tree clean, CI green.

---

## Current state: Phases 0–3 done, Phase 4 next

| Phase | State |
|---|---|
| 0 — Scaffold, config, LLM adapter, CLI, REST, CI | ✅ done |
| 1 — Graph MVP: ingest, blast radius, cycles, rules | ✅ done |
| 2 — Context assembler, real providers, full pipeline | ✅ done |
| 3 — Eval harness + corpus + scorecard | ✅ built, **number not produced** |
| 4 — GitHub PR integration, persistence, Docker | ⬜ next |
| 5 — pgvector duplicate-logic detection, dashboard | ⬜ optional |

**392 tests, 25 files, all passing. Lint, typecheck, build, format all clean.**

Verify with: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test`

---

## ⚠️ THE ONE THING BLOCKING THE HEADLINE CLAIM

**No live model call has ever been made. There is no OpenAI or Google API key on this
machine.** Every scorecard produced so far ran against the offline `echo` stub, which has
no opinion about code. A stub run reports `0.0% vs 0.0%` — that is the harness working, not
a negative result, and the scorecard says so in bold at the top. **Do not quote it.**

There *is* an `ANTHROPIC_API_KEY` in `C:\Users\Kanish\AcharyaUniversityCRM\.env`. I asked
whether to use it and was told to ship the harness unmeasured instead, so no money was
spent and no Anthropic provider was written.

### To produce the real number

```bash
cd C:\Users\Kanish\projects\RippleReview
echo "LLM_PROVIDER=openai" >> .env
echo "OPENAI_API_KEY=sk-..." >> .env
pnpm eval --runs 5
```

Writes `eval/out/scorecard.md`, `scorecard.json`, `catch-rate.svg`. Roughly
`5 cases × 2 arms × 5 runs = 50` calls at ~5–7k prompt tokens each.

Before trusting it, do a single real review first — that is the actual
"one live call per vendor" check that Phase 3 was supposed to open with:

```bash
node dist/cli/main-cli.js review . --base HEAD~1 --head HEAD
```

If Anthropic is the available key instead, add `src/llm/providers/anthropic-llm.provider.ts`
extending `HttpLlmProvider` (~40 lines — copy the Gemini one), add `'anthropic'` to
`PROVIDER_NAMES` in `src/config/env.validation.ts`, and a case in `selectProvider()` in
`src/llm/llm.module.ts`. Probe the live error shape first, as was done for the other two.

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
| `src/review/` | pipeline orchestration, prompt, HTTP surface |
| `src/output/` | terminal + JSON renderers |
| `eval/` | corpus, matcher, metrics, runner, scorecard |

### Commands

```bash
pnpm build
node dist/cli/main-cli.js impact . --base HEAD~1 --head HEAD   # graph only, no model
node dist/cli/main-cli.js review . --base HEAD~1 --head HEAD   # full pipeline
node dist/cli/main-cli.js review . --diff-only                 # eval baseline
node dist/cli/main-cli.js demo                                 # offline fixture
node dist/main.js                                              # REST on :3000/api/v1
pnpm eval --runs 3                                             # score both arms
```

CLI exit codes are a contract: `0` ran clean, `1` blocking findings (gating is Phase 4),
`2` could not run.

---

## Hard-won facts — do not re-derive these

**ts-morph / graph engine**

- `skipFileDependencyResolution: true` produces **identical** reference sets to a fully
  resolving load, and uses ~25x less memory. Measured on a 677-file repo: 741ms/160MB vs
  25s/2.2GB — the resolving load OOM'd Node's default heap. PLAN.md originally claimed a
  second loader mode was needed; that was wrong.
- First reference lookup pays the language service warm-up: **437ms on 135 files, 18.4s and
  ~3GB on 677 files.** Every lookup after is 10–100ms. The CLI and eval scripts already
  pass `--max-old-space-size=8192`.
- Reference sets **include the import statements themselves**. Unfiltered, every importer
  becomes a false "call site" at module scope. `isImportOrExportSpecifier()` filters them.
- A diff hunk header **spans its context lines**. Using the header's range attributes an
  edit to declarations up to 3 lines away. The parser walks hunk *bodies*; only `+` lines
  count, and a `-` line anchors to where it was removed.
- Recursive Tarjan dies between **1,000 and 5,000** chain depth. Ours is iterative.
- At column 0 the AST chain is `ConstKeyword → VariableDeclarationList → VariableStatement`
  — it never touches `VariableDeclaration`. Two separate guards are needed for local vs
  top-level variables; they cover different code shapes.
- `--head` must be the checked-out revision. The graph is built from files on disk, so any
  other ref resolves the diff's line numbers against different code — and it looked
  completely normal until it was refused.

**Tokens**

- `length / 4` **under-counts punctuation-dense code by 41%** — the direction that
  overflows the request. Real BPE (`o200k_base`) costs 40ms for 87k chars.
- Worst measured chars/token: tabs 6.00, typical TS 4.07, punctuation 2.36, spaced chars
  2.00, minified JS 1.71, base64 1.63, symbols 1.50, **emoji 1.25**. The conservative
  fallback divisor is 1.25 for that reason — 2.5 was chosen first and was unsafe.

**Providers (probed against the live APIs without a key)**

- OpenAI serves its **401 body as `text/plain`** — a content-type-driven `.json()` throws
  on the one response that explains the failure. Always read as text first.
- Gemini reports an invalid key as **HTTP 400, not 401**, with `reason: "API_KEY_INVALID"`.
  Classifying errors by status alone reports a bad key as a malformed request.

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
context — and that is invisible in the final numbers.

**Scoring is deterministic, no LLM judge.** A finding identifies a defect when it names the
same file, lands within that defect's line tolerance, and carries an accepted category.
Duplicates credit the defect once and count as neither hit nor false positive. The verdict
uses `separated()` — the gap must exceed the combined run-to-run spread before it is called
a difference. `verdict()` is tested to produce all four sentences: win, loss, no measurable
difference, inconclusive.

---

## Known limits (all documented in README)

The blast radius **under-reports** rather than inventing reach:

- Module-scope changes (an edited import) are walked through the reverse module graph at
  module granularity only, capped at 25 dependants.
- References in files the repo's tsconfig excludes are not found; those files are listed in
  `unanalysedFiles`.
- DI by string token and computed `import()` are invisible to a static graph.
- Gemini token counts are estimated with OpenAI's tokenizer.
- The corpus is five small purpose-built repos — enough to detect a large effect, not a
  small one. Scaling to mutations of a real OSS repo is the obvious next step.
- Ranking weights in `evidence-builder.ts` are reasoned, not tuned against measured
  catch-rate. Phase 3's number is what would justify them.

---

## Phase 4 — what's next

- [ ] PostgreSQL: `runs`, `findings`, `impact_snapshots`, with tokens/cost/latency per run.
- [ ] `GET /api/v1/review/runs/:id` (currently 501 — the only remaining stub endpoint).
- [ ] GitHub App / webhook: PR opened or synchronised → review.
- [ ] Inline review comments anchored to `file:line`, plus one summary comment carrying the
      blast-radius overview and the evidence table.
- [ ] GitHub Action wrapping the CLI; exit 1 above a severity threshold (the exit-code
      contract already exists and is tested).
- [ ] Docker image; deploy.

**Suggested first move:** produce the Phase 3 number if a key is available — it is one
command and it is what the whole project is for. Otherwise start on persistence, which is
self-contained and unblocks `GET /runs/:id`.
