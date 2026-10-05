import type { Register } from 'claude-code'
import { AGENT_TYPE, PI_TOOL, PiRun, gptModelId, mirrorInput, piPlan, piPrompt, readHarnessRow, readMark, readSettings, rewriteScript, rowText } from './lib.ts'
import type { Marked, Settings } from './lib.ts'

// One pi run behind a GPT agent. It outlives the step that started it: each
// later step, and each mirrored tool call, reads it on by pulling the child
// itself. A pull is a `$` call, which a hook's budget doesn't count; awaiting
// a promise another hook resolves would count, and drop the hook at 10 s.
type Live = {
  run: PiRun
  child: any
  closed: boolean
  steps: number
  chars: number
  mirroring: boolean
  calls: Map<string, string>
  served: Set<string>
  last: string[]
}

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
  structuredId?: string
  rejected?: string
  live?: Live
}

const agents = new Map<string, Agent>()
let running = 0

const MISS_TEXT = 'GPT MODE MISS: the ultracode-gpt hook did not answer this agent.'
const MISS_PROMPT =
  'You stand in for a GPT agent of ultracode GPT mode, whose hook did not take this run. ' +
  `Do no work. Reply with exactly: ${MISS_TEXT}`
const PI_TOOL_DESCRIPTION =
  'Internal to ultracode GPT mode: records one step of a GPT agent running on pi, so its transcript shows ' +
  'what pi is doing. Never call it: it refuses every call but those GPT mode makes itself.'
const PI_TOOL_REFUSAL = 'The pi tool only records the steps of a GPT mode agent; it takes no other calls.'
// A GPT agent's steps mirrored into its transcript at most: past either, the
// agent waits for pi's answer as it did before steps were mirrored.
const MAX_MIRRORED_STEPS = 100
const MAX_MIRRORED_CHARS = 150_000
const OFF_PROMPT =
  'You are an agent of a Claude Code workflow script. Complete the task you are given with your tools; ' +
  'your final message is returned to the script as your result.'

async function registerType($: any, s: Settings) {
  await $.agent.register(
    s.mode === 'off'
      ? { name: 'gpt', description: 'GPT mode is off: runs this workflow agent on Claude.', prompt: OFF_PROMPT, model: 'inherit' }
      : {
          name: 'gpt',
          description: 'Runs this workflow agent on GPT through pi (ultracode GPT mode). Workflow scripts only.',
          prompt: MISS_PROMPT,
          model: gptModelId(s),
          // Room for every mirrored step of up to three pi runs (a schema agent's retries).
          maxTurns: 4 * (MAX_MIRRORED_STEPS + 1),
        },
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

/** Starts pi for one agent; the steps that follow read it on. */
function startPi($: any, s: Settings, a: Agent, feedback?: string): Live {
  const plan = piPlan(s, `${$.plugin.root}/pi`, piPrompt(a.mark!.prompt, a.relay, feedback), a.mark!.schema)
  const live: Live = { run: new PiRun(), child: undefined, closed: false, steps: 0, chars: 0, mirroring: true, calls: new Map(), served: new Set(), last: [] }
  running++
  showRunning($)
  try {
    live.child = $.process.spawn({ argv: plan.argv, cwd: a.cwd, env: plan.env })
  } catch (err) {
    finish($, s, live, undefined, err)
  }
  return live
}

/** pi is over: reads what it came to, once. */
function finish($: any, s: Settings, live: Live, ended?: { code: number | null; signal: string | null }, failed?: unknown) {
  if (live.closed) return
  live.closed = true
  const run = live.run
  run.end()
  if (failed !== undefined) run.error = `pi could not run (${s.pi}): ${String(failed)}`
  else if (ended && ended.code !== 0 && !run.answer && !run.hasStructured) {
    run.error = run.error ?? `pi exited ${ended.code ?? ended.signal}: ${run.stderr.trim().slice(0, 600)}`
  }
  running--
  showRunning($)
}

/** Stops pi: its agent was stopped, or ended without waiting for it. */
function kill($: any, s: Settings, live: Live) {
  if (live.closed) return
  try {
    Promise.resolve(live.child?.return(undefined)).catch(() => {})
  } catch {}
  live.run.error = live.run.error ?? 'the GPT agent was stopped'
  finish($, s, live)
}

/**
 * Reads pi on until `ready()` holds or pi is over. False when `signal`
 * aborted first, and pi is stopped: the agent it ran for was.
 */
async function waitFor($: any, s: Settings, live: Live, ready: () => boolean, signal: AbortSignal): Promise<boolean> {
  const stop = new Promise<'stop'>(resolve => {
    if (signal.aborted) resolve('stop')
    else signal.addEventListener('abort', () => resolve('stop'), { once: true })
  })
  while (!ready() && !live.closed) {
    let piece: any
    try {
      const pull = live.child.next()
      pull.catch(() => {})
      piece = await Promise.race([pull, stop])
    } catch (err) {
      finish($, s, live, undefined, err)
      break
    }
    if (piece === 'stop') {
      kill($, s, live)
      return false
    }
    if (piece.done) finish($, s, live, piece.value)
    else if (piece.value.stream === 'stdout') live.run.feed(piece.value.text)
    else if (live.run.stderr.length < 4000) live.run.stderr += piece.value.text
  }
  return !signal.aborted
}

export const register: Register = (on, options) => {
  const s = readSettings(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await registerType($, s)
    if (s.mode !== 'off') {
      try {
        await $.tool.register({
          name: 'pi',
          description: PI_TOOL_DESCRIPTION,
          inputSchema: { type: 'object', properties: { call: { type: 'string' }, args: {} }, required: ['call'] },
        })
      } catch (err) {
        $.ui.log(`GPT mode: the pi tool did not register (${String(err)}); GPT agents won't show pi's steps.`, { to: 'debug' })
      }
    }
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
        // The workflow's verdict on the StructuredOutput call; mirrored pi steps' results pass by.
        const a = agents.get(id)
        if (a?.mark?.schema && a.answered && a.structuredId) {
          const blocks = Array.isArray(e.message.content) ? e.message.content : []
          const verdict = blocks.find((b: any) => b?.type === 'tool_result' && b.tool_use_id === a.structuredId)
          if (verdict) a.rejected = verdict.is_error ? JSON.stringify(verdict.content).slice(0, 2000) : undefined
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
    const done = (answer: string, toolUses: { name: string; input: unknown }[], stopReason: 'end_turn' | 'tool_use') => ({
      turnId: e.turnId,
      index: e.index,
      answer,
      toolUses,
      stopReason,
      usage: null,
    })
    const a = e.agentId ? agents.get(e.agentId) : undefined
    if (!a?.mark) {
      // The GPT type names the GPT model, which Claude can't serve: an agent on
      // it that carries no mark is a miss, answered here, never sent to the API.
      if (!e.agentId || s.mode === 'off' || e.model.toLowerCase() !== gptModelId(s).toLowerCase()) return yield* next(e)
      $.ui.toast(MISS_TEXT)
      yield { kind: 'text', index: 0, text: MISS_TEXT }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return done(MISS_TEXT, [], 'end_turn')
    }
    const schema = a.mark.schema

    if (!a.live) {
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
      a.live = startPi($, s, a, feedback)
    }
    const live = a.live

    // Calls of the last step the engine never handed to the pi tool: it isn't
    // in this agent's reach. Stop mirroring; the agent waits for pi's answer.
    if (live.mirroring && live.last.some(id => !live.served.has(id))) {
      live.mirroring = false
      $.ui.toast("GPT mode: an agent's pi steps can't be shown here; it answers when pi ends.")
    }
    live.last = []
    const mirrors = () => live.mirroring && live.steps < MAX_MIRRORED_STEPS && live.chars < MAX_MIRRORED_CHARS
    const ready = () => {
      if (!mirrors()) live.run.turns.length = 0
      return live.run.turns.length > 0
    }
    if (!(await waitFor($, s, live, ready, next.signal))) return done('', [], 'end_turn')

    // pi called tools: that turn is this step, its calls answered by the pi tool.
    const turn = live.run.turns.shift()
    if (turn) {
      live.steps++
      live.chars += turn.text.length
      const toolUses: { name: string; input: unknown }[] = []
      let block = 0
      if (turn.text) yield { kind: 'text', index: block++, text: turn.text }
      for (const [i, call] of turn.calls.entries()) {
        const id = `toolu_ucgpt_${e.agentId}_${e.index}_${i}`
        const input = mirrorInput(call)
        const json = JSON.stringify(input)
        live.calls.set(id, call.id)
        live.last.push(id)
        live.chars += json.length
        yield { kind: 'tool', index: block, id, name: PI_TOOL }
        yield { kind: 'input', index: block, json }
        block++
        toolUses.push({ name: PI_TOOL, input })
      }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return done(turn.text, toolUses, 'tool_use')
    }

    // pi ended: its answer is this step's.
    a.live = undefined
    a.answered = true
    a.rejected = undefined
    const run = live.run

    if (schema && run.hasStructured) {
      a.structured = run.structured
      const id = `toolu_ucgpt_${e.agentId}_${e.index}`
      a.structuredId = id
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

  // The pi tool: a GPT agent's mirrored call, answered with what pi's tool
  // returned, once it has. Calls from anywhere else are refused.
  on('tool.call', { tool: 'mcp__ultracode-gpt__pi' }, async ($, e, next) => {
    const live = e.agentId ? agents.get(e.agentId)?.live : undefined
    const piId = live?.calls.get(e.tool_use_id)
    if (!live || !piId) return { deny: PI_TOOL_REFUSAL }
    live.served.add(e.tool_use_id)
    await waitFor($, s, live, () => live.run.results.has(piId), next.signal)
    const r = live.run.results.get(piId)
    const text = r ? (r.isError ? `Error: ${r.text}` : r.text || '(no output)') : 'pi ended before this tool finished.'
    live.chars += text.length
    return { result: text }
  })

  // Keep the pi tool's schema in the list, so a mirrored call is never one
  // the agent would first have to load through ToolSearch.
  on('tool.describe', { tool: 'mcp__ultracode-gpt__pi' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const live = agents.get(e.agentId)?.live
      if (live) kill($, s, live)
      agents.delete(e.agentId)
    }
    return next(e)
  })
}
