# Design and decisions

## Scope

`dsh-memory` is a DeepSeek Harness bundle: a Host pipeline plugin plus a Web settings page. It
turns historical root-session logs into durable long-term memory — a two-phase extraction and
consolidation pipeline adapted from the Codex memories system onto DSH primitives, plus a read
path that injects a dense summary into every session and exposes four retrieval tools.

The plugin owns its memory directory and its KV-backed bookkeeping. It never rewrites session
logs or touches the deployment agent preset. Phase 1 calls the LLM directly; Phase 2 runs a
fresh, one-shot in-process child through the Harness subagent seam after session boundaries.

## Decision record

Confirmed with the user before implementation (2026-02):

| Decision | Choice | Rationale |
| --- | --- | --- |
| Memory root | `$DSH_HOME/memories` (configurable) | Codex-style global consolidation; workspace context is preserved per rollout instead |
| Phase 2 executor | Built-in `spawn` one-shot subagent | Matches Codex's dedicated consolidation-agent behavior without a separate service; supports progressive evidence reads and a strict per-child tool allowlist |
| Read path | Summary injected + tools on demand | `memory_summary.md` is token-budgeted navigation; details stay in MEMORY.md / rollout summaries |
| Trigger | Startup catch-up + turn-end debounce | Codex startup task plus DSH event-driven freshness; idle debounce doubles as the "idle long enough" guard |

## Architecture

```
session logs ──(sessionQuery/sessionPersistence)──► Phase 1 (per session)
                                                      ├─ filter → render → redact
                                                      ├─ llm extract → {raw_memory, rollout_summary, rollout_slug}
                                                      ├─ write rollout_summaries/<slug>.md
                                                      └─ append raw_memories.md
                                                                  │
                                                    (cooldown, pending flag)
                                                                  ▼
                                          Phase 2 (global, single-flight)
                                                      ├─ spawn fresh in-process child
                                                      ├─ allow memory_list/read/search only
                                                      ├─ validate structured artifacts
                                                      ├─ atomically write MEMORY.md + summary
                                                      └─ rotate raw_memories.md → archive
                                                                  │
                                                                  ▼
                                          read path: systemPrompt section (summary, cached)
                                                     memory_list / memory_read / memory_search / memory_add
```

### Codex concepts → DSH primitives

| Codex | dsh-memory |
| --- | --- |
| state DB (`threads`, `stage1_outputs`, `jobs`) | storage hub KV (`json` backend): claims, cooldown, pending flag, overrides |
| rollout JSONL files | session logs via `sessionQuery.readSession` / `sessionPersistence.load` |
| startup task, stage-1 job leases, retry backoff | boot catch-up + `agent/turn-stopping` debounce; per-session claims with backoff and restart recovery |
| global Phase 2 lock + dedicated agent + 6h cooldown | in-process single-flight + configurable cooldown + fresh `spawn` child |
| Phase 1 `low` reasoning / Phase 2 `medium` reasoning | exact stage targets mapped through `resolveModelInfo`; nearest supported effort, higher on ties |
| `~/.codex/memories` + git baseline | `$DSH_HOME/memories`; atomic writes (temp + rename); no git dependency |
| developer-policy injection + `list`/`read`/`search`/`add_ad_hoc_note` | `systemPrompt.section` with a per-assembly provider + `memory_list`/`memory_read`/`memory_search`/`memory_add` |
| secret redaction, no-op gate, `v1` first-line protocol | kept: redaction on both input and output, empty-field no-op, exact `v1` first line |

### Storage layout

```
<root>/
  memory_summary.md          always-injected navigation layer (first line exactly `v1`)
  MEMORY.md                  grep-friendly handbook: preferences, procedures, failure shields
  raw_memories.md            Phase 1 output awaiting consolidation
  raw_memories.archive.md    rotated history of consolidated raw blocks
  rollout_summaries/<slug>.md  per-session recaps with session id / cwd provenance
  skills/                    procedures promoted by consolidation
  extensions/ad_hoc/notes/   user-requested ad hoc notes (memory_add)
```

### Bookkeeping

One KV record holds `{ processed: sessionId → claim, lastPhase1At, lastPhase2At, phase2Error,
pendingConsolidation, overrides }`. Claims are `running | done | noop | failed(attempts)`, so a
restart never re-extracts a session, never re-runs consolidation inside the cooldown, and
persisted `running` claims recover immediately on restart; a live-process claim is also released
if its 30-minute lease expires. Failed claims retry with
exponential backoff and give up at `retryLimit`. Writes are serialized through a promise chain;
when the KV backend is unavailable the store degrades to process-local state.

### Scheduler

- Boot: one delayed pipeline run (4s), then once per root `agent/session-start` (throttled 60s).
- Every root `agent/turn-stopping`: debounced run (default 3 min) — the debounce is the
  "session idle long enough" gate that prevents summarizing active sessions.
- Phase 1 selects root sessions only (subagent sessions excluded), skips processed ones, ages
  out sessions older than `maxRolloutAgeDays`, extracts with bounded concurrency, then sets
  `pendingConsolidation`.
- Phase 2 runs after any successful extraction, pending flag, or unconsumed ad hoc notes,
  subject to the cooldown. It waits without consuming input when no live root agent or capable
  fresh provider exists. Agent failures record `phase2Error` and retry on the next scheduled
  window or manually.

### Incremental extraction

Sessions grow after their first extraction, so claims carry a `lastSeq` watermark. A processed
session is re-checked no more often than `recheckIntervalMs` (default 30 min); when its log grew
by at least `minDeltaEvents` new rendered events, the delta is extracted into a new rollout part
(`<slug>-partN`) and appended to the raw queue. Legacy `noop` claims without a watermark get one
full re-extraction; legacy `done` claims only get their watermark baselined (their content is
already consolidated). The model input for a delta states explicitly that earlier content was
already processed.

### Structured output and restricted consolidation agent

Phase 1 constrains direct model output through `GenerateOptions.tools`: it must call
`memory_save` with `raw_memory`, `rollout_summary`, and `rollout_slug`, with a free-text fallback
for adapters that ignore tool schemas. Phase 2 instead uses the subagent seam's native
`outputSchema`; a fresh child progressively reads the memory workspace, then returns
`memory_md` and `memory_summary_md`. The parent plugin is the only writer and rejects missing,
empty, abnormal, or non-completed results. Phase 1 also retries once with a halved transcript
when output is truncated.

The stage reasoning policy is copied from Codex rather than inherited from the user's active
conversation: Phase 1 targets `low`, and the Phase 2 child targets `medium`. DSH effort ids are
adapter-owned, so exact matches win and otherwise the nearest advertised known level is used,
preferring the higher level on a tie. The direct Phase 1 call carries that effort in
`GenerateOptions`; a scoped `agent/request` waterfall injects Phase 2's effort only into the
`memory-consolidation` child.

### Ad hoc notes

`memory_add` writes user-requested notes into `extensions/ad_hoc/notes/`; Phase 2 feeds every
unconsumed note into consolidation as the highest-priority evidence source (user self-reports
outrank inferred facts, and conflicting evidence is preserved with attribution on both sides).
Consumed notes are moved to `extensions/ad_hoc/archive/` after a successful consolidation.

## Security invariants

- Session content is rendered as data, never instructions: the extraction prompt states it, and
  the renderer strips everything except user/assistant text and tool call/result summaries.
- Secret redaction applies to the rendered transcript *and* to model output before either is
  written to disk: API keys, JWT, Bearer tokens, PATs, Slack tokens, PEM private keys, and
  `password/secret/token/api_key`-style assignments.
- Memory tools resolve paths inside the memory root only; traversal and absolute paths are
  rejected before any filesystem call.
- The Phase 2 child inherits no parent transcript. `toolFilter.allow` contains only
  `memory_list`, `memory_read`, and `memory_search`, excluding shell, web, general filesystem,
  `memory_add`, and recursive delegation tools. Its only write-shaped capability is the scoped
  structured result, which the parent validates before two fixed-path atomic writes.
- The consolidation prompt demands the exact `v1` first line and the plugin enforces it
  mechanically (`ensureSummaryV1`).
- Each consolidation-agent request is bounded by `phase2MaxTokens` (default 65535, matching the
  validated DeepSeek route output ceiling rather than imposing an early 12000-token cutoff); injected summaries by
  `maxSummaryChars`; Phase 1 transcripts by `maxTranscriptChars` and extraction output by
  `phase1MaxTokens` (default 16384). `maxRawChars` is the explicit
  scan budget stated to the progressive Phase 2 agent rather than an eager prompt slice.

## Failure modes and recovery

| Failure | Behavior |
| --- | --- |
| No model route | Pipeline skips with `skippedNoRoute`; no state damage; retried on next trigger |
| No live root agent / capable fresh provider | Consolidation skips without changing cooldown or pending input |
| Extraction call fails | Claim marked failed with backoff; `retryLimit` attempts, then parked |
| Consolidation child fails or structured output is malformed | Raw memories preserved, `phase2Error` recorded, pending flag kept; child is disposed |
| Process restart mid-extraction | Orphaned `running` claims recover as failed and retry |
| KV backend missing | Claims stay process-local; pipeline still runs without cross-restart durability |
| Session log unreadable | That session's claim fails; other candidates unaffected |

## Coverage boundary

The plugin reads session logs through the public query surface and writes only inside its own
memory root. It does not modify session history, the deployment agent preset, or other plugins'
storage. Extraction runs only for root (non-subagent) sessions; the plugin-created consolidation
child is therefore never fed back into Phase 1. Model routing falls back to the deployment
default model (`agentDefaultModel`) when no dedicated route is configured. The client page is a
configuration and observation surface only; it does not gate any security boundary.

## Prior art

The two-phase pipeline, three-layer artifact layout, no-op gate, secret redaction, claims with
retry backoff, cooldown, and `v1` summary protocol are adapted from the OpenAI Codex memories
system (audited via `codex-rs/memories`, `codex-rs/ext/memories`, `codex-rs/state`). Prompts and
code are written from scratch for DSH; no Codex implementation text is copied. The package
build chain follows the `@nanmicoder/dsh-auto-mode` layout, and the settings page pattern
follows the `@dsh-local/vision-bridge` plugin.
