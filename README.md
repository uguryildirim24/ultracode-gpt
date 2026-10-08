# ultracode-gpt

A Claude Code plugin that runs selected Workflow agents on GPT through pi while Claude coordinates the workflow.

## Why it exists

Claude Code's ultracode mode plans work as JavaScript workflows. The `Workflow`
tool executes those scripts, and `agent()` launches their workers. This plugin
lets one script mix GPT workers and Claude reviewers without changing the
orchestration. It is a model-routing experiment, not a benchmark of model quality.

The implementation rewrites workflow scripts, launches pi, mirrors tool results
into Claude's agent transcripts, and returns text or schema-shaped answers.
Existing tests cover that routing with mocked pi execution. Historical notes
record live text and structured-output runs. Hosted web search remains
unverified. See `docs/validation.md` for dates, versions, and open checks.

**GPT agents do not inherit Claude Code's permission checks or Bash sandbox.
Their shell commands and file edits run without approval.** Use an isolated
environment with only the files, credentials, and network access needed for the
task. Do not use this plugin with sensitive research or personal records.

## Requirements

- A Claude Code host that exposes `Workflow` and function hooks (mods), including
  `tool.call`, `session.append`, and `turn.step`. Ordinary shell hooks are not
  enough. CLI mods are enabled by default from Claude Code 2.1.287. This repo's
  validation and tests were checked on 2.1.292, not on every newer release.
- Dynamic workflows enabled in Claude Code's `/config`, and an approved Claude
  account or API setup for orchestration and unmarked agents.
- Node.js and npm. The current local check used Node.js 24.19.0.
- `@earendil-works/pi-coding-agent` on `PATH`. The setup below installs 0.99.1,
  the version used in the historical live observations and local checks.
  Other pi versions have not been checked here.
- An approved ChatGPT subscription login for pi's `openai-codex` provider.
  Model access depends on the account. This repo does not supply credentials.

No dataset, model weights, or project dependency installation is required.
Claude Code loads the TypeScript hooks and provides `claude-code/testing`.
Pi supplies the dependencies for the extensions in `plugin/pi/`.

## Run from a clean clone

Start in the root of a clean clone of this repository. Install Claude Code
through its official installation instructions if `claude` is not available.
Then run these shell commands:

```sh
claude --version
node --version
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.99.1
pi --version
claude plugin validate plugin
claude plugin test plugin
```

The npm command needs a writable global npm prefix. Ensure its `bin` directory
is on `PATH`. The expected pi version is `0.99.1`. No repo build step is needed.
The validation commands do not require a paid model session.

Authenticate pi interactively:

```sh
pi --no-session --no-extensions
```

Inside pi, enter `/login`, choose the OpenAI Codex (`openai-codex`) subscription
provider, and complete the browser flow. Use `/model` to see authenticated
models, then exit pi. Back in the shell:

```sh
pi auth check --provider openai-codex --json --no-refresh
pi --no-session --no-extensions --list-models openai-codex
claude --plugin-dir "$PWD/plugin"
```

An authentication check returns `not_ready` when no login is configured. Do not
paste tokens into scripts or use credential-printing commands for setup.

In the Claude session:

1. Run `/gpt-mode` to check plugin status and pi authentication.
2. Open `/config`. Set **GPT model** to an accessible model ID from pi's list.
   A bare ID uses `openai-codex`; `provider/id` is also accepted. The code's
   default, `gpt-6.1-sol`, is a historical setting, not a promise of availability.
3. Set **GPT thinking level** to a level the selected model supports. Set **pi
   command** to the executable's absolute path if it is not on Claude's `PATH`.
4. Turn **GPT web search** off for the first run. Its current integration is
   unverified. Turn **GPT web fetch** off when network fetching is unnecessary.
5. Ask Claude to run the script below through `Workflow`, using inline `script`
   or `scriptPath`, not a saved workflow name. Review the script before launch.

### Mixed text and structured output

This is a Workflow script, not a standalone Node.js program:

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

Marked agents use GPT. The unmarked review agent uses Claude. A schema agent
receives a `structured_output` tool. The hook returns its value as a Workflow
`StructuredOutput` call and permits up to two further pi runs if Workflow
rejects that value. Agents run in the workflow agent's working directory and
load pi's applicable `AGENTS.md` and `CLAUDE.md` instructions.

Use `/workflows` to inspect the run. Successful local validation does not prove
this live example works on a particular account or host.

### Optional local marketplace install

For a persistent installation, run from the clone root:

```sh
claude plugin marketplace add "$PWD"
claude plugin install ultracode-gpt@ultracode-gpt
```

For the directory-backed CLI installation checked on October 8, 2026 with
Claude Code 2.1.292,
`claude plugin update ultracode-gpt@ultracode-gpt` reported that the plugin is
read directly from its folder. Code edits take effect in the next session or
after `/reload-plugins`. A version bump is not needed for that reload.

Historical desktop observations used engine 2.1.286 and a cached plugin copy.
Those notes recommended bumping the version in
`plugin/.claude-plugin/plugin.json`, updating the local marketplace and plugin,
and starting a new local Code session:

```sh
claude plugin marketplace update ultracode-gpt
claude plugin update ultracode-gpt@ultracode-gpt
```

The desktop app must be able to launch the configured pi executable and use the
same pi configuration directory as the shell login. Desktop installation was
not repeated during this cleanup. Its historical cache instructions do not
describe the directory-backed CLI behavior above.

## Configuration

`/gpt-mode marked|all|off` selects routing. `/gpt-mode` alone shows status.
The same options appear in Claude Code's `/config`:

| Setting | Default | Meaning |
|---|---|---|
| GPT mode | `marked` | Only `ultracode-gpt:gpt` agents use pi |
| GPT model | `gpt-6.1-sol` | A pi model ID, or `provider/id` |
| GPT thinking level | `medium` | A pi thinking level supported by the model |
| GPT web search | on | Inject a hosted `web_search` request tool |
| GPT web fetch | on | Enable the HTTP `web_fetch` extension |
| pi command | `pi` | Executable to launch |

`all` marks every agent in scripts the hook rewrites. `off` leaves agents on
Claude, including the registered GPT agent type, which then inherits the Claude
model. Named workflows and nested workflow calls are not rewritten. In those
unsupported workflows, ordinary agents stay on Claude. With GPT mode enabled,
agents explicitly selecting `ultracode-gpt:gpt` return `GPT MODE MISS` when they
lack the routing marker. They do not fall back to Claude.

Claude stores plugin configuration under `pluginConfigs` in its settings.
Pi stores login credentials in its own `auth.json`, normally outside the clone
in `~/.pi/agent`. `PI_CODING_AGENT_DIR` can select another private configuration
directory. Use the same value for login and the process launching Claude.
`UCGPT_SCHEMA` is set by the plugin for a structured run; it is not a credential
and requires no manual setup. The plugin does not load `.env` files.

## Project layout

```text
.claude-plugin/marketplace.json   Local marketplace pointing at plugin/
plugin/.claude-plugin/plugin.json   Plugin identity and configuration
plugin/hooks/hooks.json          Function-hook module registration
plugin/hooks/register.ts         Agent lifecycle, routing, and tool mirroring
plugin/hooks/lib.ts              Script rewriting and pi JSONL parsing
plugin/pi/                      Web search, web fetch, structured output
plugin/tests/gpt-mode.test.ts    Existing mocked routing and hook tests
docs/validation.md              Validation record and unresolved live checks
LICENSE                         MIT license
```

There are no scientific datasets or result figures in this repo. Workflows
supply their own inputs. Keep task data outside the clone or in the ignored
`data/` directory. Put generated outputs in ignored `results/` or `artifacts/`.
The web tools retrieve content at runtime; no fetched pages are bundled.

Pi runs with `--no-session --no-extensions` and only the plugin's explicit
extensions. This disables pi session persistence, not Claude transcripts or
other runtime logs. Mirrored prompts, tool arguments, and results can contain
private content. Do not publish those logs. Ignoring files does not prevent
agents from reading or transmitting them.

## Limits and known gaps

- Only scripts with a literal `export const meta = { ... }` can be rewritten.
  Named workflows and nested `workflow()` children are not rewritten. Ordinary
  agents stay on Claude. With GPT mode enabled, explicitly GPT-labelled agents
  without a routing marker return `GPT MODE MISS`, not a Claude answer.
- The parser is a text scanner, not a complete JavaScript parser. Complex script
  syntax may not be rewritten correctly.
- The hook reads Workflow task and environment rows by their wording. A host
  update can break detection. `GPT MODE MISS` is the intended visible response
  when a GPT-labelled agent reaches the hook without a marker.
- GPT `bash`, `write`, and `edit` are ungated. Claude permissions and its Bash
  sandbox are not a security boundary for the spawned pi process. Pi's working
  directory does not confine file access. MCP servers are not passed through.
- Hosted web search only injects `{ type: 'web_search' }` into compatible request
  payloads. Backend acceptance and a model saying it searched do not establish
  retrieved sources or factual correctness. Other providers are unverified.
  `/gpt-mode` always checks `openai-codex` authentication and prefixes its model
  display with that provider, even when a different `provider/id` is selected.
- `web_fetch` follows redirects and does not block loopback or private-network
  URLs. It can reach internal services. It buffers the complete response before
  reducing HTML and truncating output (40,000 characters by default). That limit
  is not a download or memory cap. Requests have a 30-second timeout.
- GPT token usage is not returned to Claude (`usage` is null). Missing counts
  are not free execution. Claude orchestration still uses its plan or API, and
  GPT work uses the selected provider's subscription limits or API billing.
- Pi thinking is not mirrored. A long think can leave the transcript quiet.
  Mirroring stops after 100 steps or 150,000 characters per pi run. Tool-result
  text is clipped to 2,000 characters. Pi can continue after mirroring stops.
- Tests mock pi execution. Current live text output, structured output, hosted
  web search, cancellation during a pending step, and desktop setup still need
  approved-account checks. There are no model-quality or cost benchmarks.

## Development and validation

```sh
claude plugin validate plugin
claude plugin test plugin
```

On October 8, 2026 (local date), Claude Code 2.1.292 validated the unchanged
plugin code and all 24 existing tests passed. Pi was installed independently at
0.99.1 and its version command worked. Local marketplace installation and
update commands also passed. Authentication was intentionally absent in that
isolated configuration, so model listing returned no models. Interactive login,
Claude sessions, live workflows, and desktop setup were skipped. No paid model
call was made. See `docs/validation.md`.

## How this was built

AI coding agents did much of the implementation under Rolf's direction. Rolf
set the public-release requirements, including portable setup, private
credentials, and no agent commits. Earlier development notes record hook and
live-agent checks, but do not identify which checks Rolf personally ran or
establish a line-by-line review. Coding agents reran the existing validation and
mocked tests for this cleanup. Rolf's final diff review and new live checks are
still pending.

## License

MIT. See `LICENSE`. Dependencies retain their own licenses. No paper or preprint
is included or cited by the repository.
