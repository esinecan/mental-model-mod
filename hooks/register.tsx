import { atom, derive, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

import type { Change, Note } from '../types'

// mental-model: the agent's working model of the user, in the user's words,
// shown above the prompt, plus one nudge per turn to rewrite it before a
// string of writes. Nothing blocks a write. The note's evolution is visible
// to the agent in the tool result and the system prompt, and to the user in
// the band.

const PLUGIN = 'mental-model'
const NOTE_TOOL = `mcp__${PLUGIN}__note`
const HISTORY_CAP = 12

const note = atom({ plugin: 'mental-model', key: 'note' } as const, null)
const history = atom({ plugin: 'mental-model', key: 'history' } as const, [])
const settled = atom({ plugin: 'mental-model', key: 'settled' } as const, false)
const isHidden = atom({ plugin: 'mental-model', key: 'isHidden' } as const, false)
const showHistory = atom({ plugin: 'mental-model', key: 'showHistory' } as const, false)
const remind = atom({ plugin: 'mental-model', key: 'remind' } as const, false)

// The note's last change, shared by the system prompt and the band.
const lastChange = derive([note, history], (current, past) => {
  const previous = past[past.length - 1]
  return current && previous ? { previous, changes: diffNotes(previous, current) } : null
})

// The reminder, in the user's own phrasing. It rides beside the user's prompt
// while no note exists, and after Remind until the note is rewritten.
export const REMINDER =
  `Write down/update your understanding of user's intent, knowledge and gaps using the \`${NOTE_TOOL}\` tool. ` +
  "This will help you tailor your effort to user's needs, and help the user to catch drift early on."

// Rides on the first write of a turn whose note predates the user's last
// message. A recommendation: the write has already run.
export const NUDGE =
  `${PLUGIN}: your note of the user predates the user's last message. ` +
  `If what the user wants, knows or is missing has changed, rewrite it with ${NOTE_TOOL} before continuing this string of writes.`

export function diffNotes(previous: Note | null, next: Pick<Note, 'want' | 'inTheirHead'>): Change[] {
  if (!previous) return []
  const changes: Change[] = []
  if (previous.want !== next.want) changes.push({ field: 'want', was: previous.want, now: next.want })
  if (previous.inTheirHead !== next.inTheirHead) changes.push({ field: 'inTheirHead', was: previous.inTheirHead, now: next.inTheirHead })
  return changes
}

const label = (field: Change['field']) => (field === 'want' ? 'intent' : 'knowledge')

export function describeChanges(changes: Change[]): string {
  if (!changes.length) return 'unchanged'
  return changes.map(c => `${label(c.field)}: was «${c.was}» now «${c.now}»`).join('; ')
}

function ago(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.tool.register({
      name: 'note',
      description:
        'Your working model of the user for this conversation. Rewrite it when your understanding changes, not on every message, and before a string of writes when it has. ' +
        "want: the outcome the user wants, in the user's own words. " +
        'in_their_head: what the user knows and believes about the state, and what the user is missing. ' +
        'The result says what changed since the previous note.',
      inputSchema: {
        type: 'object',
        properties: { want: { type: 'string' }, in_their_head: { type: 'string' } },
        required: ['want', 'in_their_head'],
      },
    })
    return result
  })

  on('tool.call', { tool: NOTE_TOOL }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const want = String(args.want ?? '').trim()
    const inTheirHead = String(args.in_their_head ?? '').trim()
    if (!want || !inTheirHead) return { deny: `${NOTE_TOOL}: want and in_their_head are both required.` }
    const previous = await read($, note)
    const changes = diffNotes(previous, { want, inTheirHead })
    await Promise.all([update($, settled, () => true), update($, remind, () => false)])
    if (previous && !changes.length) {
      return { result: `Note unchanged (v${previous.version}).` }
    }
    const entry: Note = { want, inTheirHead, version: (previous?.version ?? 0) + 1, at: await $.clock.now() }
    if (previous) await update($, history, list => [...list, previous].slice(-HISTORY_CAP))
    await update($, note, () => entry)
    await $.ui.invalidate('prompt.section')
    const summary = previous ? `Changed since v${previous.version}: ${describeChanges(changes)}.` : 'First note of this session.'
    return { result: `Note v${entry.version} written. ${summary}` }
  })

  // The nudge: the first write of a turn whose note predates the user's
  // last message carries a recommendation to rewrite the note. The write runs.
  // A write is a call that core did not find read-only by the tool's own check.
  on('tool.call', async ($, e, next) => {
    const inMainLoop = (e as { agentId?: string }).agentId === undefined
    if (!inMainLoop || e.tool === NOTE_TOOL || (await read($, settled))) return next(e)
    const answer = await next(e)
    if (answer.deny !== undefined || answer.isError || answer.isReadOnly) return answer
    await update($, settled, () => true)
    return { ...answer, context: [...(answer.context ?? []), NUDGE] }
  })

  // A message from the user is a new request: the note is stale until
  // rewritten, and the nudge may fire once more. The reminder rides beside the
  // prompt while no note exists, and after Remind until the note is rewritten.
  on('prompt.submit', async ($, e, next) => {
    const fromUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!fromUser) return next(e)
    await update($, settled, () => false)
    const missing = (await read($, note)) === null
    if (!missing && !(await read($, remind))) return next(e)
    return next({ ...e, context: [...(e.context ?? []), REMINDER] })
  })

  // The note in the system prompt, with its last change, so the model sees
  // its own drift all session.
  on('prompt.section', { name: 'env_info_simple' }, async ($, e, next) => {
    const section = await next(e)
    const [current, last] = await Promise.all([read($, note), read($, lastChange)])
    const lines: string[] = []
    if (current) {
      lines.push(`Your working model of the user (${PLUGIN}, note v${current.version}):`)
      lines.push(`Intent: ${current.want}`)
      lines.push(`Knowledge and gaps: ${current.inTheirHead}`)
      if (last) lines.push(`Changed since v${last.previous.version}: ${describeChanges(last.changes)}`)
    } else {
      lines.push(`Your working model of the user (${PLUGIN}): not written yet. Write it with ${NOTE_TOOL}.`)
    }
    return { text: [section.text ?? '', lines.join('\n')].filter(Boolean).join('\n\n') }
  })

  // What the user sees above the prompt. The header row carries the title,
  // the version and the buttons, so the buttons stay at the top when history
  // opens below. Each row is a label column and a text column. Nothing is clipped.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const [current, past, last, hidden, open, reminded, now] = await Promise.all([
      read($, note), read($, history), read($, lastChange), read($, isHidden),
      read($, showHistory), read($, remind), $.clock.now(),
    ])
    const changed = last ? last.changes.map(c => label(c.field)).join(', ') : ''
    const stamp = current ? `v${current.version}${changed ? ` · changed: ${changed}` : ''}` : ''

    if (hidden) {
      return (
        <Box>
          <Text dimColor>{`Model hidden${stamp ? ` · ${stamp}` : ''}  `}</Text>
          <Button key="show" label="+ Show" hotkey="m" plain onPress={() => update($, isHidden, () => false)} />
        </Box>
      )
    }


    const LABEL = 12
    const row = (key: string, head: RenderElement, body: RenderElement) => (
      <Box key={key}>
        <Box width={LABEL} flexShrink={0}>{head}</Box>
        <Box flexGrow={1}>{body}</Box>
      </Box>
    )

    // A small glyph button: the word appears under the pointer.
    const glyph = (key: string, hotkey: string, icon: string, word: string, onPress: () => void, primary = false) => (
      <Box key={`${key}-hover`} marginLeft={1}>
        <Button key={key} label={icon} hotkey={hotkey} plain variant={primary ? 'primary' : undefined} onPress={onPress} />
        <Box position="absolute" top={1} left={0} display="none" hover={{ display: 'flex' }}>
          <Text backgroundColor="subtle" color="inverseText">{` ${word} `}</Text>
        </Box>
      </Box>
    )

    const header = (
      <Box justifyContent="space-between">
        <Box>
          <Text bold>Claude's model of you</Text>
          {current ? <Text dimColor>{`  ${stamp} · ${ago(now, current.at)}`}</Text> : null}
        </Box>
        <Box>
          <Text dimColor>Wrong? Tell Claude.</Text>
          {glyph('hide', 'h', '−', 'Hide', () => update($, isHidden, () => true))}
          {past.length
            ? glyph('history', 's', '≡', open ? 'Hide history' : `History (${past.length})`, () => update($, showHistory, v => !v), open)
            : null}
          {glyph('remind', 'r', reminded ? '✓' : '↻', reminded ? 'Reminded' : 'Remind', () => update($, remind, () => true), reminded)}
        </Box>
      </Box>
    )

    if (!current) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor wrap="wrap">Claude has not written down what you want yet.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {row('want', <Text bold>Want</Text>, <Text wrap="wrap">{current.want}</Text>)}
        {row('knows', <Text bold>Knows</Text>, <Text wrap="wrap">{current.inTheirHead}</Text>)}
        {open ? <Text dimColor>History, newest first</Text> : null}
        {open
          ? past
              .slice()
              .reverse()
              .map(n =>
                row(
                  `v${n.version}`,
                  <Text dimColor>{`v${n.version} · ${ago(now, n.at)}`}</Text>,
                  <Text dimColor wrap="wrap">{`${n.want} — ${n.inTheirHead}`}</Text>,
                ),
              )
          : null}
      </Box>
    )
  })
}
