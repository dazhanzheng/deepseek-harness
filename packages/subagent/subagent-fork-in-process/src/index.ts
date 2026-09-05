/**
 * The in-process FORK subagent backend: registers a {@link SubagentProvider} on
 * `ctx.subagents` that runs each child as a child {@link Agent} SEEDED with a prefix of the
 * parent's session log — so the child inherits the parent's conversation context instead of
 * starting fresh. Session snapshots preserve committed context from the current turn and
 * close inherited execution only in the child's copy.
 * @module @deepseek-ai/dsh-subagent-fork-in-process
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'

export const name = 'subagent-fork-in-process'
// `tools` is deliberately NOT injected — same rationale as subagent-spawn-in-process: the
// per-run structured runtime gates its capture-tool registration on `tools`
// itself, so this backend's apply timing (and the delegation tool's position
// in the model-visible tool list) is unchanged by structured output.
export const inject = ['subagents']

/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `fork`). */
  providerName: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('fork'),
})

/**
 * The fork provider. Supports `depthLimit` and `outputSchema` (via the shared
 * in-process structured runtime), `agentOptions` (merged over the parent
 * route), and `toolFilter`/`persona` (scoped restrict() and a scoped shadowing
 * persona section).
 */
class ForkInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = true

  constructor(readonly name: string) {}

  start(request: ResolvedSubagentStartRequest) {
    const seed = request.parent.session.snapshotForFork()
    return startInProcessRun(request, {
      ...seed.inheritedEventCount > 0 ? { seed } : {},
    })
  }

  prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    // The fork prefix is captured ONCE, at creation: it becomes part of the
    // child's own durable transcript, so a later cold resume replays that
    // prefix instead of re-forking the parent's newer history.
    const seed = request.parent.session.snapshotForFork()
    return Promise.resolve(seed.inheritedEventCount > 0 ? { seed } : {})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new ForkInProcessProvider(config.providerName))
}
