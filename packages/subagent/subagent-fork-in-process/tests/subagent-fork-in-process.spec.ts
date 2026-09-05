import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import SubagentRuntime, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as fork from '../src/index.ts'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

function start(ctx: Context, provider: string, request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal }) {
  return ctx.subagents.start(provider, { signal: request.signal ?? new AbortController().signal, ...request })
}

/** A bare `stop` finish that streams no content → the turn ends `completed`
 * with NO `assistant/message` of its own. */
const emptyStop: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]

/**
 * Drives the REAL fork backend with a real loop + scripted mock MODEL + the
 * real invariant service and package companions. The session contribution replays a seeded child log on
 * `session/created`, so a malformed (unbalanced) fork seed makes these tests
 * THROW before the child can issue a model request.
 */
async function setup(script: Script, maxParallelToolCalls?: number) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [], ...maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls } })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(fork, { providerName: 'fork' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-subagent-fork-in-process', () => {
  it('emits subagent/start only after the seeded child is published', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    let childAtStart: ReturnType<typeof ctx.agents.get>
    ctx.on('subagent/start', (info) => {
      if (info.provider === 'fork') childAtStart = ctx.agents.get(info.id)
    })

    const starting = start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    expect(childAtStart).toBeUndefined()
    const run = await starting
    expect(childAtStart).toBe(ctx.agents.get(run.id))
    expect(childAtStart?.id).toBe(run.id)

    await run.result
    await run.dispose()
  })

  it('starts an unseeded child when the parent log is empty', async () => {
    const { ctx, parent } = await setup([textResponse('fresh child')])
    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('fresh child')
    const child = ctx.agents.get(run.id)!
    // Only the child's own turn — no seeded parent turns.
    expect(child.session.snapshotEvents().filter(e => e.type === 'turn/end')).toHaveLength(1)
    expect(child.session.header.isSeeded).toBe(false)
    expect(child.session.inheritedEventCount).toBe(0)
    await run.dispose()
  })

  it('seeds every completed parent turn through the last turn/end', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second'), textResponse('child')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q1' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const parentPrefixLen = parent.session.snapshotEvents().length

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.isSeeded).toBe(true)
    expect(child.session.inheritedEventCount).toBe(parentPrefixLen)
    expect(child.session.snapshotEvents().slice(0, parentPrefixLen).at(-1)?.type).toBe('turn/end')
    expect(child.session.snapshotEvents().slice(0, parentPrefixLen).filter(e => e.type === 'turn/end')).toHaveLength(2)
    await run.dispose()
  })

  it('seeds the child with the parent\'s completed-turn prefix (child inherits context)', async () => {
    const { ctx, parent } = await setup([textResponse('parent answer'), textResponse('child answer')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent question' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const parentPrefixLen = parent.session.snapshotEvents().length

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child question' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('child answer')

    const child = ctx.agents.get(run.id)!
    // The child's log STARTS with the parent's prefix (seeded), then its own turn.
    expect(child.session.snapshotEvents().length).toBeGreaterThan(parentPrefixLen)
    // The seeded prefix carried the parent's user message.
    const seededUser = child.session.snapshotEvents().slice(0, parentPrefixLen).find(e => e.type === 'user/message')
    expect(seededUser).toBeDefined()
    // Lineage stamped.
    expect(child.session.header.parentSession).toBe(parent.session.header.id)
    // Logical metadata records lineage while Session state retains the exact
    // inherited cut for reload and replay.
    expect(child.session.header.isSeeded).toBe(true)
    expect(child.session.inheritedEventCount).toBe(parentPrefixLen)
    await run.dispose()
  })

  it('closes an inherited open turn without canceling the parent stream', async () => {
    const { ctx, parent } = await setup([textResponse('done'), 'hang', textResponse('child')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q1' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const streaming = Promise.withResolvers<undefined>()
    ctx.on('session/event', (session, event) => {
      if (session === parent.session && event.type === 'assistant/chunk' && event.data.turn === 2) streaming.resolve(undefined)
    })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } }))
    await streaming.promise
    const parentPrefix = parent.session.snapshotEvents()

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('child')

    const child = ctx.agents.get(run.id)!
    const seedTurnEnds = child.session.snapshotEvents().filter(e => e.type === 'turn/end')
    expect(seedTurnEnds.map(event => event.data.reason.kind)).toEqual(['completed', 'forked', 'completed'])
    expect(child.session.inheritedEventCount).toBe(parentPrefix.length)
    expect(child.session.snapshotEvents().slice(0, parentPrefix.length)).toEqual(parentPrefix)
    expect(parent.status).toBe('running')
    expect(parent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.turn === 2)).toBe(false)

    parent.cancel({ kind: 'user' })
    await parent.whenIdle()
    await run.dispose()
  })

  it('inherits current reasoning and completed tools while leaving pending execution and input with the parent', async () => {
    const reasoning = 'The inspection proves that the child should review the shared state.'
    const delegation: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: reasoning },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
      ...toolCallResponse('fork-call', 'delegate', {}).filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage')
        .map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 1 } : chunk),
      ...toolCallResponse('later-call', 'later', {}).map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 2 } : chunk),
    ]
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('inspect-call', 'inspect', {}), delegation, textResponse('child finding'), textResponse('parent done'),
    ], 1)
    let childSession: Session | undefined
    let parentPrefix: readonly SessionEvent[] = []
    let laterCalls = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'inspect', description: 'Inspect shared state.', parameters: {},
      execute: async () => [{ type: 'text', text: 'inspection evidence' }],
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'later', description: 'Run after delegation.', parameters: {},
      execute: async () => {
        laterCalls += 1
        return [{ type: 'text', text: 'later result' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'delegate', description: 'Delegate a review.', parameters: {},
      execute: async () => {
        parent.inject(createUserMessage({ content: [{ type: 'text', text: 'pending parent input' }], source: { kind: 'user' } }))
        parentPrefix = parent.session.snapshotEvents()
        const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'review the evidence' }], parent })
        childSession = run.localAgent!.session
        try {
          return (await run.result).output
        } finally {
          await run.dispose()
        }
      },
    }))

    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'investigate this new issue' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(childSession).toBeDefined()
    if (childSession === undefined) throw new Error('expected a forked child session')
    expect(childSession.inheritedEventCount).toBe(parentPrefix.length)
    expect(childSession.snapshotEvents().slice(0, parentPrefix.length)).toEqual(parentPrefix)
    expect(childSession.ownEvents().filter(event => event.type === 'tool/result').map(event => event.data.error?.code))
      .toEqual(['TOOL_EXECUTION_NOT_INHERITED', 'TOOL_EXECUTION_NOT_INHERITED'])
    const childRequest = JSON.stringify(adapter.requests[2]?.messages)
    expect(childRequest).toContain('investigate this new issue')
    expect(childRequest).toContain('inspection evidence')
    expect(childRequest).toContain(reasoning)
    expect(childRequest).not.toContain('pending parent input')
    expect(childRequest).not.toContain('later result')
    expect(JSON.stringify(adapter.requests[3]?.messages)).toContain('pending parent input')
    expect(laterCalls).toBe(1)
    expect(parent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'forked')).toBe(false)
  })

  it('captures structured output through the shipped plugin (seeded child, driver runtime)', async () => {
    const { ctx, parent } = await setup([
      textResponse('parent turn'),
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 9 }),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const run = await start(ctx, 'fork', {
      prompt: [{ type: 'text', text: 'report structured' }],
      parent,
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 9 })
    expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    await run.dispose()
  })

  it('does NOT return the seeded parent output when the child produces no message of its own', async () => {
    // `readResult` must scan only child-owned events after the seed. The child emits no assistant
    // message, so scanning the whole log would incorrectly return the parent's distinctive text.
    const { ctx, parent } = await setup([textResponse('parent stale'), emptyStop])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent question' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child question' }], parent })
    const result = await run.result
    // The child completed its own (empty) turn — completed, but with NO output
    // borrowed from the seeded parent prefix.
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([])
    await run.dispose()
  })

  it('advertises every start-time capability', async () => {
    const { ctx } = await setup([])
    expect(ctx.subagents.getProvider('fork')!.capabilities).toEqual({
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    })
  })

  it('unregisters the provider when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(fork, { providerName: 'fork' })
    expect(ctx.subagents.list()).toEqual(['fork'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('captures a continuable child seed once before later parent turns', async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('child answer')])
    const provider = ctx.subagents.getProvider('fork')!
    const signal = new AbortController().signal

    const fresh = await provider.prepareContinuable!({
      sessionId: SessionId('continuable-fresh'),
      parent,
      signal,
    })
    expect(fresh.seed).toBeUndefined()

    // Complete one parent turn, then the prefix is captured once at creation.
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const seeded = await provider.prepareContinuable!({
      sessionId: SessionId('continuable-seeded'),
      parent,
      signal,
    })
    expect(seeded.seed).toBeDefined()
    const lastSeeded = seeded.seed!.events.at(-1)
    // The seed ends at a completed turn, so it replays as a valid child log.
    expect(lastSeeded?.type).toBe('turn/end')
    expect(seeded.seed!.events.map(event => event.seq)).toEqual(seeded.seed!.events.map((_event, index) => index))
    expect(seeded.seed!.inheritedEventCount).toBe(parent.session.seq)
    const captured = seeded.seed!.events
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'later parent request' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(seeded.seed!.events).toBe(captured)
    expect(JSON.stringify(captured)).not.toContain('later parent request')
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in fork).toBe(false)
    expect(fork.name).toBe('subagent-fork-in-process')
    expect(fork.inject).toEqual(['subagents'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(fork) as Record<string, unknown>
    expect(unwrapped).toBe(fork)
    expect(unwrapped.name).toBe('subagent-fork-in-process')
    expect(unwrapped.inject).toEqual(['subagents'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
