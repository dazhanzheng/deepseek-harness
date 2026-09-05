---
description: "In-process fork subagent backend for users and maintainers choosing, configuring, or debugging children seeded with the parent's committed conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-fork-in-process

English | [中文](README.zh.md)

## Summary

`dsh-subagent-fork-in-process` seeds each child with the parent's committed conversation at delegation time, including the current turn's messages, reasoning, and recorded tool results. A delegation tool reaches it under the `fork` provider name, and its behavior matches the spawn backend except for the session seed. Choose it when a subtask continues this conversation; choose spawn when the child must stand alone. The seed is a one-time snapshot taken at fork time: later parent turns never reach the child.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this backend when delegated work must build on the parent's conversation. The common path mirrors spawn: load the subagent service and this backend, then point a delegation tool such as `dsh-tool-subagent` at the `fork` provider.

### When to choose it

Choose fork when the child needs the conversation's committed context — a follow-up analysis, a review, a continuation. Choose spawn when the child should start clean, or an out-of-process backend when the child must not share this process. The seed carries conversation history only: the child still gets a fresh tool scope and none of the parent's authority.

### Seed boundary

The seed includes every parent event committed when the provider captures it. Session-owned closing records balance unfinished tool calls and close the inherited step and turn in the child only. Those calls remain the parent's responsibility; the child must not retry them. Unassembled stream chunks stay log-only, and later parent events are not synchronized.

### Minimal configuration

Load the subagent service and this backend, then configure a delegation tool. This composition exposes a `subagent` tool backed by fork:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-fork-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `fork` | Provider name registered on `ctx.subagents` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-fork-in-process) is the exhaustive source for every accepted field and its JSDoc.

### What a fork delegation does

A delegation captures the parent's committed context once and starts a child in its own session. Foreground calls return the child's final output, with non-completed outcomes reported as tool errors; continuable background calls return a durable child id for later messages. The delegation tool's configuration selects that lifecycle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the backend and where the behavior in [Use this package](#use-this-package) comes from.

### Design concept

The provider obtains a `SessionForkSeed` through `Session.snapshotForFork()`. The Session owns closure and replay semantics; the provider chooses the history, and the one-shot driver or continuation manager owns child execution. The seed distinguishes the true parent prefix from child-only closing records. Result collection excludes the entire seed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider registration: snapshot selection, `Config` schema, capability declaration |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Run flow

On `start`, the shared driver creates the child from the captured seed, applies persona, tool-filter, and structured-output setup, drives one task, reads the child's own final output, and disposes quiescently. The provider advertises `agentOptions` plus the same output, depth, filter, and persona capabilities as spawn. `prepareContinuable` captures the prefix once, at creation, because it becomes part of the child's own durable transcript.

### Lifecycle binding

The base bundle and ACP/headless examples bind this provider to `backgroundMode: one-shot`, while the CLI presets select `continuable`. Both preserve the inherited request prefix: parent and child receive the same messaging tool definition and ordering, and the continuable child's parent id and return guidance live in its initial user task after inherited history ([cache-preserving fork Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md)).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the shared subagent model to the sibling backends and the design evidence for the one-shot binding.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — start requests, results, provider contract, and in-process depth and seed.
- [dsh-subagent-in-process-driver](../subagent-in-process-driver/README.md) — the shared run driver this backend calls.
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.md) — the fresh-child sibling backend.
- [dsh-tool-subagent](../tool-subagent/README.md) — the model-facing delegation tool that reaches this provider.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-fork-in-process) — every accepted config field and its source declaration.
- [Forked children preserve the parent request prefix](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md) — how inherited history remains eligible for prefix reuse.

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent history and envelope

#### What the model sees

The child receives the parent's committed conversation, any child-only closing results, and the new task content verbatim. A configured persona shadows prompt text in the child's fresh scope; a tool restriction filters its global wire schemas, executable lookup, and PTC mode SDK bindings but not standalone guidance. The parent's tool view and authority are not inherited; an optional structured-output request adds a child-only contract; the current turn's committed messages and reasoning are retained, while execution remains with the parent.

#### Token effect

Forking duplicates retained committed history into the child's request, which then accumulates its own tokens independently. A persona changes repeated prompt cost; filtering changes schema or generated SDK cost; a first-turn fork retains the current user message and committed assistant work.

#### KV Cache effect

The child may reuse the inherited byte-identical prefix under the same provider and model. Persona, tool-filter, generated-SDK, or route changes may invalidate reuse before inherited history; later child history is append-only. Continuable messaging adds no child-only system-prompt section or tool schema; the parent id and return guidance follow inherited history in the initial user task ([cache-preserving fork Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md)).

### Parent tool result, indirectly

#### What the model sees

The parent receives only the child's own final output through `dsh-tool-subagent`, not the inherited prefix or intermediate work.

#### Token effect

Parent input grows by one data-dependent final result retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the backend is the wrong choice; they are current package constraints.

- **The seed is a one-time snapshot** — the child sees the parent's committed context as of the fork and nothing the parent logs afterwards; there is no live context sharing.
- **Fork lifecycle policy differs by composition** — the base bundle and ACP/headless examples use one-shot fork, while the CLI presets use continuable fork. Both keep the inherited prefix eligible for reuse because parent and child messaging definitions match byte for byte; explicit persona, tool filtering, generated-SDK, or route changes can still break equality. Rationale: the [cache-preserving fork Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md).
- **Shipped fork tools do not expose child LLM route selection** — they inherit the parent's provider and model so the copied history remains eligible for KV Cache reuse. Route selection stays disabled until a change can preserve reuse or expose a bounded recomputation cost; the [model-selected route Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md) owns that restriction.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
