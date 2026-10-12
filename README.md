# mental-model

A Claude Code mod that makes Claude write down what it thinks you want, and shows that note above your prompt.

When an agent misreads a request, you usually find out after it has done the work. This mod moves that moment to the start. Claude keeps a short note with two fields: what you want, in your own words, and what you know and what you are missing. The note sits above the prompt box, so a wrong reading is on screen before the first file changes. You correct it the ordinary way, by telling Claude.

Nothing in the mod blocks a tool call.

## The note

Claude writes the note with one tool:

```
mcp__mental-model__note(want, in_their_head)
```

Claude rewrites it when its understanding changes, not on every message. The tool result tells Claude which field changed and what it said before, so the model sees its own drift. The last twelve versions are kept as history.

The note and its last change also go into Claude's system prompt for the rest of the session.

The note and its history are saved on disk under the session's id. When you restart Claude Code or resume the session, the note comes back. A new session, or a `/clear`, starts with no note. The mod keeps the 50 most recent sessions.

## What Claude is told, and when

The mod adds a line for the model at three moments. Each one asks Claude to write or update the note. None of them blocks anything, and subagents never get them.

| | Attached to | Fires when | Starts with |
|---|---|---|---|
| Reminder | your message | no note exists | nothing on your first message, `IMPORTANT: ` from your second message on |
| Update reminder | your message | you pressed U (Update on next prompt), until Claude rewrites the note | nothing |
| Nudge | the result of Claude's first write after your message | Claude writes something before it rewrites the note | `THIS IS VERY IMPORTANT: ` when no note exists, nothing when a note exists |

Both reminders carry the same text:

```
Write down/update your understanding of user's intent, knowledge and gaps using the `mcp__mental-model__note` tool. This will help you tailor your effort to user's needs, and help the user to catch drift early on.
```

The nudge tells Claude its note is older than your last message, or that it has no note yet. The write it rides on has already run. A write is any tool call that Claude Code did not find read-only by the tool's own check. Creating, editing and deleting files all count, and reading or searching never does. Only the first write after each message carries the nudge, and a note written before that write means no nudge at all.

## The band

The band is the panel above the prompt.

```
−  Claude's model of you  v3 · changed: intent · 2 min ago                    ≡  U  ×  ∅
Want        merge the branch and prepare the repo for release
────────────────────────────────────────────────────────────
Knows       knows the tests pass, has not picked a license yet
```

The header row shows the title, the note's version, which field changed last and how long ago. A thin line separates the Want row from the Knows row. The − Hide button sits at the top left. The other buttons sit on the right. Each button shows its name under the pointer:

| Button | Key | Does |
|---|---|---|
| − Hide | h | folds the band into one line with a + Show button (m) |
| ≡ History | s | opens the older versions under the note, newest first |
| U Update on next prompt | u | turns on the Update reminder, and shows ✓ until Claude rewrites the note |
| × Remove | d | deletes the current note and moves it into the history, so Claude starts a new one |
| ∅ Remove all | a | deletes the note and the whole history |

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
