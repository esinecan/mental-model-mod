import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NUDGE, describeChanges, diffNotes } from './register'

// The test's hooks stand for the engine beneath the mod: a clock and tool
// registration. The kit answers $.state and a render's $.ui.invalidate.
function standIn(on: On) {
  mock.clock(on, { now: 1_000_000 })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e as never)
    return h(Box, {})
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__mental-model__${e.name}` } }))
}

const WRITE_RESULT = { result: { type: 'create', filePath: 'C:/x/plan.md', content: 'y' } }
const NOTE = { tool: 'mcp__mental-model__note', want: 'send one message', in_their_head: 'the user knows the text' }
const textOf = (run: { text?: unknown; result?: unknown }) =>
  String(run.text ?? (typeof run.result === 'string' ? run.result : JSON.stringify(run.result)))

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
  expect((first.context ?? []).includes(NUDGE)).toBe(true)
  const second = await $.tool.call({ tool: 'Write', file_path: 'C:/x/other.md', content: 'y' })
  expect(second.deny).toBe(undefined)
  expect((second.context ?? []).includes(NUDGE)).toBe(false)
})

test('a read-only call carries no nudge and leaves it for the first write', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'text', isReadOnly: true as const }))
  on('tool.call', { tool: 'Write' }, () => WRITE_RESULT)
  const read = await $.tool.call({ tool: 'Read', file_path: 'C:/x/plan.md' })
  expect((read.context ?? []).includes(NUDGE)).toBe(false)
  const write = await $.tool.call({ tool: 'Write', file_path: 'C:/x/plan.md', content: 'y' })
  expect((write.context ?? []).includes(NUDGE)).toBe(true)
})

test('a write after a note in the same turn carries no nudge', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Write' }, () => WRITE_RESULT)
  await $.tool.call(NOTE)
  const run = await $.tool.call({ tool: 'Write', file_path: 'C:/x/plan.md', content: 'y' })
  expect(run.deny).toBe(undefined)
  expect((run.context ?? []).includes(NUDGE)).toBe(false)
})

test('the note needs both fields and reports its own changes', async ($, on) => {
  standIn(on)
  const bad = await $.tool.call({ tool: 'mcp__mental-model__note', want: 'x', in_their_head: '' })
  expect(bad.deny !== undefined || bad.isError === true).toBe(true)
  const first = await $.tool.call(NOTE)
  expect(first.isError).toBe(undefined)
  expect(textOf(first)).toContain('Note v1 written')
  const same = await $.tool.call(NOTE)
  expect(textOf(same)).toContain('unchanged')
  const second = await $.tool.call({ ...NOTE, want: 'send two messages' })
  expect(textOf(second)).toContain('Note v2 written')
  expect(textOf(second)).toContain('was «send one message» now «send two messages»')
})

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20 } } as const

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
  expect((await ui.find({ key: 'remind' }))?.props.label).toBe('↻')
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
