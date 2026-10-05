// Pure pieces of GPT mode: the Workflow script rewrite, reading the harness
// rows a workflow agent is given, pi's argv, and pi's JSONL output.

export const AGENT_TYPE = 'ultracode-gpt:gpt'
export const MARK_OPEN = '<<ultracode-gpt>>'
export const MARK_CLOSE = '<</ultracode-gpt>>'
const SHIM_TAG = '/*ultracode-gpt:shim*/'

export type Mode = 'marked' | 'all' | 'off'

export type Settings = {
  mode: Mode
  model: string
  thinking: string
  webSearch: boolean
  webFetch: boolean
  pi: string
}

export function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const mode = options.mode === 'all' || options.mode === 'off' ? options.mode : 'marked'
  const text = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d)
  return {
    mode,
    model: text(options.model, 'gpt-6.1-sol'),
    thinking: text(options.thinking, 'medium'),
    webSearch: options.webSearch !== false,
    webFetch: options.webFetch !== false,
    pi: text(options.piPath, 'pi'),
  }
}

/** The GPT model's id without its provider: the name the agent type carries. */
export function gptModelId(s: Settings): string {
  return s.model.slice(s.model.lastIndexOf('/') + 1)
}

// ---- the Workflow script rewrite ------------------------------------------

/**
 * Where `export const meta = { ... }` ends (after an optional `;`), or -1.
 * Scans the literal's braces past strings, template literals and comments.
 */
export function metaEnd(script: string): number {
  const head = /export\s+const\s+meta\s*=\s*/.exec(script)
  if (!head) return -1
  let i = head.index + head[0].length
  if (script[i] !== '{') return -1
  let depth = 0
  for (; i < script.length; i++) {
    const c = script[i]
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      for (i++; i < script.length && script[i] !== quote; i++) if (script[i] === '\\') i++
      continue
    }
    if (c === '/' && script[i + 1] === '/') {
      while (i < script.length && script[i] !== '\n') i++
      continue
    }
    if (c === '/' && script[i + 1] === '*') {
      const close = script.indexOf('*/', i + 2)
      i = close < 0 ? script.length : close + 1
      continue
    }
    if (c === '{') depth++
    if (c === '}' && --depth === 0) {
      let j = i + 1
      while (j < script.length && (script[j] === ' ' || script[j] === '\t')) j++
      return script[j] === ';' ? j + 1 : i + 1
    }
  }
  return -1
}

/**
 * The script with every GPT agent() call marked: the prompt gets a leading
 * `<<ultracode-gpt>>{"schema":...}<</ultracode-gpt>>` line, which the agent's
 * task row carries and the turn.step hook reads. `agent` is shadowed in a
 * block around the body, so the script's own text is untouched.
 *
 * Returns null when there is nothing to do: mode off, already rewritten, a
 * marked-mode script that never names the GPT type, or no `export const meta`
 * literal to place the shim after. Untouched scripts keep their resume cache.
 */
export function rewriteScript(script: string, mode: Mode): string | null {
  if (mode === 'off' || script.includes(SHIM_TAG)) return null
  if (mode === 'marked' && !script.includes(AGENT_TYPE)) return null
  const end = metaEnd(script)
  if (end < 0) return null
  const all = mode === 'all'
  const shim =
    `\n${SHIM_TAG}const __ucgptAgent = agent;\n{\nconst agent = (prompt, opts) => {\n` +
    `  const gpt = ${all} || (opts != null && opts.agentType === ${JSON.stringify(AGENT_TYPE)});\n` +
    `  if (!gpt || typeof prompt !== 'string') return __ucgptAgent(prompt, opts);\n` +
    `  const head = JSON.stringify({ schema: (opts && opts.schema) || null });\n` +
    `  return __ucgptAgent(${JSON.stringify(MARK_OPEN)} + head + ${JSON.stringify(MARK_CLOSE)} + '\\n' + prompt, opts);\n` +
    `};\n`
  return script.slice(0, end) + shim + script.slice(end) + '\n}\n'
}

// ---- the rows a workflow agent is given -----------------------------------

const TASK_HEAD = '[Workflow harness — computed task]'
const TASK_LEAD = 'The computed task text follows:\n'
const RELAY_HEAD = '[Workflow harness — user request]'
const RELAY_LEAD = 'this request wins:\n'

function indented(text: string, lead: string): string {
  const at = text.indexOf(lead)
  const body = at < 0 ? text.slice(text.indexOf('\n') + 1) : text.slice(at + lead.length)
  return body
    .split('\n')
    .map(line => (line.startsWith('  ') ? line.slice(2) : line))
    .join('\n')
}

/** The text blocks of an appended row, joined. */
export function rowText(message: { content?: unknown }): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('\n')
}

export type HarnessRow =
  | { kind: 'task'; text: string }
  | { kind: 'relay'; text: string }
  | { kind: 'cwd'; path: string }

/** What one row a workflow agent is given says, when it is one GPT mode reads. */
export function readHarnessRow(text: string): HarnessRow | null {
  if (text.startsWith(TASK_HEAD)) return { kind: 'task', text: indented(text, TASK_LEAD) }
  if (text.startsWith(RELAY_HEAD)) return { kind: 'relay', text: indented(text, RELAY_LEAD) }
  const cwd = /^ - Primary working directory: (.+)$/m.exec(text)
  if (cwd && text.includes('# Environment')) return { kind: 'cwd', path: (cwd[1] ?? '').trim() }
  return null
}

export type Marked = { schema: Record<string, unknown> | null; prompt: string }

/** The GPT mark at the head of a task, and the task without it; null if unmarked. */
export function readMark(task: string): Marked | null {
  const open = task.indexOf(MARK_OPEN)
  if (open < 0) return null
  const close = task.indexOf(MARK_CLOSE, open)
  if (close < 0) return null
  let schema: Record<string, unknown> | null = null
  try {
    const head = JSON.parse(task.slice(open + MARK_OPEN.length, close))
    if (head && typeof head.schema === 'object') schema = head.schema
  } catch {
    return null
  }
  const prompt = (task.slice(0, open) + task.slice(close + MARK_CLOSE.length)).replace(/^\n/, '')
  return { schema, prompt }
}

// ---- running pi ------------------------------------------------------------

export const FRAMING =
  'You are one agent of a Claude Code workflow script, running on GPT through pi (ultracode GPT mode). ' +
  'Nobody can answer questions: work autonomously in the current directory with your tools. ' +
  'Your final message is returned verbatim to the orchestrating script as this agent\'s result, so make it ' +
  'the complete answer the task asks for, not a summary of what you did, and with no preamble.'

export const SCHEMA_FRAMING =
  'This task requires structured output: give your result by calling the structured_output tool exactly once, ' +
  'as your last action, with arguments that match its schema.'

export function piPrompt(task: string, relay: string | undefined, feedback?: string): string {
  const parts: string[] = []
  if (relay && relay.trim()) {
    parts.push('Context: the request that started this workflow (for intent only; do the task below, not this):\n' + relay.trim())
  }
  parts.push('Task:\n' + task.trim())
  if (feedback) parts.push(feedback)
  return parts.join('\n\n')
}

export type PiPlan = { argv: string[]; env: Record<string, string> }

/** pi's argv for one agent. `extensionDir` holds the mod's pi extensions. */
export function piPlan(s: Settings, extensionDir: string, prompt: string, schema: Record<string, unknown> | null): PiPlan {
  const tools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
  const argv = [s.pi, '-p', '--mode', 'json', '--no-session', '--no-extensions']
  if (s.webSearch) argv.push('-e', `${extensionDir}/web-search.ts`)
  if (s.webFetch) {
    argv.push('-e', `${extensionDir}/web-fetch.ts`)
    tools.push('web_fetch')
  }
  const env: Record<string, string> = {}
  if (schema) {
    argv.push('-e', `${extensionDir}/structured-output.ts`)
    tools.push('structured_output')
    env.UCGPT_SCHEMA = JSON.stringify(schema)
  }
  const model = s.model.includes('/') ? s.model : `openai-codex/${s.model}`
  argv.push('--tools', tools.join(','))
  argv.push('--model', s.thinking ? `${model}:${s.thinking}` : model)
  argv.push('--append-system-prompt', schema ? `${FRAMING}\n\n${SCHEMA_FRAMING}` : FRAMING)
  argv.push('--', prompt)
  return { argv, env }
}

/** What a pi run came to, read off its JSONL as it streams. */
export class PiRun {
  answer = ''
  structured: unknown = undefined
  hasStructured = false
  error: string | undefined
  stderr = ''
  toolCalls = 0
  private buffer = ''

  feed(text: string): void {
    this.buffer += text
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '')
      this.buffer = this.buffer.slice(nl + 1)
      if (line.trim()) this.record(line)
    }
  }

  end(): void {
    if (this.buffer.trim()) this.record(this.buffer)
    this.buffer = ''
  }

  private record(line: string): void {
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event?.type === 'tool_execution_end') {
      this.toolCalls++
      if (event.toolName === 'structured_output' && !event.isError) {
        this.structured = event.result?.details?.value
        this.hasStructured = true
      }
    }
    if (event?.type === 'message_end' && event.message?.role === 'assistant') {
      const m = event.message
      if (m.stopReason === 'error' || m.stopReason === 'aborted') {
        this.error = String(m.errorMessage || m.stopReason)
        return
      }
      const text = Array.isArray(m.content)
        ? m.content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('')
        : ''
      if (text.trim()) {
        this.answer = text
        this.error = undefined
      }
    }
  }
}
