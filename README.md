# mental-model

A Claude Code mod. It keeps Claude's working model of Eren, in his own words, where he can see it and correct it, and it gates every write on a check that quotes his words.

## What it does

- `mcp__mental-model__note(want, in_his_head)`: Claude's reading of what Eren wants and what is in his head. Rewritten when the reading changes. The result tells the model what changed since the previous note. The note keeps a history of 12 versions.
- `mcp__mental-model__check(targets, asked, amount, sentence)`: required before a write. It is refused while no note exists. It names the targets it covers, quotes Eren's words that ask for the write (or says "not asked"), says whether the work is too much or not enough, and writes the one sentence that tells him the result. A new message from Eren clears the checks.
- The gate: a write in the main loop (file edit, mutating shell command, memory or task change, send) runs only when a note exists and a check covers its target. A command that deletes something runs only when the check's quoted words name what it deletes, so a guess at a target is refused. Subagents are exempt. Temp folders are exempt from the naming rule.
- The band above the prompt: the full note with its version and age, the last change, the last check (quoted words, targets, sentence, a NOT ASKED flag), and buttons Hide, History, Remind. Nothing is clipped.
- The system prompt carries the current note and its last change in the `env_info_simple` section.
- The status line shows the note version and the number of checks this message.
- A reminder to write the note rides beside Eren's prompt only when the note is missing, when six messages have passed since the last note, or when he pressed Remind.

## Files

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             names the module
hooks/register.tsx           the module
hooks/register.test.ts       claude plugin test
types/index.d.ts             the state contract
tsconfig.json                extends the engine's, laid under .claude-plugin/types once loaded
```

## Load

Every session loads it through `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, pointing at this folder. One session: `claude --plugin-dir <this folder>`.

## Check

```
claude plugin validate .
claude plugin test .
```

## History

- 2026-10-07: first build.
- 2026-10-08: a write slipped through with no note written and a target Eren's words never named. Rebuilt: note required before any check, deletes must be named in his words, note history with a diff, unclipped band, reminder only when needed.
