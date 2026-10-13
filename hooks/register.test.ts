import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { IMPORTANT, NUDGE, NUDGE_EMPTY, REMINDER, describeChanges, diffNotes } from './register'

// The test's hooks stand for the engine beneath the mod: a clock, a store on
// disk, the session id, redraws, prompts, system prompt sections and tool
// registration. The kit answers $.state. Each prompt's context lands in `sent`.
function standIn(on: On, saved: Record<string, unknown> = {}) {
  const sent: (readonly string[])[] = []
  mock.clock(on, { now: 1_000_000 })
  mock.store(on, saved)
  on('session.id', () => ({ value: 's1' }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    sent.push(e.context ?? [])
    return { text: e.text }
  })
  on('prompt.section', ($, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e as never)
    return h(Box, {}) as RenderElement
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__mental-model__${e.name}` } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return sent
}

// Starts the session as the engine does before the first prompt: the saved
// note loads and the note tool registers.
const start = ($: { session: { start: (e: { cwd: string; surface: 'terminal'; isInteractive: boolean }) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })

const ask = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const WRITE_RESULT = { result: { type: 'create', filePath: 'C:/x/plan.md', content: 'y' } }
const NOTE = { tool: 'mcp__mental-model__note', want: 'send one message', in_their_head: 'the user knows the text' } as const
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const
const textOf = (run: { text?: unknown; result?: unknown }) =>
  String(run.text ?? (typeof run.result === 'string' ? run.result : JSON.stringify(run.result)))
const joined = (context: readonly string[] | undefined) => (context ?? []).join('\n')

test('the diff names each changed field', () => {
  const previous = { want: 'a', inTheirHead: 'b', version: 1, at: 0 }
  expect(diffNotes(null, { want: 'a', inTheirHead: 'b' })).toEqual([])
  expect(describeChanges(diffNotes(previous, { want: 'a', inTheirHead: 'b' }))).toBe('unchanged')
  expect(describeChanges(diffNotes(previous, { want: 'c', inTheirHead: 'b' }))).toBe('intent: was «a» now «c»')
})

test('a write runs without a note and carries one nudge per turn', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Write' }, () => WRITE_RESULT)
  const first = await $.tool.call({ tool: 'Write', file_path: 'C:/x/plan.md', content: 'y' })
  expect(first.deny).toBe(undefined)
  expect(first.isError).toBe(undefined)
  expect((first.context ?? []).includes(NUDGE_EMPTY)).toBe(true)
  const second = await $.tool.call({ tool: 'Write', file_path: 'C:/x/other.md', content: 'y' })
  expect(second.deny).toBe(undefined)
  expect((second.context ?? []).includes(NUDGE_EMPTY)).toBe(false)
})

test('a read-only call carries no nudge and leaves it for the first write', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'text', isReadOnly: true as const }))
  on('tool.call', { tool: 'Write' }, () => WRITE_RESULT)
  const read = await $.tool.call({ tool: 'Read', file_path: 'C:/x/plan.md' })
  expect((read.context ?? []).includes(NUDGE)).toBe(false)
  const write = await $.tool.call({ tool: 'Write', file_path: 'C:/x/plan.md', content: 'y' })
  expect((write.context ?? []).includes(NUDGE_EMPTY)).toBe(true)
})

test('a write after a note in the same turn carries no nudge', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Write' }, () => WRITE_RESULT)
  await $.tool.call(NOTE)
  const run = await $.tool.call({ tool: 'Write', file_path: 'C:/x/plan.md', content: 'y' })
  expect(run.deny).toBe(undefined)
  expect((run.context ?? []).includes(NUDGE)).toBe(false)
})

test('a write after a new user message, with a note, carries the plain nudge', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Write' }, () => WRITE_RESULT)
  await $.tool.call(NOTE)
  await $.prompt.submit(ask('next request'))
  const run = await $.tool.call({ tool: 'Write', file_path: 'C:/x/plan.md', content: 'y' })
  expect((run.context ?? []).includes(NUDGE)).toBe(true)
})

test('the reminder for a missing note gains IMPORTANT from the second message on, and stops once a note exists', async ($, on) => {
  const sent = standIn(on)
  await $.prompt.submit(ask('one'))
  await $.prompt.submit(ask('two'))
  expect(sent[0]).toEqual([REMINDER])
  expect(sent[1]).toEqual([IMPORTANT + REMINDER])
  await $.tool.call(NOTE)
  await $.prompt.submit(ask('three'))
  expect(joined(sent[2])).not.toContain(REMINDER)
})

test('the note and its history are saved per session and loaded back', async ($, on) => {
  const saved = { 'session/s1': { note: { want: 'kept want', inTheirHead: 'kept knows', version: 4, at: 0 }, history: [] }, order: ['s1'] }
  const sent = standIn(on, saved)
  await $.prompt.submit(ask('after a restart'))
  expect(joined(sent[0])).not.toContain(REMINDER)
  expect(joined(sent[0])).toContain('Intent: kept want')
  const written = await $.tool.call({ ...NOTE, want: 'new want' })
  expect(textOf(written)).toContain('Note v5 written')
})

test('the note needs both fields and reports its own changes', async ($, on) => {
  standIn(on)
  const bad = await $.tool.call({ ...NOTE, want: 'x', in_their_head: '' })
  expect(bad.deny !== undefined || bad.isError === true).toBe(true)
  const first = await $.tool.call(NOTE)
  expect(first.isError).toBe(undefined)
  expect(textOf(first)).toContain('Note v1 written')
  expect(textOf(first)).toContain('First note')
  const same = await $.tool.call(NOTE)
  expect(textOf(same)).toContain('unchanged')
  const second = await $.tool.call({ ...NOTE, want: 'send two messages' })
  expect(textOf(second)).toContain('Note v2 written')
  expect(textOf(second)).toContain('was «send one message» now «send two messages»')
})

// The note reaches the model on the user's message, never in the system
// prompt: a system prompt that changes mid-session misses the prompt cache for
// the whole conversation after it.

test('writing or removing a note leaves the system prompt as it was', async ($, on) => {
  standIn(on)
  const section = () => $.prompt.section({ name: 'env_info_simple', text: 'Platform: darwin' })
  const before = await section()
  await $.tool.call(NOTE)
  await $.tool.call({ ...NOTE, want: 'send two messages' })
  expect(await section()).toEqual(before)
  const ui = await $.ui.mount({ plugin: 'mental-model', surface: 'terminal', ...BAND })
  await ui.press({ key: 'remove' })
  expect(await section()).toEqual(before)
  await ui.unmount()
})

test('each user message carries the current note and its last change', async ($, on) => {
  const sent = standIn(on)
  await $.tool.call(NOTE)
  await $.tool.call({ ...NOTE, want: 'send two messages' })
  await $.prompt.submit(ask('go on'))
  const context = joined(sent[0])
  expect(context).toContain('note v2')
  expect(context).toContain('Intent: send two messages')
  expect(context).toContain('Knowledge and gaps: the user knows the text')
  expect(context).toContain('Changed since v1: intent: was «send one message» now «send two messages»')
  expect(context).not.toContain(REMINDER)
})

test('Update on next prompt sends the reminder beside the note until Claude rewrites it', async ($, on) => {
  const sent = standIn(on)
  await start($)
  await $.tool.call(NOTE)
  const ui = await $.ui.mount({ plugin: 'mental-model', surface: 'terminal', ...BAND })
  await ui.press({ key: 'remind' })
  await $.prompt.submit(ask('one'))
  await $.prompt.submit(ask('two'))
  await $.tool.call({ ...NOTE, want: 'send two messages' })
  await $.prompt.submit(ask('three'))
  expect(joined(sent[0])).toContain('Intent: send one message')
  expect((sent[0] ?? []).includes(REMINDER)).toBe(true)
  expect((sent[1] ?? []).includes(REMINDER)).toBe(true)
  expect((sent[2] ?? []).includes(REMINDER)).toBe(false)
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) test(`on ${surface}, the band shows the whole note and which field changed, and its glyph buttons work`, async ($, on) => {
  standIn(on)
  await $.tool.call(NOTE)
  await $.tool.call({ ...NOTE, want: 'send two messages' })
  const ui = await $.ui.mount({ plugin: 'mental-model', surface, ...BAND })
  expect(await ui.find({ type: 'Text', text: /send two messages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /the user knows the text/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /changed: intent/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^v1 · / })).toBe(undefined)
  await ui.press({ key: 'history' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^v1 · / })).toBeDefined()
  await ui.press({ key: 'history' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^v1 · / })).toBe(undefined)
  await ui.press({ key: 'remind' })
  await ui.redraw()
  expect((await ui.find({ key: 'remind' }))?.props.label).toBe('✓')
  await $.tool.call({ ...NOTE, want: 'send three messages' })
  await ui.redraw()
  expect((await ui.find({ key: 'remind' }))?.props.label).toBe('U')
  expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
  await ui.press({ key: 'remove' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /send three messages/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /not written down what you want yet/ })).toBeDefined()
  expect(await ui.find({ key: 'history' })).toBeDefined()
  await ui.press({ key: 'removeAll' })
  await ui.press({ key: 'confirmRemoveAll' })
  await ui.redraw()
  expect(await ui.find({ key: 'history' })).toBe(undefined)
  expect(await ui.find({ key: 'removeAll' })).toBe(undefined)
  await $.tool.call({ ...NOTE, want: 'send three messages' })
  await ui.redraw()
  await ui.press({ key: 'hide' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /send two messages/ })).toBe(undefined)
  expect(await ui.find({ key: 'show' })).toBeDefined()
  await ui.press({ key: 'show' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /send three messages/ })).toBeDefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) test(`on ${surface}, the band says so while no note exists`, async ($, on) => {
  standIn(on)
  const ui = await $.ui.mount({ plugin: 'mental-model', surface, ...BAND })
  expect(await ui.find({ type: 'Text', text: /not written down what you want yet/ })).toBeDefined()
  expect(await ui.find({ key: 'history' })).toBe(undefined)
  await ui.unmount()
})

// After Remove, the band tells the user that the new note replaces the one
// they removed. The model reads the new note as a first note: it never sees
// the removed note again, nor that the user removed it.

for (const surface of ['terminal', 'desktop'] as const) test(`on ${surface}, a note after Remove is a first note to the model, and the band says it replaces the removed one`, async ($, on) => {
  const sent = standIn(on)
  await $.tool.call(NOTE)
  const ui = await $.ui.mount({ plugin: 'mental-model', surface, ...BAND })
  await ui.press({ key: 'remove' })
  const written = await $.tool.call({ ...NOTE, want: 'send two messages' })
  await ui.redraw()
  await $.prompt.submit(ask('go on'))
  expect(textOf(written)).toContain('Note v2 written')
  expect(textOf(written)).toContain('First note')
  expect(textOf(written)).not.toContain('send one message')
  expect(textOf(written)).not.toContain('removed')
  expect(await ui.find({ type: 'Text', text: /replaces removed v1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /changed:/ })).toBe(undefined)
  expect(joined(sent[0])).toContain('Intent: send two messages')
  expect(joined(sent[0])).not.toContain('send one message')
  expect(joined(sent[0])).not.toContain('removed')
  expect(joined(sent[0])).not.toContain('Changed since')
  await ui.press({ key: 'history' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^v1 · removed · / })).toBeDefined()
  const next = await $.tool.call({ ...NOTE, want: 'send three messages' })
  await ui.redraw()
  expect(textOf(next)).toContain('Changed since v2')
  expect(textOf(next)).not.toContain('send one message')
  expect(await ui.find({ type: 'Text', text: /changed: intent/ })).toBeDefined()
  await ui.unmount()
})

test('a removed note is saved as removed and loads back that way', async ($, on) => {
  const removed = { want: 'old want', inTheirHead: 'old knows', version: 3, at: 0, isRemoved: true }
  const saved = { 'session/s1': { note: null, history: [removed] }, order: ['s1'] }
  standIn(on, saved)
  await start($)
  const written = await $.tool.call({ ...NOTE })
  expect(textOf(written)).toContain('Note v4 written')
  expect(textOf(written)).toContain('First note')
  expect(textOf(written)).not.toContain('old want')
  const ui = await $.ui.mount({ plugin: 'mental-model', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /replaces removed v3/ })).toBeDefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) test(`on ${surface}, a note after Remove all is a first note`, async ($, on) => {
  const sent = standIn(on)
  await $.tool.call(NOTE)
  await $.tool.call({ ...NOTE, want: 'send two messages' })
  const ui = await $.ui.mount({ plugin: 'mental-model', surface, ...BAND })
  await ui.press({ key: 'removeAll' })
  await ui.press({ key: 'confirmRemoveAll' })
  const written = await $.tool.call({ ...NOTE, want: 'send three messages' })
  await ui.redraw()
  await $.prompt.submit(ask('go on'))
  expect(textOf(written)).toContain('Note v1 written')
  expect(textOf(written)).toContain('First note')
  expect(await ui.find({ type: 'Text', text: /changed:|removed/ })).toBe(undefined)
  expect(joined(sent[0])).not.toContain('Changed since')
  expect(joined(sent[0])).not.toContain('removed')
  await ui.unmount()
})

// Remove all deletes the note and every older version, with no undo. One
// press arms it; a second, separate button confirms it.

for (const surface of ['terminal', 'desktop'] as const) test(`on ${surface}, Remove all asks first, and Keep cancels it`, async ($, on) => {
  standIn(on)
  await $.tool.call(NOTE)
  await $.tool.call({ ...NOTE, want: 'send two messages' })
  const ui = await $.ui.mount({ plugin: 'mental-model', surface, ...BAND })
  await ui.press({ key: 'removeAll' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /send two messages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Remove the note and 1 older version\?/ })).toBeDefined()
  expect(await ui.find({ key: 'confirmRemoveAll' })).toBeDefined()
  await ui.press({ key: 'cancelRemoveAll' })
  await ui.redraw()
  expect(await ui.find({ key: 'confirmRemoveAll' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /send two messages/ })).toBeDefined()
  expect(await ui.find({ key: 'history' })).toBeDefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) test(`on ${surface}, an armed Remove all disarms on a user message, another button or a new note`, async ($, on) => {
  standIn(on)
  await $.tool.call(NOTE)
  await $.tool.call({ ...NOTE, want: 'send two messages' })
  const ui = await $.ui.mount({ plugin: 'mental-model', surface, ...BAND })

  await ui.press({ key: 'removeAll' })
  await $.prompt.submit(ask('next request'))
  await ui.redraw()
  expect(await ui.find({ key: 'confirmRemoveAll' })).toBe(undefined)

  await ui.press({ key: 'removeAll' })
  await ui.press({ key: 'history' })
  await ui.redraw()
  expect(await ui.find({ key: 'confirmRemoveAll' })).toBe(undefined)

  await ui.press({ key: 'removeAll' })
  await $.tool.call({ ...NOTE, want: 'send three messages' })
  await ui.redraw()
  expect(await ui.find({ key: 'confirmRemoveAll' })).toBe(undefined)

  await ui.press({ key: 'removeAll' })
  await ui.press({ key: 'removeAll' })
  await ui.redraw()
  expect(await ui.find({ key: 'confirmRemoveAll' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /send three messages/ })).toBeDefined()
  await ui.unmount()
})
