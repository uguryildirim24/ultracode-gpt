# ultracode-gpt

Run Claude Code Workflow agents on GPT through the pi coding agent while Claude coordinates.

## What it does

Ultracode plans work as Workflow scripts, and each `agent()` call in a script
starts a Claude subagent. With this plugin, an `agent()` call marked with
`agentType: 'ultracode-gpt:gpt'` runs on GPT through
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) instead.
Unmarked agents stay on Claude, so one script can mix GPT workers and Claude
reviewers:

```js
export const meta = { name: 'mixed-model-demo', description: 'Read and review the plugin layout' }
const notes = await agent('Read plugin/hooks/hooks.json and report the module it loads.',
  { agentType: 'ultracode-gpt:gpt' })
const verdict = await agent('Return the module path described in these notes: ' + notes,
  { agentType: 'ultracode-gpt:gpt',
    schema: { type: 'object', properties: { module: { type: 'string' } },
              required: ['module'], additionalProperties: false } })
const review = await agent('Check this summary against plugin/hooks/hooks.json: ' + JSON.stringify(verdict))
return { notes, verdict, review }
```

The first two agents run on GPT. The second returns a schema-checked object,
like any Workflow agent with a `schema`. The third is a normal Claude agent.
GPT agents show their pi tool calls and results in `/workflows`, the same way
Claude agents do.

## Requirements

- Claude Code with the Workflow tool and function hooks (2.1.287 or later).
- Node.js, for pi.
- pi, `@earendil-works/pi-coding-agent`. Tested with 0.99.1.
- A ChatGPT login for pi's `openai-codex` provider.

## Install

In Claude Code:

```
/plugin marketplace add uguryildirim24/ultracode-gpt
/plugin install ultracode-gpt@ultracode-gpt
```

Or from a shell:

```sh
claude plugin marketplace add uguryildirim24/ultracode-gpt
claude plugin install ultracode-gpt@ultracode-gpt
```

To try it without installing, run Claude Code from a clone with the plugin
folder loaded for that session:

```sh
git clone https://github.com/uguryildirim24/ultracode-gpt
cd ultracode-gpt
claude --plugin-dir ./plugin
```

After installing or updating the plugin, start a new session.

## Set up pi login

```sh
npm install -g @earendil-works/pi-coding-agent@0.99.1
pi
```

In pi, run `/login`, pick OpenAI Codex, and finish the browser sign-in. Then
check it from the shell:

```sh
pi auth check --provider openai-codex
```

In Claude Code, `/gpt-mode` shows the same login status.

## Usage

- `/gpt-mode` shows the current mode, model, web tools and pi login.
- `/gpt-mode marked` runs only agents with `agentType: 'ultracode-gpt:gpt'` on GPT. This is the default.
- `/gpt-mode all` runs every agent of a Workflow script on GPT.
- `/gpt-mode off` runs every agent on Claude, including ones marked for GPT.

Then ask Claude to run a Workflow script like the demo above, passed inline or
by `scriptPath`.

## Configuration

| Setting | Key | Default | Meaning |
|---|---|---|---|
| GPT mode | `mode` | `marked` | `marked`, `all` or `off`, as `/gpt-mode` sets it |
| GPT model | `model` | `gpt-6.1-sol` | pi model id on `openai-codex`, or `provider/id` |
| GPT thinking level | `thinking` | `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| GPT web search | `webSearch` | on | Give GPT agents OpenAI's hosted web search |
| GPT web fetch | `webFetch` | on | Give GPT agents a `web_fetch` tool (HTTP GET, page as text) |
| pi command | `piPath` | `pi` | The pi executable to run; use a full path if `pi` isn't on Claude's `PATH` |

Change them in `/config`. Set GPT model to any id from
`pi --list-models openai-codex`.

## How it works

- A `tool.call` hook on Workflow rewrites the script before it runs: GPT
  `agent()` calls get a marker line at the head of their prompt.
- The plugin registers the `ultracode-gpt:gpt` agent type. Its `turn.step`
  hook reads the marker from the agent's task and runs `pi -p --mode json` in
  the agent's working directory, so the request never goes to Claude.
- Each pi turn that calls tools is mirrored into the agent's transcript as a
  call to the plugin's `pi` tool, answered with pi's own tool result.
- pi's final message is the agent's result.
- A schema agent gets a `structured_output` tool in pi. Its value comes back
  as a `StructuredOutput` call. If the Workflow rejects it, pi runs again with
  the error, up to two retries.

A GPT agent that reaches the hook without the marker answers `GPT MODE MISS`
instead of falling back to Claude.

## Safety

GPT agents run pi with `bash`, `write` and `edit`. They do not inherit Claude
Code's permission checks or its Bash sandbox, so their commands and edits run
without asking. Run workflows in a directory you don't mind them editing.
`web_fetch` follows redirects and does not block loopback or private-network
URLs, so it can reach services on your local network.

## Limits

- Only scripts with a literal `export const meta = { ... }`, passed inline or
  by `scriptPath`, are rewritten. Named workflows are not, and neither is a
  Workflow call made by an agent.
- The rewrite is a text scan, not a JavaScript parser.
- GPT token usage isn't reported back to Claude.
- Mirroring stops after 100 steps or 150,000 characters per pi run. Tool
  results and step text are clipped to 2,000 characters. pi keeps working
  past the cap, and the agent still gets its answer.
- Hosted web search is injected into pi's requests, but nothing checks that
  the model actually retrieved sources.

## Development

```sh
claude plugin validate .
claude plugin validate plugin
claude plugin test plugin
```

Checked with Claude Code 2.1.304 and pi 0.99.1. None of these need a login.

The 25 tests mock pi's process and its JSONL output, so no model runs. They
cover the script rewrite, reading the marker and the Workflow harness rows,
pi's arguments, parsing pi's output, text and structured answers, the
StructuredOutput retry, step mirroring, refusing `pi` tool calls the plugin
didn't make, stopping pi when its agent ends, the `GPT MODE MISS` answer, and
a failed rewrite running the script unchanged.

```text
.claude-plugin/marketplace.json   Marketplace entry pointing at plugin/
plugin/.claude-plugin/plugin.json Plugin manifest and settings
plugin/hooks/hooks.json           Loads register.ts
plugin/hooks/register.ts          Hooks: Workflow rewrite, agent steps, pi tool, /gpt-mode
plugin/hooks/lib.ts               Script rewrite, harness rows, pi argv, pi JSONL parsing
plugin/pi/                        pi extensions: web search, web fetch, structured output
plugin/tests/gpt-mode.test.ts     Mocked tests
```

## License

MIT. See [LICENSE](LICENSE).

Built with Claude Code.
