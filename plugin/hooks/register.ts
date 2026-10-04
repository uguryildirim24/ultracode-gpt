import type { Register } from 'claude-code'
import { AGENT_TYPE, PiRun, piPlan, piPrompt, readHarnessRow, readMark, readSettings, rewriteScript, rowText } from './lib.ts'
import type { Marked, Settings } from './lib.ts'

// One workflow agent as GPT mode follows it, keyed by its agentId. Filled from
// the rows the agent is given (session.append), answered at its turn.step.
type Agent = {
  relay?: string
  cwd?: string
  mark?: Marked
  answered: boolean
  attempts: number
  answer?: string
  structured?: unknown
  rejected?: string
}

const agents = new Map<string, Agent>()
let running = 0

const MISS_PROMPT =
  'You stand in for a GPT agent of ultracode GPT mode, whose hook did not take this run. ' +
  'Do no work. Reply with exactly: GPT MODE MISS: the ultracode-gpt hook did not answer this agent.'
const OFF_PROMPT =
  'You are an agent of a Claude Code workflow script. Complete the task you are given with your tools; ' +
  'your final message is returned to the script as your result.'

async function registerType($: any, s: Settings) {
  await $.agent.register(
    s.mode === 'off'
      ? { name: 'gpt', description: 'GPT mode is off: runs this workflow agent on Claude.', prompt: OFF_PROMPT, model: 'inherit' }
      : { name: 'gpt', description: 'Runs this workflow agent on GPT through pi (ultracode GPT mode). Workflow scripts only.', prompt: MISS_PROMPT, model: 'haiku' },
  )
}

function agentOf(id: string): Agent {
  let a = agents.get(id)
  if (!a) agents.set(id, (a = { answered: false, attempts: 0 }))
  return a
}

function showRunning($: any) {
  $.ui.status(running > 0 ? `GPT mode: ${running} agent${running === 1 ? '' : 's'} on pi` : undefined)
}

/** Runs pi for one agent, to the end, and reads what it came to. */
async function runPi($: any, s: Settings, a: Agent, feedback?: string): Promise<PiRun> {
  const run = new PiRun()
  const plan = piPlan(s, `${$.plugin.root}/pi`, piPrompt(a.mark!.prompt, a.relay, feedback), a.mark!.schema)
  running++
  showRunning($)
  try {
    const child = $.process.spawn({ argv: plan.argv, cwd: a.cwd, env: plan.env })
    let ended: { code: number | null; signal: string | null } | undefined
    while (true) {
      const piece = await child.next()
      if (piece.done) {
        ended = piece.value
        break
      }
      if (piece.value.stream === 'stdout') run.feed(piece.value.text)
      else if (run.stderr.length < 4000) run.stderr += piece.value.text
    }
    run.end()
    if (ended && ended.code !== 0 && !run.answer && !run.hasStructured) {
      run.error = run.error ?? `pi exited ${ended.code ?? ended.signal}: ${run.stderr.trim().slice(0, 600)}`
    }
  } catch (err) {
    run.error = `pi could not run (${s.pi}): ${String(err)}`
  } finally {
    running--
    showRunning($)
  }
  return run
}

export const register: Register = (on, options) => {
  const s = readSettings(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await registerType($, s)
    await $.command.register({
      name: 'gpt-mode',
      description: 'GPT mode for Workflow agents: show status, or set marked | all | off.',
      argumentHint: '[marked|all|off]',
    })
    return started
  })

  on('command.run', { command: 'gpt-mode' }, async ($, e) => {
    const want = e.args.trim().toLowerCase()
    if (want === 'marked' || want === 'all' || want === 'off') {
      const { deny } = await $.config.set({ key: 'ultracode-gpt.mode', value: want })
      return { text: deny ? `GPT mode not changed: ${deny}` : `GPT mode: ${want}.` }
    }
    let auth = 'unknown'
    try {
      const r = await $.process.run([s.pi, 'auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh'], { timeoutMs: 20000 })
      auth = r.exitCode === 0 ? (JSON.parse(r.stdout).status ?? r.stdout.trim()) : `not ready (${(r.stderr || r.stdout).trim().slice(0, 200)})`
    } catch (err) {
      auth = `pi not runnable: ${String(err)}`
    }
    const which =
      s.mode === 'all' ? 'every Workflow agent runs on GPT'
      : s.mode === 'off' ? 'off: every Workflow agent runs on Claude'
      : `Workflow agents with agentType '${AGENT_TYPE}' run on GPT`
    return {
      text: [
        `GPT mode: ${s.mode} (${which}).`,
        `Model: openai-codex/${s.model}, thinking ${s.thinking}. Web search ${s.webSearch ? 'on' : 'off'}, web fetch ${s.webFetch ? 'on' : 'off'}.`,
        `pi (${s.pi}) openai-codex login: ${auth}.`,
        `Change with /gpt-mode marked|all|off, or the ultracode-gpt rows in /config.`,
      ].join('\n'),
    }
  })

  // Marks GPT agent() calls inside the script before the Workflow tool runs it.
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    if (s.mode === 'off' || e.agentId) return next(e)
    let script = e.script
    if (e.scriptPath) {
      try {
        script = await $.fs.read(e.scriptPath)
      } catch {
        return next(e)
      }
    } else if (!script && e.name) {
      $.ui.toast(`GPT mode: named workflow '${e.name}' is run as is; its agents stay on Claude.`)
      return next(e)
    }
    const rewritten = script ? rewriteScript(script, s.mode) : null
    if (!rewritten) return next(e)
    return next({ ...e, script: rewritten, scriptPath: undefined })
  })

  // A workflow agent's rows: the relayed request, its task (with the GPT mark), its cwd.
  on('session.append', async ($, e, next) => {
    const id = e.agentId
    if (id && (e.door === 'prompt' || e.door === 'attachment' || e.door === 'tool-result')) {
      const text = rowText(e.message)
      if (e.door === 'tool-result') {
        const a = agents.get(id)
        if (a?.mark?.schema && a.answered) {
          const blocks = Array.isArray(e.message.content) ? e.message.content : []
          const failed = blocks.find((b: any) => b?.type === 'tool_result' && b.is_error)
          a.rejected = failed ? JSON.stringify(failed.content).slice(0, 2000) : undefined
        }
      } else {
        const row = readHarnessRow(text)
        if (row?.kind === 'relay') agentOf(id).relay = row.text
        if (row?.kind === 'cwd') agentOf(id).cwd = row.path
        if (row?.kind === 'task') {
          const mark = readMark(row.text)
          if (mark) agentOf(id).mark = mark
        }
      }
    }
    return next(e)
  })

  // A GPT agent's model request: answered here, from pi, never sent to Claude.
  on('turn.step', async function* ($, e, next) {
    const a = e.agentId ? agents.get(e.agentId) : undefined
    if (!a?.mark) return yield* next(e)
    const schema = a.mark.schema
    const done = (answer: string, toolUses: { name: string; input: unknown }[], stopReason: 'end_turn' | 'tool_use') => ({
      turnId: e.turnId,
      index: e.index,
      answer,
      toolUses,
      stopReason,
      usage: null,
    })

    // A later step: the structured answer was taken, or rejected and worth one more try.
    if (a.answered && !(schema && a.rejected && a.attempts < 3)) {
      const text = schema ? 'Structured output delivered.' : a.answer ?? ''
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return done(text, [], 'end_turn')
    }

    const feedback = a.rejected
      ? `Your previous structured_output was rejected by the workflow's schema check: ${a.rejected}\n` +
        `Previous value: ${JSON.stringify(a.structured)}\nCall structured_output again with a corrected value.`
      : undefined
    a.attempts++
    const run = await runPi($, s, a, feedback)
    a.answered = true
    a.rejected = undefined

    if (schema && run.hasStructured) {
      a.structured = run.structured
      const id = `toolu_ucgpt_${e.agentId}_${e.index}`
      const input = run.structured ?? {}
      yield { kind: 'tool', index: 0, id, name: 'StructuredOutput' }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return done('', [{ name: 'StructuredOutput', input }], 'tool_use')
    }

    const text = run.error
      ? `GPT MODE ERROR: ${run.error}`
      : schema
        ? `GPT MODE ERROR: the GPT agent ended without calling structured_output. Its last text: ${run.answer.slice(0, 2000)}` +
          (run.stderr.trim() ? `\npi stderr: ${run.stderr.trim().slice(-600)}` : '')
        : run.answer || 'GPT MODE ERROR: the GPT agent ended with no answer.'
    if (run.error || (schema && !run.hasStructured)) $.ui.toast(text.slice(0, 200))
    a.answer = text
    yield { kind: 'text', index: 0, text }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return done(text, [], 'end_turn')
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) agents.delete(e.agentId)
    return next(e)
  })
}
