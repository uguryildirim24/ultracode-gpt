# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-10-21

### Fixed

- The Workflow, `session.append` and `pi` tool hooks now carry a `.catch`,
  so `claude plugin validate` no longer flags them. A failed Workflow rewrite
  runs the script as written, a failed `session.append` hook still appends the
  row, and a failed `pi` tool hook refuses the call. Each failure goes to the
  debug log.

### Added

- A test that makes the Workflow rewrite throw and checks the script runs
  unchanged.
- Homepage, repository, license and keywords in both manifests; `$schema`,
  category and tags in the marketplace.
- This changelog.

### Changed

- Rewrote the README as a plugin README.
- Trimmed `.gitignore` to what this repo produces.

### Removed

- `docs/validation.md`. What the tests cover is now in the README.

## [0.1.1] - 2026-10-05

### Added

- A GPT agent's pi tool calls are mirrored into its transcript as calls to
  the plugin's `pi` tool, answered with pi's results. Mirroring is capped at
  100 steps or 150,000 characters per pi run.
- pi is stopped when its agent ends.
- MIT license (2026-10-08).

### Changed

- The GPT agent type carries the configured GPT model id. An unmarked agent
  on that id answers `GPT MODE MISS` instead of reaching the Anthropic API.
- README notes that an updated install needs a new session.
- Removed private development notes and added ignore rules for local files
  (2026-10-08).

## [0.1.0] - 2026-10-04

### Added

- GPT mode for Workflow agents: hooks rewrite GPT-marked `agent()` calls,
  read each agent's task and working directory, and answer its steps from a
  pi run, as text or as a `StructuredOutput` call for schema agents.
- In marked mode, only scripts that name the GPT agent type are rewritten.
- pi extensions for hosted web search, `web_fetch` and `structured_output`.
- `/gpt-mode` command and the six settings in `/config`.
- pi's stderr in the errors GPT agents report.
- Mocked tests, a local marketplace entry and a README.

[0.1.2]: https://github.com/uguryildirim24/ultracode-gpt/compare/a7bc6ed...main
[0.1.1]: https://github.com/uguryildirim24/ultracode-gpt/compare/5d5935b...a7bc6ed
[0.1.0]: https://github.com/uguryildirim24/ultracode-gpt/tree/5d5935b
