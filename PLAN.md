# RippleReview — Implementation Plan

An AI code reviewer that beats diff-only review by feeding the model **graph-grounded
blast-radius context**: what a change actually reaches across the repository, computed
deterministically and handed over as cited evidence.

---

## 0. The thesis, and what follows from it

We are not trying to out-reason the frontier model on a raw diff. Everyone calls the same
model. We win on **context engineering**: deterministic static analysis assembles better
input, and the same model becomes dramatically more useful.

Two rules fall out of that, and they constrain every decision below.

**Structural claims come from the graph, never from the model.** Blast radius, cycles and
layering violations are computed and cited. The model reasons about correctness *given*
those facts. This is enforced in code, not by prompt wording: `enforceGrounding()` drops a
structural finding that cites nothing, and drops any finding citing an evidence id we never
supplied. An invented call site delivered with a citation is worse than no finding at all,
because it reads as verified.

**The eval harness is a deliverable, not an afterthought.** The claim — "same model, graph
context, N% more cross-module defects caught than diff-only" — exists only if it is
measured. Phase 3 exists to produce that number, and the diff-only baseline runs the same
model with the same prompt over the diff alone so the comparison is fair.

---

## 1. What already exists (Phase 0, shipped)

Runnable today:

```bash
pnpm install
pnpm build
node dist/cli/main-cli.js impact . --base HEAD~1 --head HEAD   # the graph engine
node dist/cli/main-cli.js review . --base HEAD~1 --head HEAD   # the full pipeline
node dist/cli/main-cli.js review . --diff-only                 # the eval baseline
pnpm eval --runs 3                                             # score both arms
node dist/cli/main-cli.js config
node dist/main.js                                              # REST API on :3000/api/v1
```

| Stage | State | Where |
|---|---|---|
| Domain contracts (`ChangeImpact`, `EvidenceItem`, `Finding`, `ReviewResult`) | done | `src/core/types/` |
| Grounding guard | done | `src/core/grounding.ts` |
| Config + env validation (zod, fails at boot) | done | `src/config/` |
| Provider-agnostic LLM adapter + echo stub | done | `src/llm/` |
| Response parsing, schema validation, repair loop | done | `src/llm/parsing/`, `src/llm/llm.service.ts` |
| Terminal + JSON report renderer | done | `src/output/` |
| CLI (`review`, `demo`, `config`) with documented exit codes | done | `src/cli/` |
| REST API (`/health`, `/review`, `/review/demo`) | done | `src/health/`, `src/review/` |
| CI (lint, typecheck, build, test) | done | `.github/workflows/ci.yml` |
| Ingest: git diff, unified-diff parser, changed-symbol resolution | done | `src/ingest/`, `src/graph/symbol-locator.ts` |
| Graph engine: module graph, blast radius, cycles, rules, instability | done | `src/graph/` |
| `ripplereview impact` — the graph engine with no model involved | done | `src/cli/`, `src/output/impact-renderer.ts` |
| Context assembler: token budgeter, ranking, evidence serializer | done | `src/context/` |
| Real providers (OpenAI, Gemini) | built, **never run against a live API** | `src/llm/providers/` |
| `ripplereview review` — the full pipeline, and `--diff-only` baseline | done | `src/review/` |
| Eval harness: corpus, matcher, metrics, scorecard | done | `eval/` |
| **The number itself** | **not produced** — needs a model key | Phase 3, blocked |
| Persistence, GitHub App | **not built** | Phase 4 |

`GET /api/v1/health` reports that table at runtime, so nothing has to be assumed from a doc.
`ripplereview review <repo>` refuses with exit 2 and names the missing phase rather than
returning an empty result.

---

## 2. Reusing Arch Lens — what actually transfers

Arch Lens (`~/projects/arch-lens`, 133 TS files, NestJS + ts-morph) is the foundation this
project was meant to build on. Reading it before planning changed the plan, so the finding
is recorded here rather than discovered in Phase 1:

**Transfers close to as-is**

- `src/ingestion/` — source-file enumeration, ignore rules, filesystem + git repo readers.
- `src/parser/project/ts-morph-project-loader.ts` — in-memory `Project` construction.
- `src/parser/extraction/import-export-extractor.ts` — import/export edges per file.
- `src/graph/builder/module-specifier-resolver.ts` — specifier → repo-relative path.
- `src/graph/analysis/cycle-detector.ts` — Tarjan SCC, generic over node ids.
- `src/graph/analysis/graph-metrics.ts` — fan-in, fan-out, Martin instability.

**Does not transfer, and this is the important part**

Arch Lens's graph is **file granularity only**: `GraphEdge` is `{from, to, specifier}` between
repo-relative paths. RippleReview's central promise is *symbol* blast radius — "which call
sites does this changed function reach" — and there is no symbol layer to reuse. That is
net-new work in Phase 1, and it is the differentiating half.

~~Worse, `TsMorphProjectLoader` sets `skipFileDependencyResolution: true` ... so Phase 1
needs a **second loading mode**.~~ **Wrong — corrected by measurement, see §2a.** There is
one loading mode, and it is the cheap one.

Two smaller notes, both since resolved:

- The Tarjan implementation is recursive, so its stack depth is the longest dependency chain
  in the repository. Measured: 1,000 links fine, 5,000 links throws. Rewritten iteratively.
- Arch Lens's `lint` script is `eslint --fix`. That repairs the working copy and reports
  success on code that never satisfied the rules. Here `lint` never fixes; `lint:fix` is
  separate, and CI runs `lint`.

Reuse is by **vendoring with attribution**, not by depending on the package: Arch Lens is
unpublished, and these files needed adapting (symbol layer, extra module-resolution forms)
rather than consuming unchanged.

---

## 2a. What the Phase 1 probes measured

Phase 1 opened with a probe, as planned. It changed three decisions and corrected one claim
this document had already made. Numbers are from this machine; re-measure before trusting
them elsewhere.

**Loader cost, by repository size**

| Repo | Files | Cheap load | Resolving load | 1st reference lookup | Later lookups |
|---|---|---|---|---|---|
| RippleReview | 35 | 105ms / ~9MB | 1702ms / ~100MB | 894ms | 14ms |
| arch-lens | 135 | 105ms / ~9MB | 1084ms / ~106MB | 437ms | 9ms |
| a NestJS CRM | 677 | 741ms / ~160MB | **24.9s / ~2.2GB** | 18.4s (heap → 3.0GB) | 102ms |

**1. One loading mode, not two.** `skipFileDependencyResolution: true` produces reference
sets *identical* to a fully resolving load — verified across two repositories for functions,
classes and methods. It works because the tsconfig has already added every file in the
repository, so references between them resolve from the file set rather than from the
resolver. What it skips is pulling in node_modules type definitions, which the language
service then does not have to hold. The resolving load OOM'd Node's default heap on the
677-file repository outright, so this is not an optimisation — it is what makes a repository
of that size analysable at all.

**2. The base graph is built by adjusting the head graph, not by loading the base revision.**
Cycle comparison needs both revisions at once, and two loads of a large repository do not
fit. A file that did not change has identical imports at both refs, so only the changed files
need their base content fetched — typically under twenty `git show` calls rather than one per
file. Exact for import-graph purposes, and it never touches the user's working tree.

**3. Reference sets include the import statements themselves.** Probed directly: a symbol
used through a barrel file comes back with both the `import` line and the actual call, in
every importing file. Counted, every module that merely imports a changed symbol becomes an
impacted site — and because the import sits at module scope, the *whole file* is reported as
impacted whether or not anything in it uses the symbol. Import and export specifiers are
filtered out.

**4. The recursive Tarjan does not survive a real monorepo.** Measured against arch-lens's
implementation: 1,000-link chain fine, 5,000-link chain throws "Maximum call stack size
exceeded". Rewritten with an explicit stack; the spec covers 50,000 links.

**Still open, and known:**

- A **first reference lookup on a large repository costs ~18s and ~3GB**. That is a one-time
  warm-up and every later lookup is ~100ms, but the default Node heap will not survive it.
  Raising the heap for the CLI, and reporting warm-up separately from lookup cost, is Phase 2
  work.
- **Module-scope changes are not walked.** An edited import has no declaration to look
  references up from, so its dependents are reported at module granularity only. The renderer
  says so rather than reporting "nothing was impacted". Walking the module graph's reverse
  edges for these would close it.
- **A reference in a file the tsconfig does not include is not found** — a sibling package in
  a monorepo. Under-reporting, which is the acceptable direction, but it is not reported yet.
- **`--head` must be the checked-out revision.** The graph is built from the files on disk;
  analysing another ref would resolve the diff's line numbers against different code. It is
  refused rather than silently wrong. Materialising an arbitrary revision means a worktree
  checkout, which is its own decision.

## 3. Architecture

```
   PR / local diff
        |
        v
 1. INGEST            local folder + git diff | two refs | GitHub PR
                      parse whole repo (ts-morph); resolve CHANGED SYMBOLS, not just lines
        |
        v
 2. GRAPH ENGINE      deterministic, no LLM
                      blast radius per changed symbol (N hops, default 3)
                      cycles introduced (SCC set: base vs head)
                      layering violations vs .ripplereview.rules
                      fan-in / fan-out / instability deltas
                      => ChangeImpact  (ground truth)
        |
        v
 3. CONTEXT ASSEMBLER  <-- the differentiator, most of the engineering effort
                      token budget; diff always in; rank impacted sites by (hops, fan-in)
                      pull the type defs the changed + impacted code references
                      serialize graph facts as cited [E1..En] evidence
        |
        v
 4. LLM REVIEW        provider-agnostic adapter (OpenAI | Gemini | echo)
                      grounded prompt -> findings JSON -> zod -> repair -> GROUNDING GUARD
        |
        v
 5. OUTPUT            CLI report | REST API | GitHub inline + summary comments

 6. EVAL HARNESS      parallel track, first-class
                      defect corpus -> RippleReview vs diff-only baseline (same model)
                      precision / recall / F1 / cross-module catch-rate / tokens / cost / latency
```

---

## 4. File tree (target, end of Phase 4)

```
ripplereview/
├─ PLAN.md                          this file
├─ README.md
├─ .github/workflows/ci.yml
├─ .ripplereview.rules.example      architecture rules (layering) config
├─ src/
│  ├─ main.ts                       REST bootstrap
│  ├─ app.module.ts
│  ├─ cli/main-cli.ts               commander entrypoint
│  ├─ common/zod-validation.pipe.ts
│  ├─ config/                       env schema, eager validation, typed accessors
│  ├─ core/
│  │  ├─ grounding.ts               structural claims must cite evidence
│  │  └─ types/                     ChangeImpact · Evidence · Finding · ReviewResult
│  ├─ ingest/                       [P1] repo reader, diff parser, changed-symbol resolver
│  ├─ graph/                        [P1] symbol + module graph, blast radius, cycles, rules
│  ├─ context/                      [P2] token budgeter, ranking, evidence serializer
│  ├─ llm/
│  │  ├─ interfaces/                LlmProvider
│  │  ├─ providers/                 echo · [P2] openai · [P2] gemini
│  │  ├─ parsing/finding-parser.ts  balanced-JSON extraction + zod + repair instruction
│  │  └─ llm.service.ts             repair loop, usage accounting
│  ├─ review/                       pipeline orchestration, HTTP surface
│  ├─ output/                       terminal + JSON renderer, [P4] GitHub comment renderer
│  ├─ db/                           [P4] runs · findings · impact_snapshots
│  └─ github/                       [P4] App webhook, PR comments, Action
└─ eval/                            [P3] FIRST-CLASS
   ├─ corpus/                       3–5 fixture repos, each with a ground-truth defect set
   ├─ baseline/                     diff-only reviewer: same model, same prompt, no graph
   ├─ metrics/                      precision · recall · F1 · cross-module catch-rate
   └─ report/                       Markdown + JSON scorecard, chart
```

---

## 5. Phases

Each phase ends green on `pnpm lint && pnpm typecheck && pnpm build && pnpm test`, with
tests written alongside — not after.

### Phase 0 — Scaffold ✅ done

- [x] NestJS project, TypeScript strict, pnpm
- [x] Vitest + SWC transform (esbuild does not emit `emitDecoratorMetadata`, so Nest DI
      would silently fail to resolve under the default transform)
- [x] ESLint 9 flat config, type-checked rules; `lint` never fixes, `lint:fix` is separate
- [x] Config module: zod env schema, cross-field rules, eager synchronous validation
- [x] Core domain contracts and the grounding guard
- [x] Provider-agnostic LLM adapter + deterministic `echo` stub
- [x] Finding parser: balanced JSON extraction, zod validation, repair round-trip
- [x] Terminal + JSON renderer
- [x] CLI with documented exit codes (0 ok / 1 blocking findings / 2 could not run)
- [x] REST API with an honest `/health` stage report
- [x] CI: lint → typecheck → build → test, no auto-fix, no silent skips
- [x] PLAN.md and README

### Phase 1 — Graph MVP (no LLM) ✅ done

`ripplereview impact <repo> --base <ref> --head <ref>` produces a `ChangeImpact` and renders
it. Verified against a fixture repository with a known dependency structure (blast radius
asserted as exact SETS, not counts) and run against a real 135-file repository.

- [x] **Probe first** — see §2a. It corrected this plan rather than confirming it.
- [x] `src/ingest/`: git via `simple-git`, `--find-renames`, unified-diff parser.
- [x] Changed-**symbol** resolution: changed lines → innermost enclosing declaration, with
      `added | modified | removed` and whether it is reachable from outside the module.
- [x] Module dependency graph (vendored from arch-lens, extended for `.mts`/`.cts` and for
      the NodeNext rule that `./x.js` resolves to `./x.ts`).
- [x] Symbol reference graph via the ts-morph language service — the net-new layer.
- [x] Blast radius: BFS to `BLAST_RADIUS_MAX_HOPS`, shortest distance wins, lookup ceiling
      with truncation reported rather than silently returning a partial answer.
- [x] Cycle introduction: SCC of base vs head, pre-existing cycles reported but not blamed.
- [x] Architecture rules: `.ripplereview.rules`, `deny <glob> -> <glob>`, malformed line is
      an error rather than a skip.
- [x] Instability deltas, for the touched modules only.
- [x] Fixture repo with a known structure; exact blast-radius set assertions.

**Risks this phase was meant to settle, and what happened**

- *A repo that does not typecheck*: not a problem in practice. The loader never type-checks,
  and reference lookup is resolution-based, so a repository with type errors still yields a
  graph. Untested against a repository that does not **parse**.
- *Re-exports and barrel files*: handled. Barrel edges are in the module graph (that is where
  cycles hide), and a barrel that only re-exports a symbol is correctly not an impacted site.
- *Dynamic `import()` and DI-by-string*: a literal `import('./x')` is an edge; a computed one
  is skipped rather than guessed at. Nest's DI-by-token is invisible to the graph, so the
  blast radius under-reports for it — accepted, and the direction to be wrong in.

### Phase 2 — Context assembler + first real review ✅ done

`ripplereview review <repo>` runs ingest → graph → assemble → model → grounding, and
`--diff-only` runs the same pipeline with the evidence block removed.

- [x] Token budgeter with an inspectable packing strategy; every dropped item recorded in
      `budget.droppedItemIds` and stated in the prompt.
- [x] Ranking: introduced cycle > introduced violation > impacted sites (by hop, then
      fan-in) > type definitions > pre-existing findings > instability.
- [x] Type/interface definitions quoted from the project the graph engine already loaded.
- [x] Evidence serializer: one citable `[E1] (kind) file:line summary` line per fact.
- [x] The real system prompt: grounding contract, category and severity definitions.
- [x] OpenAI and Gemini providers behind the same interface, with shared retry and timeout.
- [x] `ReviewService.run()` wired end to end; `--diff-only` produces the baseline.
- [x] Golden-context test pinning the exact assembled prompt.
- [x] Carried over from Phase 1: CLI heap raised, warm-up reported apart from lookup cost,
      module-scope changes walked through the reverse module graph, unanalysed files
      reported on the result.

**What the Phase 2 probes measured**

*Token counting.* The familiar `length / 4` heuristic is not safe for this text. Against
real BPE (`o200k_base`): ordinary TypeScript over-counts by 8-11%, but punctuation-dense
code **under-counts by 41%** — and under-counting overflows the model's context and fails
the request after the graph engine has already done its work. Real BPE costs 40ms for 87k
characters, so it is the default. Counting items separately over-counts slightly against
counting the whole (29 vs 28 tokens on a two-part sample), which is the safe direction.

The conservative fallback divisor is **1.25**, not the 2.5 first chosen. Characters per
token by shape: tabs/newlines 6.00, typical TypeScript 4.07, punctuation 2.36, spaced
characters 2.00, minified JS 1.71, base64 1.63, symbols 1.50, **emoji 1.25**. The first
guess assumed punctuation-dense code was the worst case; it is not, and a comment
containing emoji would have overflowed.

*Provider wire formats*, verified against the live APIs without a key:

- OpenAI's endpoint is right (401, while a deliberately mistyped path gives 404) and it
  serves its **401 body as `text/plain`** — a content-type-driven `.json()` would throw on
  the one response that explains the failure.
- Gemini reports an invalid key as **HTTP 400, not 401**, with `status:
  "INVALID_ARGUMENT"` and a nested `reason: "API_KEY_INVALID"`. Classifying errors by
  status alone would report a bad key as a malformed request.

*Cost of grounding*, measured on a 135-file repository: the grounded arm sent 6,525 prompt
tokens in 1,839ms against the baseline's 5,013 tokens in 208ms — **+30% tokens, +1.6s**,
for 34 cited facts the baseline has none of. Phase 3 has to weigh the catch-rate against
exactly that.

**⚠️ Unverified: no live model call has ever been made.** There is no OpenAI or Google key
on this machine. Both providers are exercised against a real local HTTP server — the path,
the auth header, the body shape and every error path — but "the model returns findings we
can parse" is verified only through the deterministic echo stub. The first thing Phase 3
must do is one real call per vendor.

### Phase 3 — Eval harness + baseline ← **the resume number**

**Harness done. The number is not produced: it needs a model key, and there is none on the
machine this was built on.** Everything below the last item is built, tested and runs.

- [x] Defect corpus: five real two-commit git repositories, built programmatically.
- [x] Diff-only baseline arm, sharing one application context with the grounded arm so the
      provider, model and prompt are provably identical.
- [x] Metrics: precision, recall, F1, **cross-module catch-rate**, tokens, latency, and the
      spread across runs.
- [x] Scorecard: Markdown + JSON + a dependency-free SVG chart, under `eval/out/`.
- [x] Runs in CI against the offline stub, so a harness that stops working is caught on the
      day it breaks rather than the day someone needs the number.
- [ ] **Run it against a real model.** `OPENAI_API_KEY=... pnpm eval --runs 5`.

**The corpus, and why each case is there**

| Case | Defect | What it tests |
|---|---|---|
| `signature-drift` | a caller two modules away never updated, compiles fine | the headline claim |
| `new-cycle` | a new import closes a cycle the diff cannot show | the headline claim |
| `layering-breach` | domain imports infrastructure, against a declared rule | the headline claim |
| `local-bug` | off-by-one inside one function, fully visible in the diff | **control** — graph context should NOT help |
| `clean-refactor` | nothing wrong at all | **control** — does extra context provoke invented findings? |

The two controls are what let a win be attributed. Without `local-bug`, a better score
could just mean "more context helps"; without `clean-refactor`, nothing measures whether
the evidence block makes the model imagine problems.

`corpus.spec.ts` validates the corpus before it is ever used to score a model: every
repository must **compile at head** (a defect that breaks the build would be caught by tsc,
not by a reviewer), and the graph engine must actually **surface** each structural defect.
If the cycle were not detected, the grounded arm would have no more information than the
baseline, and a tie would prove the corpus was broken rather than anything about context —
a failure that is invisible in the final numbers.

**How a finding is credited.** Same file, within the defect's line tolerance, and a
category the defect accepts. The category rule is what stops a reviewer scoring well by
emitting one vague finding per file. Several findings identifying one defect credit it
once, and the extras count as neither hits nor false positives — calling them wrong would
punish thoroughness, crediting them twice would let one repeated finding inflate recall.
**No language model is involved in scoring**; an LLM judge would put the thing under
measurement inside the measurement.

**The scorecard is allowed to say the thesis failed.** The verdict is computed from
`separated()`, which requires the gap between arms to exceed their combined run-to-run
spread before it is called a difference at all. A scorecard that reported any positive gap
as a win would confirm the thesis whatever the data said. `verdict()` is unit-tested to
produce all four sentences: a win, a loss, no measurable difference, and inconclusive.

**⚠️ What a stub run means.** `pnpm eval` with `LLM_PROVIDER=echo` completes in ~8s and
reports 0.0% vs 0.0%. That is the harness working, not a negative result, and the scorecard
says so in bold at the top. Do not quote it.

### Phase 4 — GitHub PR integration + CI + persistence

- [ ] PostgreSQL: `runs`, `findings`, `impact_snapshots`, with tokens/cost/latency per run.
- [ ] `GET /runs/:id` (currently 501).
- [ ] GitHub App / webhook: PR opened or synchronised → review.
- [ ] Inline review comments anchored to `file:line`; one summary comment carrying the
      blast-radius overview and the evidence table.
- [ ] GitHub Action wrapping the CLI; exit code 1 on findings above a severity threshold.
- [ ] Docker image; deploy.

### Phase 5 — Optional stretch

- [ ] pgvector duplicate-logic detection: embed functions, flag near-duplicate logic the
      change reintroduces. A graph cannot catch this; embeddings can.
- [ ] Web dashboard with blast-radius visualisation, reusing Arch Lens's D3/Mermaid output.

---

## 6. Scope guardrails

- Not a linter or formatter replacement; assume ESLint and Prettier already ran.
- TypeScript/JavaScript only for v1. Multi-language is future work.
- No effort spent trying to out-reason the model on a raw diff. Effort goes to context,
  grounding and measurement.
- The provider stays swappable. A vendor welded into the pipeline would make the central
  comparison impossible to run.

---

## 7. Definition of done (v1)

- [ ] `ripplereview review <repo> --base <ref> --head <ref>` prints grounded findings with
      blast-radius context and citations.
- [ ] Findings are structured, schema-valid, and reference graph evidence.
- [ ] The eval harness outputs a scorecard comparing RippleReview against the diff-only
      baseline on a defect corpus, reporting cross-module catch-rate, precision/recall, cost
      and latency.
- [ ] A GitHub Action posts inline and summary comments on a pull request.
- [ ] README carries the architecture diagram, quick-start, and the eval scorecard.
