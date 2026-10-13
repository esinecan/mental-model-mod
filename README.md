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

The note and its last change also ride beside each of your messages, so Claude reads them where it reads your request. They never go into the system prompt. A system prompt that changes in the middle of a session misses the prompt cache for the whole conversation after it, and the note changes often.

× Remove deletes the current note. The versions before it stay, and Claude's next note follows the last one.

The note and its history are saved on disk under the session's id. When you restart Claude Code or resume the session, the note comes back. A new session, or a `/clear`, starts with no note. The mod keeps the 50 most recent sessions.

## What Claude is told, and when

The mod adds a line for the model at four moments. The note line shows Claude its current note. The other three ask Claude to write or update the note. None of them blocks anything, and subagents never get them.

| | Attached to | Fires when | Starts with |
|---|---|---|---|
| Note | your message | a note exists | `Your working model of the user (mental-model, note vN):`, then the note and its last change |
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
| × Remove | d | deletes the current note; the versions before it stay |
| ∅ Remove all | a | asks first: a row under the header names what goes, with Remove all (y) and Keep (n). Remove all deletes the note and its history in this session, with no undo |

The keys work while the band holds the keyboard: after ctrl+x tab, or after a click on the band. Typing in the prompt never presses them. An armed Remove all disarms when you press Keep, ∅ again or any other band button, when you send a message, or when Claude writes a new note.

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install mental-model --marketplace esinecan/mental-model-mod
```

Answer `y` to add the marketplace, then pick a scope. The user scope loads the mod in every session you start after, including sessions the desktop app runs on the same machine.

To run a local checkout instead, start Claude Code with `claude --plugin-dir <folder>`, or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. A running session keeps the version it loaded, and a change takes effect in the next session.

## Develop

`claude plugin validate .` checks the manifest and lists the hooks. `claude plugin test .` runs `hooks/register.test.ts`. The tests cover:

- the nudge: one per turn, only on a write, never after a fresh note
- the reminder and its `IMPORTANT: ` prefix, and Update on next prompt
- the note beside each message, and a system prompt that a note never changes
- the note after a rewrite, a Remove and a Remove all
- saving and loading per session
- the band on the terminal and desktop surfaces: each button, the Remove all confirmation, and each way it disarms

`claude plugin test` is in Claude Code 2.1.295. Claude Code 2.1.258 does not have it. Run `claude --version` to see which one you have.

`tsc -p .` type-checks the mod and the tests. Its `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes when it loads the mod from this folder.

The code is one hooks module, `hooks/register.tsx`, with its state types in `types/index.d.ts`.

## License

MIT. See [LICENSE](LICENSE).
