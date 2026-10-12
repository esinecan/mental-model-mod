# mental-model

A Claude Code mod that makes Claude write down what it thinks you want, and shows that note above your prompt.

When an agent misreads a request, you usually find out after it has done the work. This mod moves that moment to the start. Claude keeps a short note with two fields: what you want, in your own words, and what you know and what you are missing. The note sits above the prompt box, so a wrong reading is on screen before the first file changes. You correct it the ordinary way, by telling Claude.

Nothing in the mod blocks a tool call.

## The note

Claude writes the note with one tool:

```
mcp__mental-model__note(want, in_their_head)
```

Claude rewrites it when its understanding changes, not on every message. The tool result tells Claude which field changed and what it said before, so the model sees its own drift. The last twelve versions are kept.

The note and its last change also go into Claude's system prompt for the rest of the session.

## The nudge

After you send a message, the first write Claude makes carries one extra line for the model: if what you want or know has changed, rewrite the note. The write still runs. A write here is any tool call that Claude Code did not find read-only by the tool's own check, so reading files and searching never trigger it.

There is one nudge per message, and a note written before the first write means no nudge at all. Subagents never see it.

## The band

The band is the panel above the prompt.

```
Claude's model of you  v3 · changed: intent · 2 min ago     Wrong? Tell Claude.  −  ≡  ↻
Want        merge the branch and prepare the repo for release
Knows       knows the tests pass, has not picked a license yet
```

The header row shows the title, the note's version, which field changed last and how long ago. Three buttons sit on the right, and each shows its name under the pointer:

| Button | Key | Does |
|---|---|---|
| − Hide | h | folds the band into one line with a + Show button (m) |
| ≡ History | s | opens the older versions under the note, newest first |
| ↻ Remind | r | adds a reminder to your next message, and shows ✓ until Claude rewrites the note |

While no note exists, every prompt you send carries the same reminder.

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install mental-model --marketplace esinecan/mental-model-mod
```

Answer `y` to add the marketplace, then pick a scope. The user scope loads the mod in every session you start after, including sessions the desktop app runs on the same machine.

To run a local checkout instead, start Claude Code with `claude --plugin-dir <folder>`, or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. A running session keeps the version it loaded, and a change takes effect in the next session.

## Develop

`claude plugin validate .` checks the manifest. `claude plugin test .` runs `hooks/register.test.ts`, which mounts the band on the terminal and desktop surfaces and presses its buttons.

The code is one hooks module, `hooks/register.tsx`, with its state types in `types/index.d.ts`.

## License

MIT. See [LICENSE](LICENSE).
