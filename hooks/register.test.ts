import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NUDGE, describeChanges, diffNotes, isWrite } from './register'

// The test's hooks stand for the engine beneath the mod: a clock, the
// session state, the status line, and tool registration.
function standIn(on: On) {
  const values = new Map<string, { value: unknown; version: number }>()
  const keyOf = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`

  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e as never)
    return h(Box, {})
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__mental-model__${e.name}` } }))
  on('state.get', ($, e) => ({ value: values.get(keyOf(e)) ?? { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    const current = values.get(keyOf(e)) ?? { value: undefined, version: 0 }
    const condition = (e as { ifVersion?: number }).ifVersion
    if (condition !== undefined && condition !== current.version) {
      return { value: { isSet: false as const, version: current.version } }
    }
    const next = { value: (e as { value: unknown }).value, version: current.version + 1 }
    values.set(keyOf(e), next)
    return { value: { isSet: true as const, version: next.version } }
  })
}

const WRITE_RESULT = { result: { type: 'create', filePath: 'C:/x/plan.md', content: 'y' } }
const NOTE = { tool: 'mcp__mental-model__note', want: 'send one message', in_his_head: 'he knows the text' }
const textOf = (run: { text?: unknown; result?: unknown }) =>
  String(run.text ?? (typeof run.result === 'string' ? run.result : JSON.stringify(run.result)))

test('reads pass, writes are writes, stderr redirects are reads', () => {
  expect(isWrite('Read', { file_path: 'a' })).toBe(false)
  expect(isWrite('Bash', { command: 'git log -3' })).toBe(false)
  expect(isWrite('Bash', { command: 'grep -rn foo . 2>/dev/null' })).toBe(false)
  expect(isWrite('Bash', { command: 'claude plugin validate ./x 2>&1 | head' })).toBe(false)
  expect(isWrite('Bash', { command: 'cat a > b' })).toBe(true)
  expect(isWrite('Bash', { command: 'rm -rf x' })).toBe(true)
  expect(isWrite('Write', { file_path: 'a' })).toBe(true)
  expect(isWrite('mcp__memory-store__memory_update', {})).toBe(true)
  expect(isWrite('mcp__mental-model__note', {})).toBe(false)
})

test('an inline script is a write only when its text writes', () => {
  expect(isWrite('Bash', { command: "python -c \"import json;print(json.load(open('a.json')))\"" })).toBe(false)
  expect(isWrite('Bash', { command: "cd x && python -X utf8 - <<'EOF'\nfor l in open('a'):\n    print(l)\nEOF" })).toBe(false)
  expect(isWrite('Bash', { command: "python - <<'EOF'\nopen('a','w').write('x')\nEOF" })).toBe(true)
  expect(isWrite('Bash', { command: "python -c \"import shutil;shutil.rmtree('x')\"" })).toBe(true)
  expect(isWrite('Bash', { command: 'node -e "console.log(1)"' })).toBe(false)
  expect(isWrite('Bash', { command: 'python script.py' })).toBe(true)
  expect(isWrite('Bash', { command: 'python -c "print(1)" > out.txt' })).toBe(true)
})

test('the diff names each changed field', () => {
  const previous = { want: 'a', inHisHead: 'b', version: 1, at: 0 }
  expect(diffNotes(null, { want: 'a', inHisHead: 'b' })).toEqual([])
  expect(describeChanges(diffNotes(previous, { want: 'a', inHisHead: 'b' }))).toBe('unchanged')
  expect(describeChanges(diffNotes(previous, { want: 'c', inHisHead: 'b' }))).toBe('intent: was «a» now «c»')
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
  const bad = await $.tool.call({ tool: 'mcp__mental-model__note', want: 'x', in_his_head: '' })
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
  expect(await ui.find({ type: 'Text', text: /he knows the text/ })).toBeDefined()
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
