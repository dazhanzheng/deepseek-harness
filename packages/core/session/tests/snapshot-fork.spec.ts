import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createToolResultMessage, createUserMessage, freezeMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, SessionLogOffset, TOOL_EXECUTION_NOT_INHERITED } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionForkSeed } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'

async function setup(): Promise<SessionStore> {
  const ctx = new Context()
  const fibers: Awaited<ReturnType<Context['plugin']>>[] = []
  onTestFinished(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(InvariantRegistry))
  fibers.push(await ctx.plugin(SessionInvariant))
  return ctx.sessions
}

function toolCall(id: string): ToolCallBlock {
  return { type: 'tool-call', id: ToolCallId(id), name: 'inspect', arguments: '{}' }
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'mock', model: 'mock' } })
}

function beginTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Investigate the current turn before delegating.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function createChild(sessions: SessionStore, parent: Session, seed: SessionForkSeed): Session {
  const child = sessions.create(undefined, {
    seed: seed.events,
    inheritedEventCount: seed.inheritedEventCount,
    meta: { isSeeded: true, parentSession: parent.id },
  })
  child.appendForkClosers(seed.closers)
  return child
}

function toolResults(events: readonly SessionEvent[]): SessionEvent<'tool/result'>[] {
  return events.filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
}

describe('Session.snapshotForFork', () => {
  it('preserves the current turn and closes only unfinished calls in the child', async () => {
    const sessions = await setup()
    const parent = sessions.create(SessionId('parent'))
    beginTurn(parent)
    const earlierCall = toolCall('earlier')
    parent.append('assistant/message', {
      turn: 1, step: 1,
      message: assistant([{ type: 'reasoning', text: 'Inspect the current implementation first.' }, earlierCall]),
      stream: [],
    }, { surfaceOp: 'append' })
    parent.append('tool/call', { turn: 1, step: 1, callId: earlierCall.id, name: earlierCall.name, arguments: earlierCall.arguments })
    parent.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: earlierCall.id, content: [{ type: 'text', text: 'Initial evidence.' }], isError: false }),
    }, { surfaceOp: 'append' })
    parent.append('step/end', { turn: 1, step: 1 })
    parent.append('step/start', { turn: 1, step: 2 })
    const calls = [toolCall('answered'), toolCall('fork'), toolCall('not-started')]
    parent.append('assistant/message', {
      turn: 1, step: 2,
      message: assistant([{ type: 'reasoning', text: 'Delegate the follow-up using the evidence.' }, ...calls]),
      stream: [],
    }, { surfaceOp: 'append' })
    const [answered, fork] = calls
    if (answered === undefined || fork === undefined) throw new Error('missing fixture calls')
    parent.append('tool/call', { turn: 1, step: 2, callId: answered.id, name: answered.name, arguments: answered.arguments })
    parent.append('tool/result', {
      turn: 1, step: 2,
      message: createToolResultMessage({ callId: answered.id, content: [{ type: 'text', text: 'Concurrent evidence.' }], isError: false }),
    }, { surfaceOp: 'append' })
    const startedFork = parent.append('tool/call', { turn: 1, step: 2, callId: fork.id, name: fork.name, arguments: fork.arguments })
    const originalEvents = parent.snapshotEvents()
    const originalMessages = parent.deriveMessages()

    const seed = parent.snapshotForFork()
    const closers = seed.closers
    const results = toolResults(closers)
    expect(seed.inheritedEventCount).toBe(originalEvents.length)
    expect(seed.events).toEqual(originalEvents)
    expect(closers.map(event => event.type)).toEqual(['tool/result', 'tool/result', 'step/end', 'turn/end'])
    expect(results.map(event => event.data.message.source.callId)).toEqual(['fork', 'not-started'])
    for (const result of results) {
      expect(result).toMatchObject({
        data: { turn: 1, step: 2, error: { code: TOOL_EXECUTION_NOT_INHERITED }, message: { content: [{ isError: true }] } },
        surfaceOp: 'append',
      })
    }
    expect(results[0]?.sourceEventSeqs).toEqual([startedFork.seq])
    expect(results[1]?.sourceEventSeqs).toBeUndefined()
    expect(closers.at(-1)).toMatchObject({ type: 'turn/end', data: { turn: 1, reason: { kind: 'forked' } } })
    expect(seed.events.map(event => event.seq)).toEqual(seed.events.map((_, index) => index))

    const child = createChild(sessions, parent, seed)
    expect(child.deriveMessages()).toEqual([...originalMessages, ...results.map(event => event.data.message)])
    expect(child.inheritedEventCount).toBe(originalEvents.length)
    expect(child.snapshotEvents(SessionLogOffset(0), child.inheritedEventCount)).toEqual(originalEvents)
    const own = child.ownEvents()
    expect(own[0]).toMatchObject({ type: 'session/end-seed' })
    expect(own.slice(1).map(event => event.type)).toEqual(closers.map(event => event.type))
    expect(own.slice(1).map(event => event.type === 'tool/result' ? event.data.message.source.callId : null))
      .toEqual(closers.map(event => event.type === 'tool/result' ? event.data.message.source.callId : null))
    expect(parent.snapshotEvents()).toBe(originalEvents)
    expect(parent.deriveMessages()).toEqual(originalMessages)

    child.append('turn/start', { turn: 2 })
    child.append('step/start', { turn: 2, step: 1 })
    child.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Execute the delegated task.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    child.append('step/end', { turn: 2, step: 1 })
    child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    parent.append('tool/result', {
      turn: 1, step: 2,
      message: createToolResultMessage({ callId: fork.id, content: [{ type: 'text', text: 'Started child.' }], isError: false }),
    }, { surfaceOp: 'append' })
    expect(seed.events).toEqual(originalEvents)
    expect(toolResults(seed.closers).find(event => event.data.message.source.callId === fork.id)?.data.error?.code)
      .toBe(TOOL_EXECUTION_NOT_INHERITED)
  })

  it('returns an immutable snapshot including child-only closing events', async () => {
    const sessions = await setup()
    const parent = sessions.create()
    beginTurn(parent)
    parent.append('assistant/message', {
      turn: 1, step: 1, message: assistant([toolCall('pending')]),
      stream: [],
    }, { surfaceOp: 'append' })

    const seed = parent.snapshotForFork()
    const result = toolResults(seed.closers)[0]
    if (result === undefined) throw new Error('missing synthetic result')
    expect(Object.isFrozen(seed.events)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(() => { result.data.message.content[0].content[0] = { type: 'text', text: 'changed' } }).toThrow(TypeError)
    expect(() => { (seed.events as SessionEvent[]).pop() }).toThrow(TypeError)
    const input = seed.events.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    if (input === undefined) throw new Error('missing user message')
    expect(() => { input.data.content[0] = { type: 'text', text: 'changed' } }).toThrow(TypeError)
  })

  it.each(['empty', 'balanced'] as const)('does not synthesize closing events for an %s snapshot', async (kind) => {
    const sessions = await setup()
    const parent = sessions.create()
    if (kind === 'balanced') {
      beginTurn(parent)
      parent.append('step/end', { turn: 1, step: 1 })
      parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    const events = parent.snapshotEvents()

    const seed = parent.snapshotForFork()

    expect(seed.events).toEqual(events)
    expect(seed.inheritedEventCount).toBe(events.length)
    const child = createChild(sessions, parent, seed)
    child.append('turn/start', { turn: kind === 'empty' ? 1 : 2 })
    expect(parent.snapshotEvents()).toBe(events)
  })

  it('closes a turn between completed steps without adding tool results or another step end', async () => {
    const sessions = await setup()
    const parent = sessions.create()
    beginTurn(parent)
    parent.append('assistant/message', {
      turn: 1, step: 1, message: assistant([{ type: 'text', text: 'Committed response.' }]),
      stream: [],
    }, { surfaceOp: 'append' })
    parent.append('step/end', { turn: 1, step: 1 })

    const seed = parent.snapshotForFork()

    expect(seed.closers).toEqual([
      expect.objectContaining({ type: 'turn/end', data: { turn: 1, reason: { kind: 'forked' } } }),
    ])
    expect(createChild(sessions, parent, seed).deriveMessages()).toEqual(parent.deriveMessages())
  })

  it('keeps unassembled attempt streams in the event log without projecting them into model history', async () => {
    const sessions = await setup()
    const parent = sessions.create()
    beginTurn(parent)
    parent.append('assistant/attempt', {
      turn: 1, step: 1,
      stream: [
        { type: 'reasoning-chunks', time0: 0, index: 0, dt: [1], texts: ['Unfinished reasoning.'] },
        { type: 'text-chunks', time0: 1, index: 1, dt: [1], texts: ['Unfinished response.'] },
      ],
    })

    const seed = parent.snapshotForFork()
    const child = createChild(sessions, parent, seed)

    expect(seed.events).toEqual(parent.snapshotEvents())
    expect(seed.closers.map(event => event.type)).toEqual(['step/end', 'turn/end'])
    expect(child.deriveMessages()).toEqual(parent.deriveMessages())
    expect(child.deriveMessages().map(message => message.role)).toEqual(['user'])
  })

  it.each(['summary', 'tool-result'] as const)('preserves a %s surface replacement before the pending fork call', async (replacement) => {
    const sessions = await setup()
    const parent = sessions.create()
    beginTurn(parent)
    const call = toolCall('inspected')
    parent.append('assistant/message', {
      turn: 1, step: 1, message: assistant([call]),
      stream: [],
    }, { surfaceOp: 'append' })
    parent.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
    const original = parent.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'Detailed evidence.' }], isError: false }),
    }, { surfaceOp: 'append' })
    parent.append('step/end', { turn: 1, step: 1 })
    if (replacement === 'summary') {
      const sources = [...parent.surface.nodes]
      const start = sources.at(0)
      const end = sources.at(-1)
      if (start === undefined || end === undefined) throw new Error('missing compactable surface')
      parent.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Earlier investigation summary.' }], source: { kind: 'user' },
      }), { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: sources })
    } else {
      parent.append('tool/result', {
        ...original.data,
        message: freezeMessage({
          ...original.data.message,
          content: [{ ...original.data.message.content[0], content: [{ type: 'text', text: 'Pruned evidence.' }] }] satisfies typeof original.data.message.content,
        }),
      }, { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
    }
    parent.append('step/start', { turn: 1, step: 2 })
    parent.append('assistant/message', {
      turn: 1, step: 2, message: assistant([toolCall('fork-after-replacement')]),
      stream: [],
    }, { surfaceOp: 'append' })
    const messages = parent.deriveMessages()

    const seed = parent.snapshotForFork()
    const results = toolResults(seed.closers)
    const child = createChild(sessions, parent, seed)

    expect(results.map(event => event.data.message.source.callId)).toEqual(['fork-after-replacement'])
    expect(child.deriveMessages()).toEqual([...messages, ...results.map(event => event.data.message)])
    expect(parent.deriveMessages()).toEqual(messages)
  })

  it('inherits an earlier fork closure once while closing the immediate parent current turn', async () => {
    const sessions = await setup()
    const parent = sessions.create()
    beginTurn(parent)
    parent.append('assistant/message', {
      turn: 1, step: 1, message: assistant([toolCall('first-fork')]),
      stream: [],
    }, { surfaceOp: 'append' })
    const parentEvents = parent.snapshotEvents()
    const child = createChild(sessions, parent, parent.snapshotForFork())
    child.append('turn/start', { turn: 2 })
    child.append('step/start', { turn: 2, step: 1 })
    child.append('assistant/message', {
      turn: 2, step: 1,
      message: assistant([{ type: 'reasoning', text: 'Delegate a narrower follow-up.' }, toolCall('second-fork')]),
      stream: [],
    }, { surfaceOp: 'append' })
    const childEvents = child.snapshotEvents()

    const seed = child.snapshotForFork()
    const grandchild = createChild(sessions, child, seed)
    const newResults = toolResults(seed.closers)

    expect(seed.inheritedEventCount).toBe(childEvents.length)
    expect(seed.events).toEqual(childEvents)
    expect(newResults.map(event => event.data.message.source.callId)).toEqual(['second-fork'])
    expect(toolResults(grandchild.snapshotEvents()).map(event => event.data.message.source.callId)).toEqual(['first-fork', 'second-fork'])
    expect(grandchild.deriveMessages()).toEqual([...child.deriveMessages(), ...newResults.map(event => event.data.message)])
    grandchild.append('turn/start', { turn: 3 })
    expect(parent.snapshotEvents()).toBe(parentEvents)
    expect(child.snapshotEvents()).toBe(childEvents)
  })
})
