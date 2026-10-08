# mental-model

A Claude Code mod: the agent's working model of the user, in the user's words, shown above the prompt, and a check before each write.

- `mcp__mental-model__note(want, in_his_head)`: the user's intent, and what the user knows and is missing. Rewritten when the agent's understanding changes. The result says what changed since the previous note. Twelve versions are kept.
- `mcp__mental-model__check(targets, asked, amount, sentence)`: required before a write. The targets, the user's quoted words or "not asked", too much or not enough, and the one sentence that tells the user the result. A new message from the user clears the checks.
- The gate: a write in the main loop runs only when a check covers its target. Subagents are exempt. Stderr redirects and inline scripts that only read count as reads.
- The band: the whole note with version and age, the last change, the last check, and the buttons Hide (h), History (s), Remind (r). Hide collapses the band to one line with Show (m). Remind reads "Reminded ✓" until the note is rewritten.
- The reminder rides beside the user's prompt while no note exists, and after Remind until the note is rewritten.
- The system prompt carries the note and its last change.

Files: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `hooks/register.test.ts`, `types/index.d.ts`, `tsconfig.json`.

Load: `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, or `claude --plugin-dir <folder>`.

Check: `claude plugin validate .` and `claude plugin test .`
