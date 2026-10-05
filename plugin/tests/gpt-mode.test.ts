import { describe, expect, test } from 'claude-code/testing'
import { metaEnd, piPlan, readHarnessRow, readMark, readSettings, rewriteScript, PiRun } from '../hooks/lib.ts'

const SCRIPT = `export const meta = { name: 'demo', description: 'braces } in "strings" {', phases: [{ title: 'A' }] }
const r = await agent('summarize', { agentType: 'ultracode-gpt:gpt', schema: { type: 'object' } })
return r`

const TASK_ROW = (task: string) =>
  '[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. ' +
  'The harness indents every line of the computed text. The computed task text follows:\n' +
  task.split('\n').map(l => '  ' + l).join('\n')

const RELAY_ROW =
  '[Workflow harness — user request] The harness relays the request. Where the computed task conflicts with this request, this request wins:\n' +
  '  run the thing'

const ENV_ROW = '<system-reminder>\n# Environment\n - Primary working directory: /work/repo\n - Platform: darwin\n</system-reminder>'

const MARK = (schema: unknown) => `<<ultracode-gpt>>${JSON.stringify({ schema })}<</ultracode-gpt>>\n`

describe('the Workflow script rewrite', () => {
  test('ends the meta literal past braces inside strings', () => {
    expect(SCRIPT.slice(0, metaEnd(SCRIPT))).toBe(SCRIPT.split('\n')[0])
  })

  test('shadows agent after meta and closes the block', () => {
    const out = rewriteScript(SCRIPT, 'marked')!
    expect(out.startsWith(SCRIPT.split('\n')[0])).toBe(true)
    expect(out).toContain('const __ucgptAgent = agent;')
    expect(out).toContain("opts.agentType === \"ultracode-gpt:gpt\"")
    expect(out).toContain('const gpt = false ||')
    expect(out.trimEnd().endsWith('}')).toBe(true)
  })

  test('all mode marks every agent', () => {
    expect(rewriteScript(SCRIPT, 'all')).toContain('const gpt = true ||')
  })

  test('is idempotent and does nothing when off or without meta', () => {
    expect(rewriteScript(rewriteScript(SCRIPT, 'marked')!, 'marked')).toBe(null)
    expect(rewriteScript(SCRIPT, 'off')).toBe(null)
    expect(rewriteScript('return 1', 'marked')).toBe(null)
    expect(rewriteScript("export const meta = { name: 'x' }\nreturn await agent('hi')", 'marked')).toBe(null)
    expect(rewriteScript("export const meta = { name: 'x' }\nreturn await agent('hi')", 'all')).toContain('__ucgptAgent')
  })
})

describe('reading harness rows', () => {
  test('task, relay and cwd', () => {
    expect(readHarnessRow(TASK_ROW('line one\nline two'))).toEqual({ kind: 'task', text: 'line one\nline two' })
    expect(readHarnessRow(RELAY_ROW)).toEqual({ kind: 'relay', text: 'run the thing' })
    expect(readHarnessRow(ENV_ROW)).toEqual({ kind: 'cwd', path: '/work/repo' })
    expect(readHarnessRow('something else')).toBe(null)
  })

  test('the mark carries the schema and comes off the prompt', () => {
    expect(readMark(MARK({ type: 'object' }) + 'do it')).toEqual({ schema: { type: 'object' }, prompt: 'do it' })
    expect(readMark(MARK(null) + 'do it')).toEqual({ schema: null, prompt: 'do it' })
    expect(readMark('do it')).toBe(null)
  })
})

describe('pi', () => {
  test('argv for a schema agent with web tools', () => {
    const plan = piPlan(readSettings({ thinking: 'high' }), '/x/pi', 'P', { type: 'object' })
    expect(plan.argv.slice(0, 6)).toEqual(['pi', '-p', '--mode', 'json', '--no-session', '--no-extensions'])
    expect(plan.argv).toContain('/x/pi/web-search.ts')
    expect(plan.argv).toContain('/x/pi/structured-output.ts')
    expect(plan.argv[plan.argv.indexOf('--tools') + 1]).toBe('read,bash,edit,write,grep,find,ls,web_fetch,structured_output')
    expect(plan.argv[plan.argv.indexOf('--model') + 1]).toBe('openai-codex/gpt-6.1-sol:high')
    expect(plan.argv.slice(-2)).toEqual(['--', 'P'])
    expect(plan.env).toEqual({ UCGPT_SCHEMA: '{"type":"object"}' })
  })

  test('argv with web tools off', () => {
    const plan = piPlan(readSettings({ webSearch: false, webFetch: false }), '/x/pi', 'P', null)
    expect(plan.argv.join(' ')).not.toContain('web-')
    expect(plan.argv[plan.argv.indexOf('--tools') + 1]).toBe('read,bash,edit,write,grep,find,ls')
  })

  test('reads the answer, the structured value and errors off JSONL split anywhere', () => {
    const run = new PiRun()
    const lines =
      JSON.stringify({ type: 'tool_execution_end', toolName: 'structured_output', isError: false, result: { details: { value: { n: 1 } } } }) + '\n' +
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'final' }] } }) + '\n'
    run.feed(lines.slice(0, 17))
    run.feed(lines.slice(17))
    run.end()
    expect(run.hasStructured).toBe(true)
    expect(run.structured).toEqual({ n: 1 })
    expect(run.answer).toBe('final')

    const failed = new PiRun()
    failed.feed(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'HTTP 429', content: [] } }))
    failed.end()
    expect(failed.error).toBe('HTTP 429')
  })
})

// ---- the hooks, against the engine -------------------------------------------

const PI_STDOUT = (answer: string, structured?: unknown) =>
  [
    { type: 'session', version: 3 },
    ...(structured === undefined ? [] : [{ type: 'tool_execution_end', toolName: 'structured_output', isError: false, result: { details: { value: structured } } }]),
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: answer }] } },
  ].map(e => JSON.stringify(e) + '\n').join('')

// Rows reach the plugin's session.append hook; nothing beneath stores them in a
// test (a test hook may not answer the event), so the bottom's refusal is expected.
async function give($: any, agentId: string, door: string, text: string) {
  await $.session.append({
    message: { type: door === 'attachment' ? 'attachment' : 'user', role: 'user', content: [{ type: 'text', text }] },
    door,
    origin: door === 'prompt' ? { kind: 'coordinator' } : { kind: 'engine' },
    uuid: `${agentId}-${door}-${text.length}`,
    agentId,
  }).catch((err: unknown) => {
    if (!String(err).includes('no implementation for session.append')) throw err
  })
}

async function step($: any, agentId: string, index = 0, model = 'claude-haiku-4-5') {
  const chunks: any[] = []
  const stream = $.turn.step({ turnId: 't1', index, model, messageCount: 13, agentId })
  while (true) {
    const piece = await stream.next()
    if (piece.done) return { chunks, result: piece.value }
    chunks.push(piece.value)
  }
}

function beneath(on: any, spawned: any[], stdout: string) {
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'CLAUDE ANSWERED' }
    return { turnId: 't1', index: 0, answer: 'CLAUDE ANSWERED', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('process.spawn', async function* ($: any, e: any) {
    spawned.push(e)
    yield { stream: 'stdout', text: stdout }
    return { value: { code: 0, signal: null } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

test('a marked text agent is answered from pi, in its cwd, with the relay as context', async ($, on) => {
  const spawned: any[] = []
  beneath(on, spawned, PI_STDOUT('gpt says hi'))
  await give($, 'a1', 'prompt', RELAY_ROW)
  await give($, 'a1', 'prompt', TASK_ROW(MARK(null) + 'say hi'))
  await give($, 'a1', 'attachment', ENV_ROW)
  const { chunks, result } = await step($, 'a1')
  expect(chunks.filter(c => c.kind === 'text').map(c => c.text).join('')).toBe('gpt says hi')
  expect(result).toMatchObject({ answer: 'gpt says hi', stopReason: 'end_turn', toolUses: [] })
  expect(spawned).toHaveLength(1)
  expect(spawned[0].cwd).toBe('/work/repo')
  const prompt = spawned[0].argv.at(-1)
  expect(prompt).toContain('run the thing')
  expect(prompt).toContain('say hi')
  expect(prompt).not.toContain('<<ultracode-gpt>>')
})

test('a marked schema agent answers with a StructuredOutput call', async ($, on) => {
  const spawned: any[] = []
  beneath(on, spawned, PI_STDOUT('', { answer: 'x', n: 2 }))
  await give($, 'a2', 'prompt', TASK_ROW(MARK({ type: 'object' }) + 'give n'))
  const { chunks, result } = await step($, 'a2')
  expect(chunks.find(c => c.kind === 'tool')).toMatchObject({ name: 'StructuredOutput' })
  expect(JSON.parse(chunks.find(c => c.kind === 'input').json)).toEqual({ answer: 'x', n: 2 })
  expect(result).toMatchObject({ stopReason: 'tool_use', toolUses: [{ name: 'StructuredOutput', input: { answer: 'x', n: 2 } }] })
  expect(spawned[0].env).toEqual({ UCGPT_SCHEMA: '{"type":"object"}' })
})

test('an unmarked agent and the main loop go to Claude untouched', async ($, on) => {
  const spawned: any[] = []
  beneath(on, spawned, PI_STDOUT('never'))
  await give($, 'a3', 'prompt', TASK_ROW('plain task'))
  expect((await step($, 'a3')).result.answer).toBe('CLAUDE ANSWERED')
  expect((await step($, undefined as any)).result.answer).toBe('CLAUDE ANSWERED')
  expect(spawned).toHaveLength(0)
})

test('an unmarked agent on the GPT model is a miss, answered without Claude or pi', async ($, on) => {
  const spawned: any[] = []
  beneath(on, spawned, PI_STDOUT('never'))
  await give($, 'a4', 'prompt', TASK_ROW('plain task'))
  const { result } = await step($, 'a4', 0, 'gpt-6.1-sol')
  expect(result).toMatchObject({ stopReason: 'end_turn', toolUses: [] })
  expect(result.answer).toContain('GPT MODE MISS')
  expect(spawned).toHaveLength(0)
})

test('the Workflow call is rewritten in marked mode and left alone when off', async ($, on) => {
  const seen: any[] = []
  on('tool.call', ($: any, e: any) => (seen.push(e), { result: 'ok' }))
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'w1', script: SCRIPT } as any)
  expect(seen[0].script).toContain('__ucgptAgent')
})

test('off mode leaves the Workflow script as written', { options: { mode: 'off' } }, async ($, on) => {
  const seen: any[] = []
  on('tool.call', ($: any, e: any) => (seen.push(e), { result: 'ok' }))
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'w1', script: SCRIPT } as any)
  expect(seen[0].script).toBe(SCRIPT)
})
