import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, Check, Note } from '../types'

// mental-model: Claude's working model of Eren, in his words, kept where he
// can see it and correct it, plus a check before each write. The note's
// evolution is visible to the agent in the tool result and the system
// prompt, and to Eren in the band.

const PLUGIN = 'mental-model'
const NOTE_TOOL = `mcp__${PLUGIN}__note`
const CHECK_TOOL = `mcp__${PLUGIN}__check`
const HISTORY_CAP = 12

const note = atom({ plugin: 'mental-model', key: 'note' } as const, null)
const history = atom({ plugin: 'mental-model', key: 'history' } as const, [])
const checks = atom({ plugin: 'mental-model', key: 'checks' } as const, [])
const isHidden = atom({ plugin: 'mental-model', key: 'isHidden' } as const, false)
const showHistory = atom({ plugin: 'mental-model', key: 'showHistory' } as const, false)
const remind = atom({ plugin: 'mental-model', key: 'remind' } as const, false)

export const REMINDER =
  `Write or update your working model of Eren with ${NOTE_TOOL}: ` +
  'what he wants, in his words, and what is in his head. He reads it above the prompt.'

// What the Remind button sends to Claude, as a prompt, the moment it is pressed.
export const REMIND_PROMPT =
  `Eren pressed Remind. Rewrite your working model of him now with ${NOTE_TOOL}, ` +
  'from everything he has said in this conversation: what he wants, in his words, and what is in his head. ' +
  'Then answer in one sentence what changed.'

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

const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase()

// What a check's target is matched against: the file for a file tool, the
// command for a shell, the tool name for everything else.
export function targetOf(tool: string, args: Record<string, unknown>): string {
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.notebook_path === 'string') return args.notebook_path
  if (tool === 'Bash' || tool === 'PowerShell') return String(args.command ?? '')
  return tool
}

// An inline script (python -c, a heredoc, node -e) is a write only when its
// text writes, deletes, moves or spawns. A script run by file path stays a write.
const INLINE_SCRIPT = /(^|[;&|]\s*)(python3?|py|node|bun)\b[^;&|<]*?(\s-[ce]\s|\s-\s*<<|\s-\s*$|<<)/i
const SCRIPT_MUTATION =
  /open\((?:[^)]*,\s*(?:mode\s*=\s*)?)?['"][rb]*[wax+]['"]|\.write\(|write_text|write_bytes|writeFile|appendFile|unlink|\.remove\(|removedirs|rmtree|rmSync|rename|replace\(\s*['"][^'"]*['"]\s*\)\s*$|mkdir|makedirs|shutil\.|os\.system|subprocess|child_process|execSync|spawn\(|truncate|chmod|copyfile|copy2|move\(/

export function isWrite(tool: string, args: Record<string, unknown>): boolean {
  if (tool === NOTE_TOOL || tool === CHECK_TOOL) return false
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

// The first few targets of a check, for the band.
export function fewTargets(targets: readonly string[], max = 3): string {
  const shown = targets.slice(0, max).join(', ')
  return targets.length > max ? `${shown} +${targets.length - max} more` : shown
}

export function isCovered(target: string, list: readonly Check[]): boolean {
  const t = norm(target)
  return list.some(c => c.targets.some(x => x.trim() && t.includes(norm(x.trim()))))
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
        'One check covers the listed targets until Eren sends his next message. ' +
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
    const entry: Check = { targets, asked, amount, sentence, at: await $.clock.now() }
    const list = await update($, checks, l => [...l, entry])
    const warning = /^not asked/i.test(asked)
      ? ' Eren did not ask for this write. Do it only if his request cannot be done without it, and tell him.'
      : ''
    await $.ui.status(`${list.length} check${list.length === 1 ? '' : 's'} this message`)
    return { result: `Check ${list.length} recorded for: ${targets.join(', ')}.${warning}` }
  })

  // The gate: a write in the main loop needs a check that covers its target.
  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const inMainLoop = (e as { agentId?: string }).agentId === undefined
    if (!inMainLoop || !isWrite(e.tool, args)) return next(e)
    const target = targetOf(e.tool, args)
    if (isCovered(target, await read($, checks))) return next(e)
    return {
      deny:
        `${PLUGIN}: no check covers this write (${target.length > 100 ? target.slice(0, 99) + '…' : target}). ` +
        `Call ${CHECK_TOOL}: quote Eren's words that ask for it, say whether it is too much or not enough, ` +
        'and write the one sentence that tells him the result. Then retry.',
    }
  })

  // A new message from Eren is a new request: earlier checks stop covering writes.
  on('turn.start', async ($, e, next) => {
    if (e.text.trim()) await update($, checks, () => [])
    return next(e)
  })

  // The reminder rides beside his prompt while no note exists yet.
  on('prompt.submit', async ($, e, next) => {
    const fromEren = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!fromEren) return next(e)
    if ((await read($, note)) !== null) return next(e)
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
      lines.push(`Your working model of Eren (plugin ${PLUGIN}): not written yet. Write it with ${NOTE_TOOL}.`)
    }
    return { text: [section.text ?? '', lines.join('\n')].filter(Boolean).join('\n\n') }
  })

  // What Eren sees above the prompt: the full note, its last change, the last
  // check, and the history on request. Nothing is clipped.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const hidden = await read($, isHidden)
    if (hidden) {
      const { Box, Button, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text dimColor>Claude's model of you is hidden. </Text>
          <Button key="show" label="Show" hotkey="m" onPress={() => update($, isHidden, () => false)} />
        </Box>
      )
    }
    const current = await read($, note)
    const past = await read($, history)
    const list = await read($, checks)
    const open = await read($, showHistory)
    const reminded = await read($, remind)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    const previous = past[past.length - 1]
    const last = list[list.length - 1]
    const notAsked = last ? /^not asked/i.test(last.asked) : false

    const buttons = (
      <Box>
        <Button key="hide" label="Hide" hotkey="h" onPress={() => update($, isHidden, () => true)} />
        <Text> </Text>
        {past.length ? (
          <Button
            key="history"
            label={open ? 'Hide history' : `History (${past.length})`}
            variant={open ? 'primary' : undefined}
            hotkey="s"
            onPress={() => update($, showHistory, v => !v)}
          />
        ) : null}
        {past.length ? <Text> </Text> : null}
        <Button
          key="remind"
          label={reminded ? 'Reminded ✓' : 'Remind'}
          variant={reminded ? 'primary' : undefined}
          hotkey="r"
          onPress={async () => {
            if (await read($, remind)) return
            await update($, remind, () => true)
            void $.prompt.submit({ text: REMIND_PROMPT })
          }}
        />
        <Text dimColor>{reminded ? '  Sent. Claude is rewriting the note.' : '  Wrong? Tell Claude.'}</Text>
      </Box>
    )

    if (!current) {
      return (
        <Box flexDirection="column">
          <Text wrap="wrap">Claude has not written down what you want yet.</Text>
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
            <Text dimColor>{`you said ${last.asked} → ${fewTargets(last.targets)} → `}</Text>
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
