# mental-model

A Claude Code mod. It keeps Claude's working model of Eren, in his own words, where he can see it and correct it, and it asks for a check before each write.

## What it does

- `mcp__mental-model__note(want, in_his_head)`: Claude's reading of what Eren wants and what is in his head. Rewritten when the reading changes, not per message. The result tells the model what changed since the previous note; an unchanged note is reported as unchanged. The note keeps a history of 12 versions.
- `mcp__mental-model__check(targets, asked, amount, sentence)`: required before a write. It names the targets it covers, quotes Eren's words that ask for the write (or says "not asked"), says whether the work is too much or not enough, and writes the one sentence that tells him the result. A new message from Eren clears the checks.
- The gate: a write in the main loop (file edit, mutating shell command, memory or task change, send) runs only when a check covers its target. Subagents are exempt. Stderr redirects (`2>&1`, `2>/dev/null`) count as reads, and an inline python or node script counts as a write only when its text writes, deletes, moves or spawns.
- The band above the prompt: the whole note with its version and age, the last change, the last check (quoted words, the first three targets, sentence, a NOT ASKED flag), and buttons Hide (h), History (s), Remind (r). Hide collapses the band to one line with a Show (m) button. History lists the previous notes. Remind sends Claude a prompt to rewrite the note at once and reads "Reminded ✓" until the note is rewritten. Nothing is clipped.
- The system prompt carries the current note and its last change in the `env_info_simple` section, so the model sees its own drift all session.
- The status line shows the note version and the number of checks this message.
- A reminder to write the note rides beside Eren's prompt only while no note exists yet.

## Files

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             names the module
hooks/register.tsx           the module
hooks/register.test.ts       claude plugin test, including two tests that mount the band and press its buttons
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
