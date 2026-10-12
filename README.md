# mental-model

A Claude Code mod: the agent's working model of the user, in the user's words, shown above the prompt, and a nudge to rewrite it before a string of writes.

- `mcp__mental-model__note(want, in_their_head)`: the user's intent, and what the user knows and is missing. Rewritten when the agent's understanding changes. The result says what changed since the previous note. Twelve versions are kept.
- The nudge: the first write of a turn whose note predates the user's last message carries a line for the model: rewrite the note if the understanding changed. The write runs. One nudge per turn; a note call in the turn clears it. Subagents are exempt.
- The band: a header row with the title, the version, which field changed last, the age, and three glyph buttons: − Hide (h), ≡ History (s), ↻ Remind (r); the word appears under the pointer. Below it, labeled rows: Want and Knows. History opens under the rows, newest first, so the buttons stay at the top. Hide collapses the band to one line with + Show (m). Remind shows ✓ until the note is rewritten.
- The reminder rides beside the user's prompt while no note exists, and after Remind until the note is rewritten.
- The system prompt carries the note and its last change.

Files: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `hooks/register.test.ts`, `types/index.d.ts`, `tsconfig.json`.

Load: `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, or `claude --plugin-dir <folder>`.

Check: `claude plugin validate .` and `claude plugin test .`
