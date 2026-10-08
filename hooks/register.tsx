import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, Check, Note } from '../types'

// mental-model: Claude's working model of Eren, in his words, kept where he
// can see it and correct it, plus a check before each write.
//
// Built 2026-10-07. Rebuilt 2026-10-08 after a write slipped through with no
// note written and a target Eren's words never named. What changed that day:
//   - no check is accepted while the note is empty
//   - a destructive command needs Eren's quoted words to name its target
//   - the note keeps a history, and every rewrite returns the diff to the
//     agent and shows it to Eren
//   - the box shows the full text, the last change and the last check
//   - the reminder fires only when the note is missing, stale, or asked for

const PLUGIN = 'mental-model'
const NOTE_TOOL = `mcp__${PLUGIN}__note`
const CHECK_TOOL = `mcp__${PLUGIN}__check`
const HISTORY_CAP = 12
const STALE_AFTER_MESSAGES = 6

const note = atom({ plugin: 'mental-model', key: 'note' } as const, null)
const history = atom({ plugin: 'mental-model', key: 'history' } as const, [])
const checks = atom({ plugin: 'mental-model', key: 'checks' } as const, [])
const isHidden = atom({ plugin: 'mental-model', key: 'isHidden' } as const, false)
const showHistory = atom({ plugin: 'mental-model', key: 'showHistory' } as const, false)
const remind = atom({ plugin: 'mental-model', key: 'remind' } as const, false)
const messagesSinceNote = atom({ plugin: 'mental-model', key: 'messagesSinceNote' } as const, 0)

export const REMINDER =
  `Write or update your working model of Eren with ${NOTE_TOOL} before anything else: ` +
  'what he wants, in his words, and what is in his head. He reads it above the prompt.'

// Tools that only read. Every other tool call is a write and needs a check.
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

// A command that destroys something. Its targets must be named in Eren's words.
const DESTRUCTIVE =
  /(^|[;&|]\s*)(rm\s+(?:-\w+\s+)*|rmdir\s+(?:-\w+\s+)*|del\s+(?:\/\w\s+)*|Remove-Item\s+(?:-\w+\s+)*|git\s+branch\s+-[dD]\s+|git\s+push\s+(?:[^;&|]*?)(?:--force|-f)\b[^;&|]*?\s)([^;&|]+)/gi

const TEMP_PATH = /(^|[\\/])(temp|tmp|scratchpad)([\\/]|$)/i

const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase()

// What a check's target is matched against: the file for a file tool, the
// command for a shell, the tool name for everything else.
export function targetOf(tool: string, args: Record<string, unknown>): string {
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.notebook_path === 'string') return args.notebook_path
  if (tool === 'Bash' || tool === 'PowerShell') return String(args.command ?? '')
  return tool
}

export function isWrite(tool: string, args: Record<string, unknown>): boolean {
  if (tool === NOTE_TOOL || tool === CHECK_TOOL) return false
  if (READ_TOOLS.has(tool) || READ_MCP.test(tool)) return false
  if (tool === 'Bash' || tool === 'PowerShell') return SHELL_MUTATION.test(String(args.command ?? ''))
  return true
}

export function isCovered(target: string, list: readonly Check[]): Check | undefined {
  const t = norm(target)
  return list.find(c => c.targets.some(x => x.trim() && t.includes(norm(x.trim()))))
}

// The last path segment of each thing a destructive shell command removes,
// outside temp folders. "rm -rf ~/.claude/mods/mental-model" -> ["mental-model"].
export function destroyedNames(tool: string, args: Record<string, unknown>): string[] {
  if (tool !== 'Bash' && tool !== 'PowerShell') return []
  const command = String(args.command ?? '')
  const names: string[] = []
  for (const m of command.matchAll(DESTRUCTIVE)) {
    for (const raw of m[3].trim().split(/\s+/)) {
      const token = raw.replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '')
      if (!token || token.startsWith('-') || token.startsWith('$') || TEMP_PATH.test(token)) continue
      const base = token.split(/[\\/]/).pop() ?? ''
      if (base && base !== '.' && base !== '..' && base !== '*' && !names.includes(base)) names.push(base)
    }
  }
  return names
}

const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `

// Do Eren's quoted words name this thing? "you should know mod is not working"
// does not name "mental-model"; "remove the mental model mod" does.
export function namedIn(asked: string, name: string): boolean {
  const w = words(name).trim()
  return w.length > 0 && words(asked).includes(` ${w} `)
}

export function diffNotes(previous: Note | null, next: Pick<Note, 'want' | 'inHisHead'>): Change[] {
  if (!previous) return []
  const changes: Change[] = []
  if (previous.want !== next.want) changes.push({ field: 'want', was: previous.want, now: next.want })
  if (previous.inHisHead !== next.inHisHead) changes.push({ field: 'inHisHead', was: previous.inHisHead, now: next.inHisHead })
  return changes
}

const label = (field: Change['field']) => (field === 'want' ? 'what he wants' : 'what is in his head')

export function describeChanges(changes: Change[]): string {
  if (!changes.length) return 'unchanged'
  return changes.map(c => `${label(c.field)}: was «${c.was}» now «${c.now}»`).join('; ')
}

export function shouldRemind(state: { note: Note | null; remind: boolean; messagesSinceNote: number }): boolean {
  return state.note === null || state.remind || state.messagesSinceNote >= STALE_AFTER_MESSAGES
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
        "Write your working model of Eren for this conversation. Rewrite it when your understanding of him changes, not on every message. " +
        'want: the outcome he wants, in his own words. ' +
        'in_his_head: what he knows and believes about the state, and what he is missing that your reply must give him. ' +
        'The result tells you what changed since the previous note.',
      inputSchema: {
        type: 'object',
        properties: { want: { type: 'string' }, in_his_head: { type: 'string' } },
        required: ['want', 'in_his_head'],
      },
    })
    await $.tool.register({
      name: 'check',
      description:
        'Required before a write (a file edit, a shell command that changes state, a memory or task change, a send). ' +
        'Refused while no note exists. One check covers the listed targets until Eren sends his next message. ' +
        'A command that deletes something passes only if Eren\'s quoted words name what it deletes. ' +
        'targets: file paths, command fragments or tool names this check covers. ' +
        'asked: the words of Eren that ask for this write, quoted, or "not asked". ' +
        'amount: is this too much (things he did not ask for) or not enough (things he asked for and you leave undone)? Name them. ' +
        'sentence: the one sentence that tells Eren the result, in his words.',
      inputSchema: {
        type: 'object',
        properties: {
          targets: { type: 'array', items: { type: 'string' } },
          asked: { type: 'string' },
          amount: { type: 'string' },
          sentence: { type: 'string' },
        },
        required: ['targets', 'asked', 'amount', 'sentence'],
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
    if (previous && !changes.length) {
      return { result: `Note unchanged (v${previous.version}). Rewrite it only when your understanding of Eren changes.` }
    }
    const entry: Note = { want, inHisHead, version: (previous?.version ?? 0) + 1, at: await $.clock.now() }
    if (previous) await update($, history, list => [...list, previous].slice(-HISTORY_CAP))
    await update($, note, () => entry)
    await update($, messagesSinceNote, () => 0)
    await update($, remind, () => false)
    await $.ui.invalidate('prompt.section')
    await $.ui.status(`note v${entry.version}`)
    const summary = previous ? `Changed since v${previous.version}: ${describeChanges(changes)}.` : 'First note of this session.'
    return { result: `Note v${entry.version} written. ${summary}` }
  })

  on('tool.call', { tool: CHECK_TOOL }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const targets = Array.isArray(args.targets) ? args.targets.map(String).filter(s => s.trim()) : []
    const asked = String(args.asked ?? '').trim()
    const amount = String(args.amount ?? '').trim()
    const sentence = String(args.sentence ?? '').trim()
    if (!targets.length || !asked || !amount || !sentence) {
      return { deny: `${CHECK_TOOL}: targets, asked, amount and sentence are all required.` }
    }
    if ((await read($, note)) === null) {
      return { deny: `${CHECK_TOOL}: no note exists yet. Write Eren's model with ${NOTE_TOOL} first, then check.` }
    }
    const entry: Check = { targets, asked, amount, sentence, at: await $.clock.now() }
    const list = await update($, checks, l => [...l, entry])
    const warning = /^not asked/i.test(asked)
      ? ' Eren did not ask for this write. Do it only if his request cannot be done without it, and tell him.'
      : ''
    await $.ui.status(`${list.length} check${list.length === 1 ? '' : 's'} this message`)
    return { result: `Check ${list.length} recorded for: ${targets.join(', ')}.${warning}` }
  })

  // The gate: a write in the main loop needs a note and a check that covers
  // its target. A destructive command also needs Eren's words to name the target.
  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const inMainLoop = (e as { agentId?: string }).agentId === undefined
    if (!inMainLoop || !isWrite(e.tool, args)) return next(e)
    if ((await read($, note)) === null) {
      return {
        deny:
          `${PLUGIN}: no note exists, so no write runs. Write Eren's model with ${NOTE_TOOL} ` +
          `(what he wants, in his words; what is in his head), then ${CHECK_TOOL}, then retry.`,
      }
    }
    const target = targetOf(e.tool, args)
    const covering = isCovered(target, await read($, checks))
    if (!covering) {
      return {
        deny:
          `${PLUGIN}: no check covers this write (${target.length > 100 ? target.slice(0, 99) + '…' : target}). ` +
          `Call ${CHECK_TOOL}: quote Eren's words that ask for it, say whether it is too much or not enough, ` +
          'and write the one sentence that tells him the result. Then retry.',
      }
    }
    const unnamed = destroyedNames(e.tool, args).filter(name => !namedIn(covering.asked, name))
    if (unnamed.length) {
      return {
        deny:
          `${PLUGIN}: this command deletes ${unnamed.map(n => `"${n}"`).join(', ')} and Eren's quoted words ` +
          `(${covering.asked}) do not name ${unnamed.length === 1 ? 'it' : 'them'}. ` +
          'Ask him to confirm the target by name, or find the thing he did name. Do not delete on a guess.',
      }
    }
    return next(e)
  })

  // A new message from Eren is a new request: earlier checks stop covering writes.
  on('turn.start', async ($, e, next) => {
    if (e.text.trim()) await update($, checks, () => [])
    return next(e)
  })

  // The reminder rides beside his prompt only when the note is missing, stale,
  // or he pressed Remind.
  on('prompt.submit', async ($, e, next) => {
    const fromEren = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!fromEren) return next(e)
    const count = await update($, messagesSinceNote, n => n + 1)
    const state = { note: await read($, note), remind: await read($, remind), messagesSinceNote: count }
    if (!shouldRemind(state)) return next(e)
    await update($, remind, () => false)
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
      lines.push(`Your working model of Eren (plugin ${PLUGIN}, note v${current.version}):`)
      lines.push(`What he wants: ${current.want}`)
      lines.push(`What is in his head: ${current.inHisHead}`)
      const previous = past[past.length - 1]
      if (previous) lines.push(`Changed since v${previous.version}: ${describeChanges(diffNotes(previous, current))}`)
    } else {
      lines.push(`Your working model of Eren (plugin ${PLUGIN}): not written yet. Write it with ${NOTE_TOOL} before any write.`)
    }
    return { text: [section.text ?? '', lines.join('\n')].filter(Boolean).join('\n\n') }
  })

  // What Eren sees above the prompt: the full note, its last change, the last
  // check, and the history on request. Nothing is clipped.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hidden = await read($, isHidden)
    if (hidden || e.props.hasSurvey) return next(e)
    const current = await read($, note)
    const past = await read($, history)
    const list = await read($, checks)
    const open = await read($, showHistory)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    const previous = past[past.length - 1]
    const last = list[list.length - 1]
    const notAsked = last ? /^not asked/i.test(last.asked) : false

    const buttons = (
      <Box>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        <Text> </Text>
        {past.length ? (
          <Button key="history" label={open ? 'Hide history' : `History (${past.length})`} onPress={() => update($, showHistory, v => !v)} />
        ) : null}
        {past.length ? <Text> </Text> : null}
        <Button key="remind" label="Remind" onPress={() => update($, remind, () => true)} />
        <Text dimColor>  Wrong? Tell Claude.</Text>
      </Box>
    )

    if (!current) {
      return (
        <Box flexDirection="column">
          <Text color="warning" wrap="wrap">Claude has not written down what you want yet. No write runs until it does.</Text>
          {buttons}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>Claude's model of you</Text>
          <Text dimColor>{`  v${current.version} · ${ago(now, current.at)}`}</Text>
        </Box>
        <Text wrap="wrap">
          <Text bold>You want: </Text>
          {current.want}
        </Text>
        <Text wrap="wrap">
          <Text bold>You know / are missing: </Text>
          {current.inHisHead}
        </Text>
        {previous ? (
          <Text dimColor wrap="wrap">{`Changed from v${previous.version}: ${describeChanges(diffNotes(previous, current))}`}</Text>
        ) : null}
        {last ? (
          <Text wrap="wrap">
            <Text color={notAsked ? 'warning' : 'subtle'}>{notAsked ? 'NOT ASKED · ' : `Check ${list.length} · `}</Text>
            <Text dimColor>{`you said ${last.asked} → targets: ${last.targets.join(', ')} → `}</Text>
            <Text>{last.sentence}</Text>
          </Text>
        ) : null}
        {open
          ? past
              .slice()
              .reverse()
              .map(n => (
                <Text key={`v${n.version}`} dimColor wrap="wrap">{`v${n.version} (${ago(now, n.at)}): ${n.want} — ${n.inHisHead}`}</Text>
              ))
          : null}
        {buttons}
      </Box>
    )
  })
}
