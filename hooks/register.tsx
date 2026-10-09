import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

import type { Change, Note } from '../types'

// mental-model: the agent's working model of the user, in the user's words,
// shown above the prompt, plus one nudge per turn to rewrite it before a
// string of writes. Nothing blocks a write. The note's
// evolution is visible to the agent in the tool result and the system
// prompt, and to the user in the band.

const PLUGIN = 'mental-model'
const NOTE_TOOL = `mcp__${PLUGIN}__note`
const HISTORY_CAP = 12

const note = atom({ plugin: 'mental-model', key: 'note' } as const, null)
const history = atom({ plugin: 'mental-model', key: 'history' } as const, [])
const noteFresh = atom({ plugin: 'mental-model', key: 'noteFresh' } as const, false)
const nudged = atom({ plugin: 'mental-model', key: 'nudged' } as const, false)
const isHidden = atom({ plugin: 'mental-model', key: 'isHidden' } as const, false)
const showHistory = atom({ plugin: 'mental-model', key: 'showHistory' } as const, false)
const remind = atom({ plugin: 'mental-model', key: 'remind' } as const, false)

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

// Tools that only read. Every other tool call is a write.
const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'ToolSearch', 'WebFetch', 'WebSearch', 'ListAgents',
  'ReadNotifications', 'AskUserQuestion', 'Skill', 'Monitor', 'Agent',
])
const READ_MCP =
  /^mcp__(deepthink__|sequential-thinking__|memory-store__memory_(read|search)$|memoirs__|google-search__|brave-search__|forum__(poll|read|history)$|cortex__(think|task_list|task_context|task_get|current_state|cortex_discover|suggest_state|pathway_status|search_code|get_file_contents|list_|search_|pull_request_read)|gemini__gemini_(whoami|gem_list|models|search_chats|get_|research_history)|terminal__(read_terminal|list_terminal_tabs)$|Claude_Browser__(read_page|get_page_text|find|tabs_context|read_console_messages|read_network_requests|preview_list|preview_logs)$|ccd_|files__(read|list|get|search|directory_tree)|flaui__windows_(list_windows|snapshot|get_text|screenshot)$|isession__(list|read|events|wait)$)/

// A shell command that may change state. Reads (cat, grep, ls, git log) pass,
// and so do stderr redirects (2>&1, 2>/dev/null) and output thrown away.
const SHELL_MUTATION =
  /(^|[;&|]\s*)(rm|mv|cp|tee|touch|mkdir|rmdir|del|sed\s+-i|git\s+(commit|push|revert|reset|checkout|rm|mv|add|init|branch\s+-[dD])|gh\s+(repo|pr|issue|release)\s+(create|delete|edit|merge|close)|python3?|py|node|npx|npm|bun|pwsh|powershell|New-Item|Set-Content|Out-File|Add-Content|Remove-Item|Copy-Item|Move-Item|claude\s+plugin\s+(enable|disable|install|uninstall))\b|(^|[^<>&\d])>{1,2}(?!&|\s*\/dev\/null|\s*nul\b)/i

const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase()

// An inline script (python -c, a heredoc, node -e) is a write only when its
// text writes, deletes, moves or spawns. A script run by file path stays a write.
const INLINE_SCRIPT = /(^|[;&|]\s*)(python3?|py|node|bun)\b[^;&|<]*?(\s-[ce]\s|\s-\s*<<|\s-\s*$|<<)/i
const SCRIPT_MUTATION =
  /(?:\.open\(\s*|(?<![.\w])open\([^)]*,\s*(?:mode\s*=\s*)?)['"][rb]*[wax+]['"]|\.write\(|write_text|write_bytes|writeFile|appendFile|unlink|\.remove\(|removedirs|rmtree|rmSync|rename|replace\(\s*['"][^'"]*['"]\s*\)\s*$|mkdir|makedirs|shutil\.|os\.system|subprocess|child_process|execSync|spawn\(|truncate|chmod|copyfile|copy2|move\(/

export function isWrite(tool: string, args: Record<string, unknown>): boolean {
  if (tool === NOTE_TOOL) return false
  if (READ_TOOLS.has(tool) || READ_MCP.test(tool)) return false
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(args.command ?? '')
    if (INLINE_SCRIPT.test(command)) {
      const rest = command.replace(INLINE_SCRIPT, '')
      return SCRIPT_MUTATION.test(command) || SHELL_MUTATION.test(rest)
    }
    return SHELL_MUTATION.test(command)
  }
  return true
}

export function diffNotes(previous: Note | null, next: Pick<Note, 'want' | 'inHisHead'>): Change[] {
  if (!previous) return []
  const changes: Change[] = []
  if (previous.want !== next.want) changes.push({ field: 'want', was: previous.want, now: next.want })
  if (previous.inHisHead !== next.inHisHead) changes.push({ field: 'inHisHead', was: previous.inHisHead, now: next.inHisHead })
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
        'in_his_head: what the user knows and believes about the state, and what the user is missing. ' +
        'The result says what changed since the previous note.',
      inputSchema: {
        type: 'object',
        properties: { want: { type: 'string' }, in_his_head: { type: 'string' } },
        required: ['want', 'in_his_head'],
      },
    })
    return result
  })

  on('tool.call', { tool: NOTE_TOOL }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const want = String(args.want ?? '').trim()
    const inHisHead = String(args.in_his_head ?? '').trim()
    if (!want || !inHisHead) return { deny: `${NOTE_TOOL}: want and in_his_head are both required.` }
    const previous = await read($, note)
    const changes = diffNotes(previous, { want, inHisHead })
    await update($, noteFresh, () => true)
    if (previous && !changes.length) {
      return { result: `Note unchanged (v${previous.version}).` }
    }
    const entry: Note = { want, inHisHead, version: (previous?.version ?? 0) + 1, at: await $.clock.now() }
    if (previous) await update($, history, list => [...list, previous].slice(-HISTORY_CAP))
    await update($, note, () => entry)
    await update($, remind, () => false)
    await $.ui.invalidate('prompt.section')
    const summary = previous ? `Changed since v${previous.version}: ${describeChanges(changes)}.` : 'First note of this session.'
    return { result: `Note v${entry.version} written. ${summary}` }
  })

  // The nudge: the first write of a turn whose note predates the user's
  // last message carries a recommendation to rewrite the note. The write runs.
  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const inMainLoop = (e as { agentId?: string }).agentId === undefined
    if (!inMainLoop || !isWrite(e.tool, args)) return next(e)
    if ((await read($, noteFresh)) || (await read($, nudged))) return next(e)
    await update($, nudged, () => true)
    const answer = await next(e)
    if (answer.deny !== undefined) return answer
    return { ...answer, context: [...(answer.context ?? []), NUDGE] }
  })

  // A new message from the user is a new request: the note is stale until
  // rewritten, and the nudge may fire once more.
  on('turn.start', async ($, e, next) => {
    if (e.text.trim()) {
      await update($, noteFresh, () => false)
      await update($, nudged, () => false)
    }
    return next(e)
  })

  // The reminder rides beside the user's prompt while no note exists, and
  // after Remind until the note is rewritten.
  on('prompt.submit', async ($, e, next) => {
    const fromUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!fromUser) return next(e)
    const missing = (await read($, note)) === null
    if (!missing && !(await read($, remind))) return next(e)
    return next({ ...e, context: [...(e.context ?? []), REMINDER] })
  })

  // The note in the system prompt, with its last change, so the model sees
  // its own drift all session.
  on('prompt.section', { name: 'env_info_simple' }, async ($, e, next) => {
    const section = await next(e)
    const current = await read($, note)
    const past = await read($, history)
    const lines: string[] = []
    if (current) {
      lines.push(`Your working model of the user (${PLUGIN}, note v${current.version}):`)
      lines.push(`Intent: ${current.want}`)
      lines.push(`Knowledge and gaps: ${current.inHisHead}`)
      const previous = past[past.length - 1]
      if (previous) lines.push(`Changed since v${previous.version}: ${describeChanges(diffNotes(previous, current))}`)
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
    const current = await read($, note)
    const past = await read($, history)
    const previous = past[past.length - 1]
    const changed = current && previous ? diffNotes(previous, current).map(c => label(c.field)).join(', ') : ''
    const stamp = current ? `v${current.version}${changed ? ` · changed: ${changed}` : ''}` : ''

    const hidden = await read($, isHidden)
    if (hidden) {
      return (
        <Box>
          <Text dimColor>{`Model hidden${stamp ? ` · ${stamp}` : ''}  `}</Text>
          <Button key="show" label="+ Show" hotkey="m" plain onPress={() => update($, isHidden, () => false)} />
        </Box>
      )
    }

    const open = await read($, showHistory)
    const reminded = await read($, remind)
    const now = await $.clock.now()

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
        {row('knows', <Text bold>Knows</Text>, <Text wrap="wrap">{current.inHisHead}</Text>)}
        {open ? <Text dimColor>History, newest first</Text> : null}
        {open
          ? past
              .slice()
              .reverse()
              .map(n =>
                row(
                  `v${n.version}`,
                  <Text dimColor>{`v${n.version} · ${ago(now, n.at)}`}</Text>,
                  <Text dimColor wrap="wrap">{`${n.want} — ${n.inHisHead}`}</Text>,
                ),
              )
          : null}
      </Box>
    )
  })
}
