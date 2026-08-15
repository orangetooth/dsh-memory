# Design and decisions

## Scope

`dsh-memory` is a DeepSeek Harness bundle: a Host pipeline plugin plus a Web settings page. It
turns historical root-session logs into durable long-term memory — a two-phase extraction and
consolidation pipeline adapted from the Codex memories system onto DSH primitives, plus a read
path that injects a dense summary into every session and exposes four retrieval tools.

The plugin owns its memory directory and its KV-backed bookkeeping. It never rewrites session
logs, never touches the agent preset or the prompt template, and runs entirely asynchronously
after session boundaries.

## Decision record

Confirmed with the user before implementation (2026-02):

| Decision | Choice | Rationale |
| --- | --- | --- |
| Memory root | `$DSH_HOME/memories` (configurable) | Codex-style global consolidation; workspace context is preserved per rollout instead |
| Phase 2 executor | Direct `llm.stream` call | Lightweight, retryable, no subagent quota cost; consolidation is one bounded prompt |
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
                                                      ├─ llm consolidate (INIT / INCREMENTAL)
                                                      ├─ write MEMORY.md + memory_summary.md (v1)
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
| global Phase 2 lock + 6h cooldown | in-process single-flight + configurable cooldown (default 6h) |
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
interrupted `running` claims recover as failed after 30 minutes. Failed claims retry with
exponential backoff and give up at `retryLimit`. Writes are serialized through a promise chain;
when the KV backend is unavailable the store degrades to process-local state.

### Scheduler

- Boot: one delayed pipeline run (4s), then once per root `agent/session-start` (throttled 60s).
- Every root `agent/turn-stopping`: debounced run (default 3 min) — the debounce is the
  "session idle long enough" gate that prevents summarizing active sessions.
- Phase 1 selects root sessions only (subagent sessions excluded), skips processed ones, ages
  out sessions older than `maxRolloutAgeDays`, extracts with bounded concurrency, then sets
  `pendingConsolidation`.
- Phase 2 runs after any successful extraction or pending flag, subject to the cooldown;
  failures record `phase2Error` and retry on the next scheduled window or manually.

## Security invariants

- Session content is rendered as data, never instructions: the extraction prompt states it, and
  the renderer strips everything except user/assistant text and tool call/result summaries.
- Secret redaction applies to the rendered transcript *and* to model output before either is
  written to disk: API keys, JWT, Bearer tokens, PATs, Slack tokens, PEM private keys, and
  `password/secret/token/api_key`-style assignments.
- Memory tools resolve paths inside the memory root only; traversal and absolute paths are
  rejected before any filesystem call.
- The consolidation prompt demands the exact `v1` first line and the plugin enforces it
  mechanically (`ensureSummaryV1`).
- Consolidation output is bounded by `phase2MaxTokens`; injected summaries by `maxSummaryChars`;
  transcripts by `maxTranscriptChars`; raw input by `maxRawChars`. Every model input has a cap.

## Failure modes and recovery

| Failure | Behavior |
| --- | --- |
| No model route | Pipeline skips with `skippedNoRoute`; no state damage; retried on next trigger |
| Extraction call fails | Claim marked failed with backoff; `retryLimit` attempts, then parked |
| Consolidation output malformed | Raw memories preserved, `phase2Error` recorded, pending flag kept |
| Process restart mid-extraction | Orphaned `running` claims recover as failed and retry |
| KV backend missing | Claims stay process-local; pipeline still runs without cross-restart durability |
| Session log unreadable | That session's claim fails; other candidates unaffected |

## Coverage boundary

The plugin reads session logs through the public query surface and writes only inside its own
memory root. It does not modify session history, the agent preset, prompt templates, or other
plugins' storage. Extraction runs only for root (non-subagent) sessions; subagent work is
already summarized inside its parent's log. Model routing falls back to the deployment default
model (`agentDefaultModel`) when no dedicated route is configured. The client page is a
configuration and observation surface only; it does not gate any security boundary.

## Prior art

The two-phase pipeline, three-layer artifact layout, no-op gate, secret redaction, claims with
retry backoff, cooldown, and `v1` summary protocol are adapted from the OpenAI Codex memories
system (audited via `codex-rs/memories`, `codex-rs/ext/memories`, `codex-rs/state`). Prompts and
code are written from scratch for DSH; no Codex implementation text is copied. The package
build chain follows the `@nanmicoder/dsh-auto-mode` layout, and the settings page pattern
follows the `@dsh-local/vision-bridge` plugin.
