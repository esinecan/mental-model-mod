import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { REMINDER, describeChanges, destroyedNames, diffNotes, isCovered, isWrite, namedIn, shouldRemind, targetOf } from './register'

// The test's hooks stand for the engine beneath the mod: a clock, the
// session state, the status line, and tool registration.
function standIn(on: On) {
  const values = new Map<string, { value: unknown; version: number }>()
  const keyOf = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`

  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
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
const CHECK = {
  tool: 'mcp__mental-model__check',
  targets: ['plan.md'],
  asked: '"rewrite the plan"',
  amount: 'only the plan file, nothing else',
  sentence: 'The plan is rewritten.',
}

test('reads pass, writes are writes, stderr redirects are reads', () => {
  expect(isWrite('Read', { file_path: 'a' })).toBe(false)
  expect(isWrite('Bash', { command: 'git log -3' })).toBe(false)
  expect(isWrite('Bash', { command: 'grep -rn foo . 2>/dev/null' })).toBe(false)
  expect(isWrite('Bash', { command: 'claude plugin validate ./x 2>&1 | head' })).toBe(false)
  expect(isWrite('Bash', { command: 'cat a > b' })).toBe(true)
  expect(isWrite('Bash', { command: 'rm -rf x' })).toBe(true)
  expect(isWrite('Write', { file_path: 'a' })).toBe(true)
  expect(isWrite('mcp__memory-store__memory_update', {})).toBe(true)
  expect(isWrite('mcp__mental-model__check', {})).toBe(false)
})

test('a check covers its targets only', () => {
  const list = [{ targets: ['C:\\x\\plan.md'], asked: '"fix the plan"', amount: 'just the plan', sentence: 'The plan is fixed.', at: 0 }]
  expect(isCovered(targetOf('Edit', { file_path: 'C:/x/plan.md' }), list) !== undefined).toBe(true)
  expect(isCovered(targetOf('Edit', { file_path: 'C:/x/other.md' }), list)).toBe(undefined)
})

test('a destructive command names what it destroys, temp folders excepted', () => {
  expect(destroyedNames('Bash', { command: 'cd ~/.claude && rm -rf ~/.claude/mods/mental-model && ls' })).toEqual(['mental-model'])
  expect(destroyedNames('PowerShell', { command: 'Remove-Item -Recurse -Force "C:\\Users\\yepis\\.claude\\mods\\mental-model"' })).toEqual(['mental-model'])
  expect(destroyedNames('Bash', { command: 'rm -rf "$TEMP/claude/x/scratchpad/recovered"' })).toEqual([])
  expect(destroyedNames('Bash', { command: 'git log --oneline' })).toEqual([])
})

test("Eren's words name the target or they do not", () => {
  expect(namedIn('"you should know mod is not working. remove it"', 'mental-model')).toBe(false)
  expect(namedIn('"restore the mental model mod, then remove the you should know mod"', 'mental-model')).toBe(true)
  expect(namedIn('"delete old_build"', 'old-build')).toBe(true)
})

test('the diff names each changed field', () => {
  const previous = { want: 'a', inHisHead: 'b', version: 1, at: 0 }
  expect(diffNotes(null, { want: 'a', inHisHead: 'b' })).toEqual([])
  expect(describeChanges(diffNotes(previous, { want: 'a', inHisHead: 'b' }))).toBe('unchanged')
  expect(describeChanges(diffNotes(previous, { want: 'c', inHisHead: 'b' }))).toBe('what he wants: was «a» now «c»')
})

test('the reminder fires when the note is missing, stale or asked for', () => {
  const current = { want: 'a', inHisHead: 'b', version: 1, at: 0 }
  expect(shouldRemind({ note: null, remind: false, messagesSinceNote: 0 })).toBe(true)
  expect(shouldRemind({ note: current, remind: false, messagesSinceNote: 2 })).toBe(false)
  expect(shouldRemind({ note: current, remind: true, messagesSinceNote: 2 })).toBe(true)
  expect(shouldRemind({ note: current, remind: false, messagesSinceNote: 6 })).toBe(true)
  expect(REMINDER).toContain('mcp__mental-model__note')
})

test('a write without a note is denied, and so is a check', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Write' }, () => WRITE_RESULT)
  const checked = await $.tool.call(CHECK)
  expect(String(checked.deny ?? checked.text)).toContain('no note exists')
  const run = await $.tool.call({ tool: 'Write', file_path: 'C:/x/plan.md', content: 'y' })
  expect(String(run.deny ?? run.text)).toContain('no note exists')
})

test('a write without a check is denied once a note exists', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Write' }, () => WRITE_RESULT)
  await $.tool.call(NOTE)
  const run = await $.tool.call({ tool: 'Write', file_path: 'C:/x/plan.md', content: 'y' })
  expect(String(run.deny ?? run.text)).toContain('no check covers this write')
})

test('a write passes after a note and a check that names it', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Write' }, () => WRITE_RESULT)
  await $.tool.call(NOTE)
  const checked = await $.tool.call(CHECK)
  expect(checked.isError).toBe(undefined)
  const run = await $.tool.call({ tool: 'Write', file_path: 'C:/x/plan.md', content: 'y' })
  expect(run.isError).toBe(undefined)
})

test("today's delete is refused: the check's quoted words do not name the folder", async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call(NOTE)
  await $.tool.call({
    tool: 'mcp__mental-model__check',
    targets: ['~/.claude/mods/mental-model', 'rm'],
    asked: '"you should know mod is not working. remove it"',
    amount: 'enough',
    sentence: 'The mod is removed.',
  })
  const run = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/.claude/mods/mental-model' })
  expect(String(run.deny ?? run.text)).toContain('do not name it')
})

test('the same delete passes when his words name the folder', async ($, on) => {
  standIn(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call(NOTE)
  await $.tool.call({
    tool: 'mcp__mental-model__check',
    targets: ['~/.claude/mods/mental-model', 'rm'],
    asked: '"remove the mental model mod"',
    amount: 'enough',
    sentence: 'The mental-model mod is removed.',
  })
  const run = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/.claude/mods/mental-model' })
  expect(run.isError).toBe(undefined)
  expect(run.deny).toBe(undefined)
})

const textOf = (run: { text?: unknown; result?: unknown }) =>
  String(run.text ?? (typeof run.result === 'string' ? run.result : JSON.stringify(run.result)))

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
