/**
 * Continuable-child delegation policy: a fresh continuable start seeds the
 * parent's explicit sandbox override and the pinned `approval/policy: never`
 * onto the child's own log as `source: 'delegation'` events, and a cold
 * resume replays that persisted snapshot instead of re-capturing the parent
 * (the one-shot `subagent-inprocess/tests/inheritance.spec.ts` counterpart).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Boot the continuable stack plus both policy services the manager consumes opportunistically. */
async function setup(script: Script) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const root = mkdtempSync(join(tmpdir(), 'dsh-continuation-inherit-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

function startSpec(parent: Agent, provider = 'spawn') {
  return {
    provider,
    label: 'child task',
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
    signal: new AbortController().signal,
  }
}

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 15_000 })
}

function policyEvents(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'sandbox/mode' || event.type === 'approval/policy')
}

function foldedSandboxMode(ctx: Context, id: SessionId, events: readonly SessionEvent[]): unknown {
  return ctx.sessionProjections.stateOf(Session.create(id, events), 'sandboxMode')
}

function foldedApprovalPolicy(ctx: Context, id: SessionId, events: readonly SessionEvent[]): unknown {
  return ctx.approval.overrideOf(Session.create(id, events))
}

describe('continuable policy inheritance', () => {
  it('seeds the parent sandbox override and pins approval to never', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setSandboxMode(parent.session, 'danger-full-access')
    // No parent approval override: the child pin must not depend on one.
    expect(ctx.approval.overrideOf(parent.session)).toBeUndefined()
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    // The delegation events are appended in the creation window, so they are
    // already the child's effective policy at inbox acceptance.
    if (child === undefined) throw new Error('expected the continuable child to be created')
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('danger-full-access')
    expect(ctx.approval.overrideOf(child.session)).toBe('never')

    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    // Durable: a reload folds the same effective policy.
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('danger-full-access')
    expect(foldedApprovalPolicy(ctx, started.childId, loaded.events)).toBe('never')
    expect(ctx.approval.overrideOf(parent.session)).toBeUndefined()
    const runtimeContext = loaded.events.find(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt',
    )
    const contextText = runtimeContext?.data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    expect(contextText).toContain('You are a delegated subagent')
  })

  it('captures policy at delegation before asynchronous child creation', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setSandboxMode(parent.session, 'read-only')

    const starting = ctx.subagents.startContinuable(startSpec(parent))
    // A parent switch after the synchronous capture belongs to the parent's
    // future, not to this child.
    setSandboxMode(parent.session, 'danger-full-access')
    const started = await starting

    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(ctx.sandboxPolicy.overrideOf(parent.session)).toBe('danger-full-access')
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
  })

  it('leaves an unswitched sandbox on the deployment default while still pinning approval', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBeNull()
  })

  it('pins approval after the fork prefix of an unswitched fork child', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'fork'))
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.meta.isSeeded).toBe(true)
    expect(loaded.inheritedEventCount).toBeGreaterThan(0)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBeNull()
  })

  it('lets a later child-side switch win over the delegation snapshot', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setSandboxMode(parent.session, 'danger-full-access')
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    if (child === undefined) throw new Error('expected the continuable child to be created')
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('danger-full-access')
    // Last event wins: the child's own runtime switch beats the seeded snapshot.
    setSandboxMode(child.session, 'read-only')
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')

    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
  })

  it('cold-resumes on the persisted snapshot without re-capturing the parent', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    setSandboxMode(parent.session, 'read-only')
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    // The parent widens AFTER the child was created; the resumed child keeps
    // the delegation-time snapshot from its own log.
    setSandboxMode(parent.session, 'danger-full-access')
    await queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      started.childId,
      [{ type: 'text', text: 'continue please' }],
      { kind: 'user' },
      new AbortController().signal,
    )
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.events.filter(event => event.type === 'sandbox/mode')).toMatchObject([
      { data: { mode: 'read-only', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
    // The approval pin is seeded once at creation, never re-appended on resume.
    expect(loaded.events.filter(event => event.type === 'approval/policy')).toMatchObject([
      { data: { policy: 'never', source: 'delegation' } },
    ])
  })

  it('places inherited events after a fork prefix so fresh policy wins stale seed state', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    setSandboxMode(parent.session, 'workspace-write')
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    setSandboxMode(parent.session, 'read-only')

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'fork'))
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.meta.isSeeded).toBe(true)
    expect(loaded.inheritedEventCount).toBeGreaterThan(0)
    expect(loaded.events.filter(event => event.type === 'sandbox/mode')).toMatchObject([
      { data: { mode: 'workspace-write' } },
      { data: { mode: 'read-only' } },
      { data: { mode: 'read-only', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
  })

  it('cold-resumes the current-turn fork without inheriting parent execution or later context', async () => {
    const reasoning = 'This current turn establishes the review context.'
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: reasoning },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
      ...toolCallResponse('delegate-call', 'delegate', {}).map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 1 } : chunk),
    ]
    const { ctx, parent, adapter } = await setup([
      chunks, textResponse('first child answer'), textResponse('parent answer'), textResponse('resumed child answer'),
    ])
    let childId: SessionId | undefined
    let parentPrefix: readonly SessionEvent[] = []
    ctx.tools.register(defineContentToolFixture({
      name: 'delegate', description: 'Delegate a review.', parameters: {},
      execute: async () => {
        parentPrefix = parent.session.snapshotEvents()
        const started = await ctx.subagents.startContinuable(startSpec(parent, 'fork'))
        childId = started.childId
        await waitNoActivation(ctx, childId)
        return [{ type: 'text', text: 'review settled' }]
      },
    }))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'current user assignment' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(childId).toBeDefined()
    if (childId === undefined) throw new Error('expected a continuable fork')
    const initial = await ctx.sessionPersistence.load(childId)
    expect(initial.inheritedEventCount).toBe(parentPrefix.length)
    expect(initial.events.slice(0, initial.inheritedEventCount)).toEqual(parentPrefix)
    const own = initial.events.slice(initial.inheritedEventCount)
    expect(own.find(event => event.type === 'turn/end')?.data.reason.kind).toBe('forked')
    expect(own.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain(reasoning)

    ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' as const } : next())
    parent.inject(createUserMessage({ content: [{ type: 'text', text: 'later parent context' }], source: { kind: 'user' } }))
    await queueHostSubagentPrompt(
      ctx.subagents, parent, childId, [{ type: 'text', text: 'continue the review' }], { kind: 'user' }, new AbortController().signal,
    )
    await waitNoActivation(ctx, childId)
    const resumed = await ctx.sessionPersistence.load(childId)
    expect(resumed.inheritedEventCount).toBe(initial.inheritedEventCount)
    expect(resumed.events.slice(0, initial.inheritedEventCount)).toEqual(parentPrefix)
    expect(resumed.events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'forked')).toHaveLength(1)
    expect(resumed.events.slice(initial.inheritedEventCount).filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    const resumedRequest = JSON.stringify(adapter.requests[3]?.messages)
    expect(resumedRequest).toContain('current user assignment')
    expect(resumedRequest).toContain(reasoning)
    expect(resumedRequest).toContain('continue the review')
    expect(resumedRequest).not.toContain('later parent context')
  })
})
