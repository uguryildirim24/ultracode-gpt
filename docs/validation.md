# Validation record

These are observations for specific versions, not a compatibility guarantee.
The October 4 and 5 entries summarize the original development notes without
local workstation paths or authentication details. Raw session logs are not
included, so those live observations have not been independently reproduced.

## Historical hook checks: October 4 and 5, 2026

Environment: CLI engine 2.1.289, desktop app 2.19675.0 with engine 2.1.286,
and pi 0.99.1.

- A local marketplace plugin loaded in a new desktop Code session. Agent
  registration and launching pi's version command worked.
- Workflow agents triggered `turn.step` and `session.append` with `agentId`.
  `agent.spawn` did not fire. Reading those agents through
  `session.messages` was denied. `prompt.compose` applied to the main session,
  not Workflow agents. This motivated the task-row marker design.
- A hook supplying a complete `TurnStepResult` and a `StructuredOutput` call
  satisfied a Workflow schema. An incomplete hook result was skipped by the
  host, which then ran the underlying model request.
- Workflow accepted a registered agent type. Its prompt and model applied;
  `initialPrompt` did not. A later live observation showed the configured GPT
  ID as the agent's model label. That label is not host-native GPT routing.
- A plain promise waiting 12 seconds exceeded the hook's 10-second budget.
  Pulling a process stream spawned by an earlier hook survived that interval.
  The implementation therefore pulls the stream from each later hook instead
  of awaiting a background pump's promise.
- The development notes reported that a running desktop session kept its
  installed plugin copy through reload attempts. This is not a claim about
  reload behavior in later releases.

## Historical live agents: October 5, 2026

Environment: desktop engine 2.1.286, plugin 0.1.1, pi 0.99.1, configured model
`openai-codex/gpt-6.1-sol`.

A Workflow ran one text agent and one schema agent. The notes reported that
pi's tool calls appeared as transcript rows with their results. The text agent
read hook files and returned a module path. The schema agent counted files and
returned an accepted `{ count: 6 }` value. These were observations about that
checkout and session, not a general benchmark or an expected file count now.

The notes also reported that the provider accepted a request with a hosted
`web_search` tool and the model said it searched. They explicitly left a
dated-fact check unresolved. This does not establish that search results were
retrieved, cited correctly, or used in the answer. A text-mode piped probe hung;
a JSON-mode probe completed. The plugin uses JSON mode.

## Public-tree check: October 7, 2026 (local date)

Environment: Claude Code 2.1.292, Node.js 24.19.0, npm 11.17.0.

From the worktree root:

```sh
claude plugin validate plugin
claude plugin test plugin
```

The manifest validation succeeded and all 24 existing tests passed. The tests
mock process execution and pi's JSONL stream. They cover script rewriting,
marker parsing, model arguments, text and structured answers, tool mirroring,
refusal of unrelated mirror calls, and process cleanup. The existing miss test
also confirms that an unmarked agent on the GPT model returns `GPT MODE MISS`
without executing Claude or pi. They do not execute GPT.

The earlier pass reran both commands after correcting routing documentation
and changing the named-workflow toast. Validation passed and all 24 existing
tests passed again. The October 8 scope review reverted that toast change to
keep plugin code identical to HEAD. The documentation correction remains.
No fallback or tests were added.

An independent npm installation of pi 0.99.1 with lifecycle scripts disabled
completed in an isolated review directory. `pi --version` returned `0.99.1`.
`pi auth check --provider openai-codex --json --no-refresh` returned `not_ready`
with `credentials_not_configured`, as expected without a login. No subscription
login, paid model run, or desktop installation was attempted. Runtime home,
configuration, npm cache, and temporary files were kept outside the worktree.

Gitleaks scanned the current worktree with full redaction and reported no
leaks. A separate filename and line-level scan found no credential-shaped
values, ChatGPT login or session files, listed sensitive personal records, or
private workstation paths in the publication files. Author attribution was
retained. Runtime ignore rules were checked without creating sample files;
source files remained visible to git. `git diff --check` passed.

A clean-snapshot reviewer also checked the directory-backed local installation
on CLI 2.1.292. The plugin update command reported that the plugin is read
directly from its folder, with edits taking effect at the next session or
`/reload-plugins`. This differs from the historical desktop cache observation.

Git history is outside the scope of this check. A clean tree does not establish
a clean history or prevent future agent runs from exposing private inputs.

## Scope review: October 8, 2026 (local date)

Environment: Claude Code 2.1.292, Node.js 24.19.0, npm 11.17.0.

All plugin source, manifests, extensions, and tests match HEAD. From the
worktree root, with home, configuration, cache, and temporary directories
isolated under the review directory:

- `claude --version` returned 2.1.292 and `node --version` returned v24.19.0.
- `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.99.1`
  succeeded with an isolated npm prefix. `pi --version` returned 0.99.1.
- `claude plugin validate plugin` passed. `claude plugin test plugin` passed
  all 24 existing mocked tests.
- `pi auth check --provider openai-codex --json --no-refresh` returned
  `not_ready` with `credentials_not_configured`. Model listing reported no
  models without login.
- The README's local marketplace add, plugin install, marketplace update,
  and plugin update commands succeeded. The update command reported that the
  plugin is read from its folder and edits take effect in the next session or
  after `/reload-plugins`. This checks the CLI, not the desktop app.

Interactive login, Claude sessions, live workflows, and desktop setup were
skipped because they need approved accounts or an interactive host. No paid
model call, GPU job, or multi-GB download was attempted. No build output was
created in the worktree. No new tests or plugin behavior changes were retained.

Gitleaks scanned the current tree with full redaction and found no leaks. A
separate filename and line-level scan found no credential-shaped values,
listed sensitive personal details, private workstation paths, or login and
session files. `git diff --check` passed. These checks do not audit git history
or prove that every possible private detail is absent.

## Checks still needed

Rolf should review the diff and run these with approved accounts in an isolated
environment before making an end-to-end support claim:

1. A marked text agent that reads a known file and returns its contents.
2. A marked schema agent whose accepted object matches the source file.
3. Hosted web search for a dated fact, with retrieved sources checked directly.
4. Stopping an agent while a process-stream pull is pending. The historical
   test kit could not exercise that stop path. The existing mocked cleanup test
   is narrower.
5. A pi turn with text before its tool calls, checking both the transcript and
   the value returned to the workflow script.
6. Desktop installation, pi executable discovery, authentication, and plugin
   updates on the intended desktop version.

Review repository history separately before publication. Do not include
credentials, account details, private prompts, or raw session logs in a public
validation report.
