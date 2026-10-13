import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Change, Note, Origin } from '../types'

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
const isRemoveAllArmed = atom({ plugin: 'mental-model', key: 'isRemoveAllArmed' } as const, false)
const prompts = atom({ plugin: 'mental-model', key: 'prompts' } as const, 0)
const loadedFor = atom({ plugin: 'mental-model', key: 'loadedFor' } as const, null)

const origin = derive([note, history], (current, past) => (current ? originOf(past, current) : null))

export const REMINDER =
  `Write down/update your understanding of user's intent, knowledge and gaps using the \`${NOTE_TOOL}\` tool. ` +
  "This will help you tailor your effort to user's needs, and help the user to catch drift early on."

export const IMPORTANT = 'IMPORTANT: '

export const NUDGE =
  `${PLUGIN}: your note of the user predates the user's last message. ` +
  `If what the user wants, knows or is missing has changed, rewrite it with ${NOTE_TOOL} before continuing this string of writes.`

export const NUDGE_EMPTY =
  `THIS IS VERY IMPORTANT: ${PLUGIN}: you have not written a note of the user yet. ` +
  `Write it with ${NOTE_TOOL} before continuing this string of writes.`

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
    update($, isRemoveAllArmed, () => false),
  ])
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

export function originOf(past: Note[], current: Note | null = null): Origin {
  const previous = past[past.length - 1]
  if (!previous) return { kind: 'first' }
  return { kind: 'changed', previous, changes: current ? diffNotes(previous, current) : [] }
}

function originForModel(o: Origin): string {
  if (o.kind === 'changed') return `Changed since v${o.previous.version}: ${describeChanges(o.changes)}.`
  return 'First note.'
}

function originForBand(o: Origin): string {
  if (o.kind === 'changed') return ` · changed: ${o.changes.map(c => label(c.field)).join(', ')}`
  return ''
}

function noteForModel(current: Note, o: Origin): string {
  const lines = [
    `Your working model of the user (${PLUGIN}, note v${current.version}):`,
    `Intent: ${current.want}`,
    `Knowledge and gaps: ${current.inTheirHead}`,
  ]
  if (o.kind === 'changed') lines.push(originForModel(o))
  return lines.join('\n')
}

function ago(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
    await Promise.all([
      update($, settled, () => true),
      update($, remind, () => false),
      update($, isRemoveAllArmed, () => false),
    ])
    if (previous && !diffNotes(previous, { want, inTheirHead }).length) {
      return { result: `Note unchanged (v${previous.version}).` }
    }
    const entry: Note = { want, inTheirHead, version: nextVersion(previous, past), at: await $.clock.now() }
    if (previous) await update($, history, list => [...list, previous].slice(-HISTORY_CAP))
    await update($, note, () => entry)
    await save($)
    return { result: `Note v${entry.version} written. ${originForModel(originOf(await read($, history), entry))}` }
  })

  on('tool.call', async ($, e, next) => {
    const inMainLoop = (e as { agentId?: string }).agentId === undefined
    if (!inMainLoop || e.tool === NOTE_TOOL || (await read($, settled))) return next(e)
    const answer = await next(e)
    if (answer.deny !== undefined || answer.isError || answer.isReadOnly) return answer
    await update($, settled, () => true)
    const text = (await read($, note)) ? NUDGE : NUDGE_EMPTY
    return { ...answer, context: [...(answer.context ?? []), text] }
  })

  on('prompt.submit', async ($, e, next) => {
    const fromUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!fromUser) return next(e)
    await load($)
    await Promise.all([
      update($, settled, () => false),
      update($, prompts, n => n + 1),
      update($, isRemoveAllArmed, () => false),
    ])
    const [current, o, reminded, count] = await Promise.all([read($, note), read($, origin), read($, remind), read($, prompts)])
    const lines: string[] = []
    if (current && o) lines.push(noteForModel(current, o))
    if (!current || reminded) lines.push(!current && count >= 2 ? IMPORTANT + REMINDER : REMINDER)
    return next({ ...e, context: [...(e.context ?? []), ...lines] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const [current, past, o, hidden, open, reminded, armed, now] = await Promise.all([
      read($, note), read($, history), read($, origin), read($, isHidden),
      read($, showHistory), read($, remind), read($, isRemoveAllArmed), $.clock.now(),
    ])
    const stamp = current && o ? `v${current.version}${originForBand(o)}` : ''

    const disarm = () => update($, isRemoveAllArmed, () => false)
    const andDisarm = (act: () => unknown) => async () => {
      await disarm()
      await act()
    }

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

    const glyph = (key: string, hotkey: string, icon: string, word: string, onPress: () => void, primary = false) => (
      <Box key={`${key}-hover`} marginLeft={key === 'hide' ? 0 : 1} marginRight={key === 'hide' ? 2 : 0}>
        <Button key={key} label={icon} hotkey={hotkey} plain variant={primary ? 'primary' : undefined} onPress={onPress} />
        <Box position="absolute" top={1} left={0} display="none" hover={{ display: 'flex' }}>
          <Text backgroundColor="subtle" color="inverseText">{` ${word} `}</Text>
        </Box>
      </Box>
    )

    const removeNote = async () => {
      await update($, note, () => null)
      await save($)
    }
    const removeAll = async () => {
      await Promise.all([
        update($, note, () => null),
        update($, history, () => []),
        update($, showHistory, () => false),
        disarm(),
      ])
      await save($)
    }

    const header = (
      <Box justifyContent="space-between">
        <Box>
          {glyph('hide', 'h', '−', 'Hide', andDisarm(() => update($, isHidden, () => true)))}
          <Text bold>Claude's model of you</Text>
          {current ? <Text dimColor>{`  ${stamp} · ${ago(now, current.at)}`}</Text> : null}
        </Box>
        <Box>
          {past.length
            ? glyph('history', 's', '≡', open ? 'Hide history' : `History (${past.length})`, andDisarm(() => update($, showHistory, v => !v)), open)
            : null}
          {glyph('remind', 'u', reminded ? '✓' : 'U', reminded ? 'Updates on next prompt' : 'Update on next prompt', andDisarm(() => update($, remind, () => true)), reminded)}
          {current ? glyph('remove', 'd', '×', 'Remove', andDisarm(removeNote)) : null}
          {current || past.length
            ? glyph('removeAll', 'a', '∅', armed ? 'Cancel Remove all' : 'Remove all, history too', () => update($, isRemoveAllArmed, v => !v), armed)
            : null}
        </Box>
      </Box>
    )

    const older = plural(past.length, 'older version')
    const question = current ? (past.length ? `Remove the note and ${older}?` : 'Remove the note?') : `Remove all ${older}?`
    const confirm = armed && (current || past.length) ? (
      <Box key="confirm">
        <Text>{`${question} There is no undo.  `}</Text>
        <Button key="confirmRemoveAll" label="Remove all" hotkey="y" variant="primary" onPress={removeAll} />
        <Box marginLeft={1}>
          <Button key="cancelRemoveAll" label="Keep" hotkey="n" onPress={disarm} />
        </Box>
      </Box>
    ) : null

    if (!current) {
      return (
        <Box flexDirection="column">
          {header}
          {confirm}
          <Text dimColor wrap="wrap">Claude has not written down what you want yet.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {confirm}
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
