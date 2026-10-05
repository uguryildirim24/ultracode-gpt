# ultracode-gpt

GPT mode for ultracode. With it on, Workflow `agent()` calls run as
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) sessions on
GPT (`openai-codex/gpt-6.1-sol` on your ChatGPT login) instead of Claude
subagents. The orchestration stays Claude: the workflow script, `pipeline`,
`parallel`, phases and the main loop. Only the agents become GPT, and Claude
spends nothing on their loops.

It's a Claude Code mod (a plugin of function hooks). It works in the terminal
and in the Claude desktop app's Code tab, and doesn't depend on herdr-ade.

## Marking GPT agents

Give an agent the GPT agent type:

```js
export const meta = { name: 'research', description: 'GPT does the legwork' }
const notes = await agent('Find the current Node LTS version and its end-of-life date.',
  { agentType: 'ultracode-gpt:gpt' })
const verdict = await agent('Summarize these notes: ' + notes,
  { agentType: 'ultracode-gpt:gpt',
    schema: { type: 'object', properties: { version: { type: 'string' }, eol: { type: 'string' } },
              required: ['version', 'eol'] } })
const review = await agent('Check the summary for mistakes: ' + JSON.stringify(verdict)) // Claude
return { notes, verdict, review }
```

- `agentType: 'ultracode-gpt:gpt'` runs that agent on GPT. Unmarked agents stay
  on Claude, so one script can mix the two.
- `schema` works: the GPT agent is given a `structured_output` tool built from
  the schema, and its answer reaches the script as the agent's
  `StructuredOutput` call. If the workflow's own schema check rejects it, the
  agent gets up to two more tries with the error.
- The agent works in the workflow agent's directory, reads `AGENTS.md` /
  `CLAUDE.md` there, and is told its final message is its return value.

## Modes

| Mode | What runs on GPT |
|---|---|
| `marked` (default) | agents with `agentType: 'ultracode-gpt:gpt'` |
| `all` | every Workflow agent |
| `off` | none; `ultracode-gpt:gpt` agents run on Claude (inherit model) |

Switch with `/gpt-mode marked|all|off`. `/gpt-mode` alone shows the mode, the
model, the web tools, and whether pi's openai-codex login is ready. The same
settings are rows in `/config`:

| Row | Default | |
|---|---|---|
| GPT mode | `marked` | `marked`, `all`, `off` |
| GPT model | `gpt-6.1-sol` | a pi model id on openai-codex, or `provider/id` |
| GPT thinking level | `medium` | `off` … `max` |
| GPT web search | on | OpenAI's hosted web search |
| GPT web fetch | on | a `web_fetch` tool: HTTP GET, page as text |
| pi command | `pi` | the pi executable |

They're stored in `~/.claude/settings.json` under `pluginConfigs`, keyed by
the plugin (`ultracode-gpt@inline` for a `--plugin-dir` load).

## What a GPT agent has

| Claude workflow agent | GPT agent (pi) |
|---|---|
| Read, Write, Edit, Bash, Glob/Grep | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` |
| WebSearch | OpenAI hosted `web_search` (no API key, uses the ChatGPT login) |
| WebFetch | `web_fetch` (this mod's pi extension) |
| StructuredOutput for `schema` | `structured_output` built from the schema |
| CLAUDE.md | pi reads `AGENTS.md` / `CLAUDE.md` from the working directory |
| The session's permission mode | **none**: pi's `bash` runs without approval |
| MCP servers | not passed through |

## Install

The mod is the `plugin/` folder. The repo root is a plugin marketplace that
points at it.

### Claude desktop app (Code tab)

The desktop app has no `--plugin-dir`. Install it from this folder as a local
marketplace:

```sh
claude plugin marketplace add ~/projects/ultracode-gpt
claude plugin install ultracode-gpt@ultracode-gpt
```

Then start a new Code session in the desktop app. A folder marketplace is read
from the folder itself, so after pulling or editing, `/reload-plugins` in a
session picks up the change with no reinstall. To scope it to one project, run
both commands from that project with `--scope local`. To remove it:
`claude plugin uninstall ultracode-gpt@ultracode-gpt` and
`claude plugin marketplace remove ultracode-gpt`.

### Terminal

Same install as above, or for one session only:

```sh
claude --plugin-dir ~/projects/ultracode-gpt/plugin
```

## The pi dependency

GPT mode shells out to `pi` on `PATH` (set `pi command` to change it). It needs
pi signed in to the `openai-codex` provider (ChatGPT subscription), which
`/gpt-mode` checks.

On Rolf's Mac, `~/.local/bin/pi` is the herdr-ade pi wrapper
(`~/.herdr-ade/pi/bin/pi`, pinned pi 0.99.1). It points pi at the harness's
agent dir, where the openai-codex login lives, and it refuses
`pi install/update/remove/config`. So "outside the harness" here means no
dependency on `ha`, herdr panes or harness state, but the same pi binary and
login. GPT mode runs pi with `--no-extensions`, which drops the harness's guard
and state extensions (a provider error can't report into an ADE lane), and
loads only its own extensions from `plugin/pi/` with `-e`. With a plain pi
install, the same applies: `pi` on `PATH`, signed in with
`pi auth` to openai-codex.

## How it works

Workflow agents never fire `agent.spawn`, and their conversations can't be
read through `$.session.messages`. What a mod does see:

1. `tool.call` on `Workflow`: the mod rewrites the script (inline or read from
   `scriptPath`). Right after `export const meta`, it shadows `agent` in a
   block, so a GPT agent's prompt gets a leading
   `<<ultracode-gpt>>{"schema":…}<</ultracode-gpt>>` line. In `marked` mode,
   a script that never names `ultracode-gpt:gpt` is left as written, so its
   resume cache is untouched.
2. `session.append`: every row a workflow agent is given arrives here with its
   `agentId`: the relayed user request, the computed task (with the mark), and
   the environment row (its working directory).
3. `turn.step`: when a marked agent's loop makes its first model request, the
   hook answers it alone. It runs `pi -p --mode json` in the agent's directory,
   then yields pi's final text (stop `end_turn`), or a `StructuredOutput` tool
   call for a schema agent. The request never reaches Claude.

The registered agent type `ultracode-gpt:gpt` exists so Workflow accepts the
name. Its `model` is the GPT model's id (`gpt-6.1-sol`, or whatever `GPT model`
is set to), so the agent shows as GPT. That name is a label the hook keys on:
Claude Code doesn't route it to GPT, and the Anthropic API can't serve it. When
an agent on that model reaches `turn.step` without a mark (the hook missed
it), the hook answers `GPT MODE MISS` itself, so a miss is visible and never
reaches the API. In `off` mode the type registers with `inherit` and runs on
Claude.

## Limits

- Named workflows (`Workflow({ name })`) and nested `workflow()` children
  aren't rewritten, so their agents stay on Claude.
- GPT agents don't stream progress into `/workflows`; the status line shows
  how many are running on pi. Token use isn't reported back to Claude Code.
- The harness rows it reads (`[Workflow harness — computed task]` and the
  environment row) are the engine's wording, not an API. A Claude Code update
  that rewords them would stop the mod from finding its mark; agents would then
  answer `GPT MODE MISS`.
- `bash` in a GPT agent is ungated. Use GPT mode where a Claude agent in
  bypass-permissions mode would be fine.

## Development

```sh
claude plugin validate plugin
claude plugin test plugin
```

`notes/probes.md` has the probe results the design rests on (engine 2.1.286
desktop, 2.1.289 CLI).
