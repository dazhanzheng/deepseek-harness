# Agent Note: Fork subagents from committed live context

Status: implemented

English | [中文](2026-09-05-live-subagent-fork-snapshots.zh.md)

## Problem

A delegation often depends on the current user request, reasoning, and tool findings within a long turn. Restricting inherited history to completed turns makes the parent repeat those facts in a task prompt and gives a first-turn fork no conversation context. Copying an open turn without closing records instead leaves unfinished tool calls and an open execution lifecycle in the child.

## Decision

`Session.snapshotForFork()` returns immutable `SessionForkSeed` data: the committed parent event prefix, child-only closing records, and the exact inherited-prefix length. The fork provider selects this snapshot; the one-shot driver and continuation manager retain their existing creation and execution responsibilities. The agent loop has no fork-specific branch.

Session uses the same tail scan for crash recovery and fork closure. A fork appends `TOOL_EXECUTION_NOT_INHERITED` results for unanswered inherited calls and closes their step and turn with reason `forked`. Those records belong only to the child and explicitly leave execution with the parent. They neither cancel parent work nor invite the child to retry it. Committed assistant messages retain reasoning; unassembled stream chunks remain log-only.

`inheritedEventCount` counts only events that actually came from the parent. The complete seed may be longer because closing records are child-owned. One-shot result collection excludes the complete seed, while inbox reconstruction uses the existing own-event cut to exclude pending parent work. Cold resume replays the child's stored snapshot instead of capturing newer parent history.

The [request-prefix decision](2026-08-10-fork-children-stay-one-shot.md) continues to own tool-schema equality and the placement of parent-id guidance. Live snapshot selection supersedes only its completed-turn premise; closing records and the child task follow the inherited message prefix.

## Alternatives considered

**Keep only completed turns or steps.** Completed turns omit every current-turn finding. Completed steps still omit the reasoning that produced the delegation and, for a first-step fork, the current user message.

**Copy live execution or wait for the parent turn.** A fork tool cannot wait for its own containing turn to finish. Transferring running tools or pending input would also duplicate execution ownership instead of providing independent child work.

**Reuse crash-recovery results verbatim.** Recovery says the execution was interrupted and may need retrying. A fork leaves the parent running, so it requires distinct tool-result wording and a distinct turn-ending reason.

**Repair the log inside the provider or loop.** The provider would duplicate Session's tool-pairing and closure algorithm; the loop would gain delegation-specific policy. Session-owned immutable seed data keeps both responsibilities at their existing owners.

## Consequences

Forked children can use current-turn context without a second parent-authored summary. Snapshot creation does not change parent events, execute tools, or synchronize later parent changes. Retained history consumes the child's context window; provider-side cache reuse remains conditional on an unchanged request prefix.

Session tests cover closing records, lineage, immutable prefixes, and continued parent execution. Subagent tests exercise the real tool pipeline and cold resume. Recorded SDK sessions and the Python runtime projection verify current-turn inheritance through the shipped profile; file outcomes independently check that a child uses inherited facts and the parent continues.
