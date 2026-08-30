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
node dist/cli/main-cli.js demo            # runs the built half of the pipeline
node dist/cli/main-cli.js config
node dist/main.js                          # REST API on :3000/api/v1
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
| Ingest, graph engine, context assembler | **not built** | Phases 1–2 |
| Real providers (OpenAI, Gemini) | **not built** | Phase 2 |
| Eval harness | **not built** | Phase 3 |
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

Worse, `TsMorphProjectLoader` sets `skipFileDependencyResolution: true` and skips the target
repo's tsconfig, deliberately, so parsing stays fast and independent of the target's
toolchain. Symbol reference resolution needs the opposite: a type-checked project with real
module resolution. So Phase 1 needs a **second loading mode**, and its cost has to be
measured before the hop limit and ranking defaults are chosen.

Two smaller notes carried forward:

- The Tarjan implementation is recursive. Fine at Arch Lens's scale; a deep repository could
  blow the stack. Convert to an iterative implementation when the graph grows, not before.
- Arch Lens's `lint` script is `eslint --fix`. That repairs the working copy and reports
  success on code that never satisfied the rules. Here `lint` never fixes; `lint:fix` is
  separate, and CI runs `lint`.

Reuse will be by **vendoring with attribution**, not by depending on the package: Arch Lens
is private and unpublished, and these files need adapting (symbol layer, second loader mode)
rather than consuming unchanged.

---

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

### Phase 1 — Graph MVP (no LLM)

The deliverable is a `ChangeImpact` that is correct, on a fixture repo with known structure.

- [ ] **Probe first**: measure ts-morph project load with real dependency resolution + the
      target tsconfig, on a small repo and on this repo. Record cold/warm timings. The hop
      limit, ranking defaults and whether references are resolved eagerly or lazily are all
      decided by that number, not guessed.
- [ ] `src/ingest/`: repo reader (local path), `simple-git` diff between two refs, unified
      diff parser.
- [ ] Changed-**symbol** resolution: map changed line ranges to the enclosing declarations
      via ts-morph, with `added | modified | removed` and whether the symbol is exported.
- [ ] Module dependency graph (vendored from Arch Lens, adapted).
- [ ] Symbol reference graph via the ts-morph language service — the net-new layer.
- [ ] Blast radius: BFS out from each changed symbol to `BLAST_RADIUS_MAX_HOPS`, recording
      hop distance and the changed symbol each site traces back to.
- [ ] Cycle introduction: SCC set of the base graph vs the head graph; report only the
      difference. Requires materialising both revisions — decide worktree vs in-memory and
      write down why.
- [ ] Architecture rules: load `.ripplereview.rules` (e.g. `domain !-> infrastructure`),
      flag violating edges, mark which the change introduced.
- [ ] Instability deltas per module.
- [ ] Fixture repo with a deliberately known structure; assert exact blast-radius sets.

**Risks to settle in this phase, not later**

- A repo that does not typecheck. The reviewer must degrade to module-granularity impact and
  say so, never silently return an empty blast radius.
- Re-exports and barrel files (`index.ts`) inflating fan-in and hop counts.
- Dynamic `import()`, DI-by-string, and framework magic that the graph cannot see. Under-
  reporting is acceptable; claiming completeness is not.

### Phase 2 — Context assembler + first real review

The heart of the project, and the part worth talking about in an interview.

- [ ] Token budgeter with a measurable packing strategy and explicit truncation fallbacks;
      dropped evidence is recorded in `ContextBudget.droppedItemIds`, never dropped silently.
- [ ] Ranking: impacted sites by (hop distance, module fan-in); type/interface definitions
      referenced by changed and impacted code.
- [ ] Evidence serializer: compact `[E1] (kind) summary` lines the model must cite.
- [ ] The real system prompt: grounding contract, category definitions, calibration.
- [ ] OpenAI provider; Gemini provider. Same interface, no vendor leaking upward.
- [ ] Wire `ReviewService.run()` end to end; `--diff-only` produces the baseline context.
- [ ] Golden-context tests: a fixture `ChangeImpact` must assemble to a stable, reviewed
      prompt. This is what stops the assembler regressing invisibly.

### Phase 3 — Eval harness + baseline ← **the resume number**

- [ ] 3–5 fixture repos, each with a ground-truth defect set, weighted toward cross-module
      defects: a change that silently breaks a distant caller, a new cycle, a layering
      violation.
- [ ] Optional: scripted mutations against a real OSS TypeScript repo, for scale.
- [ ] Diff-only baseline: same provider, same model, same prompt, diff only.
- [ ] Metrics: precision, recall, F1, **cross-module catch-rate**, plus tokens, cost, latency
      per review. Both arms run N times; report variance, because a single run of a
      non-deterministic model is an anecdote.
- [ ] Scorecard: Markdown + JSON + chart, committed under `eval/out/`.
- [ ] Runs in CI so the number is reproducible.

**The honesty rule for this phase**: if graph context does not beat the baseline, the
scorecard says so. A number that only ever confirms the thesis is not a measurement.

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
