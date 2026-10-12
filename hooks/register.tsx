import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Change, Note } from '../types'

// mental-model: the agent's working model of the user, in the user's words,
// shown above the prompt, plus one nudge per turn to rewrite it before a
// string of writes. Nothing blocks a write. The note's evolution is visible
// to the agent in the tool result and the system prompt, and to the user in
// the band.

const PLUGIN = 'mental-model'
const NOTE_TOOL = `mcp__${PLUGIN}__note`
const HISTORY_CAP = 12
const SESSION_CAP = 50

const note = atom({ plugin: 'mental-model', key: 'note' } as const, null)
const history = atom({ plugin: 'mental-model', key: 'history' } as const, [])
const settled = atom({ plugin: 'mental-model', key: 'settled' } as const, false)
const isHidden = atom({ plugin: 'mental-model', key: 'isHidden' } as const, false)
const showHistory = atom({ plugin: 'mental-model', key: 'showHistory' } as const, false)
const remind = atom({ plugin: 'mental-model', key: 'remind' } as const, false)
const prompts = atom({ plugin: 'mental-model', key: 'prompts' } as const, 0)
const loadedFor = atom({ plugin: 'mental-model', key: 'loadedFor' } as const, null)

// The note's last change, shared by the system prompt and the band.
const lastChange = derive([note, history], (current, past) => {
  const previous = past[past.length - 1]
  return current && previous ? { previous, changes: diffNotes(previous, current) } : null
})

// The reminder, in the user's own phrasing. It rides beside the user's prompt
// while no note exists, and after "Update on next prompt" until the note is rewritten.
export const REMINDER =
  `Write down/update your understanding of user's intent, knowledge and gaps using the \`${NOTE_TOOL}\` tool. ` +
  "This will help you tailor your effort to user's needs, and help the user to catch drift early on."

// From the second user message on, the reminder for a missing note starts with this.
export const IMPORTANT = 'IMPORTANT: '

// Rides on the first write after a user message, when the note was not
// rewritten first. A recommendation: the write has already run.
export const NUDGE =
  `${PLUGIN}: your note of the user predates the user's last message. ` +
  `If what the user wants, knows or is missing has changed, rewrite it with ${NOTE_TOOL} before continuing this string of writes.`

// The nudge when no note exists at all.
export const NUDGE_EMPTY =
  `THIS IS VERY IMPORTANT: ${PLUGIN}: you have not written a note of the user yet. ` +
  `Write it with ${NOTE_TOOL} before continuing this string of writes.`

// The note and its history on disk, one entry per session id, the most
// recent SESSION_CAP sessions kept. A restart or a resume of the same
// session loads them back; a new session id starts empty.
const entryKey = (id: string) => `session/${id}`

async function save($: EngineInterface) {
  const id = await $.session.id()
  const [current, past] = await Promise.all([read($, note), read($, history)])
  await $.store.set(entryKey(id), { note: current, history: past })
  const order = ((await $.store.get('order')) as string[] | undefined) ?? []
  const kept = [...order.filter(k => k !== id), id]
  for (const old of kept.slice(0, Math.max(0, kept.length - SESSION_CAP))) await $.store.delete(entryKey(old))
  await $.store.set('order', kept.slice(-SESSION_CAP))
}

// Loads the session's saved note once per session id: at start, and at the
// first prompt after a /clear or a resume changed the id.
async function load($: EngineInterface) {
  const id = await $.session.id()
  if ((await read($, loadedFor)) === id) return
  const saved = (await $.store.get(entryKey(id))) as { note: Note | null; history: Note[] } | undefined
  await Promise.all([
    update($, loadedFor, () => id),
    update($, note, () => saved?.note ?? null),
    update($, history, () => saved?.history ?? []),
    update($, prompts, () => 0),
    update($, settled, () => false),
    update($, remind, () => false),
  ])
  await $.ui.invalidate('prompt.section')
}

const nextVersion = (current: Note | null, past: Note[]) =>
  Math.max(current?.version ?? 0, ...past.map(n => n.version)) + 1

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
    await load($)
    await $.tool.register({
      name: 'note',
      description:
        'Your working model of the user, shown to the user above the prompt. ' +
        'Rewrite it when your understanding of the user changes, before you act on the new understanding.',
      inputSchema: {
        type: 'object',
        properties: {
          want: { type: 'string', description: "The outcome the user wants, in the user's own words." },
          in_their_head: {
            type: 'string',
            description: 'What the user knows and believes about the current state, and what the user is missing.',
          },
        },
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
    const [previous, past] = await Promise.all([read($, note), read($, history)])
    const changes = diffNotes(previous, { want, inTheirHead })
    await Promise.all([update($, settled, () => true), update($, remind, () => false)])
    if (previous && !changes.length) {
      return { result: `Note unchanged (v${previous.version}).` }
    }
    const entry: Note = { want, inTheirHead, version: nextVersion(previous, past), at: await $.clock.now() }
    if (previous) await update($, history, list => [...list, previous].slice(-HISTORY_CAP))
    await update($, note, () => entry)
    await Promise.all([save($), $.ui.invalidate('prompt.section')])
    const summary = previous ? `Changed since v${previous.version}: ${describeChanges(changes)}.` : 'First note of this session.'
    return { result: `Note v${entry.version} written. ${summary}` }
  })

  // The nudge: the first write after a user message, when the note was not
  // rewritten first, carries a recommendation to rewrite it. The write runs.
  // A write is a call that core did not find read-only by the tool's own check:
  // creating, editing and deleting files all count.
  on('tool.call', async ($, e, next) => {
    const inMainLoop = (e as { agentId?: string }).agentId === undefined
    if (!inMainLoop || e.tool === NOTE_TOOL || (await read($, settled))) return next(e)
    const answer = await next(e)
    if (answer.deny !== undefined || answer.isError || answer.isReadOnly) return answer
    await update($, settled, () => true)
    const text = (await read($, note)) ? NUDGE : NUDGE_EMPTY
    return { ...answer, context: [...(answer.context ?? []), text] }
  })

  // A message from the user is a new request: the note is stale until
  // rewritten, and the nudge may fire once more. The reminder rides beside the
  // prompt while no note exists, with IMPORTANT from the second message on,
  // and after "Update on next prompt" until the note is rewritten.
  on('prompt.submit', async ($, e, next) => {
    const fromUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!fromUser) return next(e)
    await load($)
    await Promise.all([update($, settled, () => false), update($, prompts, n => n + 1)])
    const [current, reminded, count] = await Promise.all([read($, note), read($, remind), read($, prompts)])
    if (current && !reminded) return next(e)
    const text = !current && count >= 2 ? IMPORTANT + REMINDER : REMINDER
    return next({ ...e, context: [...(e.context ?? []), text] })
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
      <Box key={`${key}-hover`} marginLeft={key === 'hide' ? 0 : 1} marginRight={key === 'hide' ? 2 : 0}>
        <Button key={key} label={icon} hotkey={hotkey} plain variant={primary ? 'primary' : undefined} onPress={onPress} />
        <Box position="absolute" top={1} left={0} display="none" hover={{ display: 'flex' }}>
          <Text backgroundColor="subtle" color="inverseText">{` ${word} `}</Text>
        </Box>
      </Box>
    )

    // Remove moves the current note into the history; Remove all clears both.
    const removeNote = async () => {
      const current = await read($, note)
      if (!current) return
      await update($, history, list => [...list, current].slice(-HISTORY_CAP))
      await update($, note, () => null)
      await Promise.all([save($), $.ui.invalidate('prompt.section')])
    }
    const removeAll = async () => {
      await Promise.all([update($, note, () => null), update($, history, () => []), update($, showHistory, () => false)])
      await Promise.all([save($), $.ui.invalidate('prompt.section')])
    }

    const header = (
      <Box justifyContent="space-between">
        <Box>
          {glyph('hide', 'h', '−', 'Hide', () => update($, isHidden, () => true))}
          <Text bold>Claude's model of you</Text>
          {current ? <Text dimColor>{`  ${stamp} · ${ago(now, current.at)}`}</Text> : null}
        </Box>
        <Box>
          {past.length
            ? glyph('history', 's', '≡', open ? 'Hide history' : `History (${past.length})`, () => update($, showHistory, v => !v), open)
            : null}
          {glyph('remind', 'u', reminded ? '✓' : 'U', reminded ? 'Updates on next prompt' : 'Update on next prompt', () => update($, remind, () => true), reminded)}
          {current ? glyph('remove', 'd', '×', 'Remove', removeNote) : null}
          {current || past.length ? glyph('removeAll', 'a', '∅', 'Remove all, history too', removeAll) : null}
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
        <Text key="separator" dimColor wrap="truncate">{'─'.repeat(Math.max(8, e.props.bodyColumns ?? 40))}</Text>
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
