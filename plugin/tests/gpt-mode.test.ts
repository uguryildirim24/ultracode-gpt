import { describe, expect, test } from 'claude-code/testing'
import { MIRROR_TEXT_MAX, PI_TOOL, metaEnd, mirrorInput, piPlan, readHarnessRow, readMark, readSettings, rewriteScript, PiRun } from '../hooks/lib.ts'

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

type FakeCall = { id: string; name: string; args: unknown; result: string; isError?: boolean }

// pi's JSONL for a run whose turns call `turns` tools, then answer `answer`.
const PI_TOOL_STDOUT = (turns: FakeCall[][], answer: string, structured?: unknown) =>
  [
    { type: 'session', version: 3 },
    ...turns.flatMap((calls, i) => [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            { type: 'text', text: `Step ${i + 1}.` },
            ...calls.map(c => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.args })),
          ],
        },
      },
      ...calls.flatMap(c => [
        { type: 'tool_execution_start', toolCallId: c.id, toolName: c.name, args: c.args },
        {
          type: 'tool_execution_end',
          toolCallId: c.id,
          toolName: c.name,
          isError: c.isError === true,
          result: { content: [{ type: 'text', text: c.result }], details: c.name === 'structured_output' ? { value: c.args } : {} },
        },
      ]),
    ]),
    ...(structured === undefined ? [] : [{ type: 'tool_execution_end', toolCallId: 'so', toolName: 'structured_output', isError: false, result: { details: { value: structured } } }]),
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: answer }] } },
  ].map(e => JSON.stringify(e) + '\n').join('')

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

  test('queues the turns that called tools, and each tool result by call id', () => {
    const run = new PiRun()
    const out = PI_TOOL_STDOUT([[{ id: 'c1', name: 'bash', args: { command: 'ls' }, result: 'a.txt' }]], 'done')
    run.feed(out.slice(0, 40))
    run.feed(out.slice(40))
    run.end()
    expect(run.turns).toEqual([{ text: 'Step 1.', calls: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }] }])
    expect(run.results.get('c1')).toEqual({ text: 'a.txt', isError: false })
    expect(run.answer).toBe('done')
  })

  test('structured_output is the answer, not a step', () => {
    const run = new PiRun()
    run.feed(PI_TOOL_STDOUT([[{ id: 'c1', name: 'structured_output', args: { n: 1 }, result: 'ok' }]], ''))
    run.end()
    expect(run.turns).toEqual([])
  })

  test('a mirrored call keeps short arguments and clips long ones', () => {
    expect(mirrorInput({ id: 'c', name: 'read', args: { path: 'a.ts' } })).toEqual({ call: 'read', args: { path: 'a.ts' } })
    const long = mirrorInput({ id: 'c', name: 'write', args: { content: 'x'.repeat(MIRROR_TEXT_MAX * 2) } })
    expect(typeof long.args).toBe('string')
    expect(String(long.args)).toContain('more chars]')
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

function beneath(on: any, spawned: any[], stdout: string, toasts: string[] = []) {
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
  on('ui.toast', ($: any, e: any) => (toasts.push(e.text), { value: undefined }))
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

// ---- pi's steps mirrored into the agent's transcript --------------------------

const LS = { id: 'c1', name: 'bash', args: { command: 'ls' }, result: 'a.txt' }
const CAT = { id: 'c2', name: 'read', args: { path: 'a.txt' }, result: 'hello' }

test("pi's tool turns become steps calling the pi tool, answered with pi's results", async ($, on) => {
  const spawned: any[] = []
  beneath(on, spawned, PI_TOOL_STDOUT([[LS]], 'done: a.txt'))
  await give($, 'a5', 'prompt', TASK_ROW(MARK(null) + 'list files'))

  const first = await step($, 'a5', 0)
  expect(first.chunks.map(c => c.kind)).toEqual(['text', 'tool', 'input', 'stop'])
  const tool = first.chunks.find(c => c.kind === 'tool')
  expect(tool.name).toBe(PI_TOOL)
  expect(JSON.parse(first.chunks.find(c => c.kind === 'input').json)).toEqual({ call: 'bash', args: { command: 'ls' } })
  expect(first.result).toMatchObject({ answer: 'Step 1.', stopReason: 'tool_use', toolUses: [{ name: PI_TOOL, input: { call: 'bash' } }] })

  const served: any = await $.tool.call({ tool: PI_TOOL, tool_use_id: tool.id, agentId: 'a5', call: 'bash', args: { command: 'ls' } } as any)
  expect(served.result).toBe('a.txt')

  const last = await step($, 'a5', 1)
  expect(last.chunks.filter(c => c.kind === 'tool')).toHaveLength(0)
  expect(last.result).toMatchObject({ answer: 'done: a.txt', stopReason: 'end_turn', toolUses: [] })
  expect(spawned).toHaveLength(1)
})

test('a schema agent mirrors its steps, then answers with StructuredOutput', async ($, on) => {
  const spawned: any[] = []
  beneath(on, spawned, PI_TOOL_STDOUT([[LS]], '', { n: 3 }))
  await give($, 'a9', 'prompt', TASK_ROW(MARK({ type: 'object' }) + 'count files'))
  const first = await step($, 'a9', 0)
  const tool = first.chunks.find(c => c.kind === 'tool')
  await $.tool.call({ tool: PI_TOOL, tool_use_id: tool.id, agentId: 'a9', call: 'bash', args: {} } as any)
  const last = await step($, 'a9', 1)
  expect(last.result).toMatchObject({ stopReason: 'tool_use', toolUses: [{ name: 'StructuredOutput', input: { n: 3 } }] })
})

test('a mirrored call the engine never hands to the pi tool stops the mirroring; the agent still answers', async ($, on) => {
  const spawned: any[] = []
  const toasts: string[] = []
  beneath(on, spawned, PI_TOOL_STDOUT([[LS], [CAT]], 'done'), toasts)
  await give($, 'a6', 'prompt', TASK_ROW(MARK(null) + 'read files'))
  expect((await step($, 'a6', 0)).result.stopReason).toBe('tool_use')
  const last = await step($, 'a6', 1)
  expect(last.chunks.filter(c => c.kind === 'tool')).toHaveLength(0)
  expect(last.result).toMatchObject({ answer: 'done', stopReason: 'end_turn' })
  expect(toasts.join('\n')).toContain("can't be shown")
})

test('the pi tool refuses calls GPT mode did not make', async ($, on) => {
  beneath(on, [], '')
  const r: any = await $.tool.call({ tool: PI_TOOL, tool_use_id: 'x1', call: 'bash', args: {} } as any).catch((err: unknown) => ({ rejected: String(err) }))
  expect(JSON.stringify(r)).toContain('only records the steps')
})

test('a GPT agent that ends while pi runs stops pi', async ($, on) => {
  const closed = { value: false }
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: 'CLAUDE ANSWERED', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('process.spawn', async function* () {
    try {
      // The session and pi's first tool turn; then pi works on, never read again.
      yield { stream: 'stdout', text: PI_TOOL_STDOUT([[LS]], 'never').split('\n').slice(0, 2).join('\n') + '\n' }
      yield { stream: 'stdout', text: '' }
      return { value: { code: 0, signal: null } }
    } finally {
      closed.value = true
    }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await give($, 'a7', 'prompt', TASK_ROW(MARK(null) + 'long task'))
  expect((await step($, 'a7', 0)).result.stopReason).toBe('tool_use')
  expect(closed.value).toBe(false)
  await $.turn.complete({ turnId: 't1', agentId: 'a7', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' } as any)
  for (let i = 0; i < 20 && !closed.value; i++) await new Promise(r => (globalThis as any).setTimeout(r, 10))
  expect(closed.value).toBe(true)
})

test('only the StructuredOutput verdict asks for a retry, not a mirrored step', async ($, on) => {
  const spawned: any[] = []
  beneath(on, spawned, PI_TOOL_STDOUT([], '', { n: 1 }))
  await give($, 'a8', 'prompt', TASK_ROW(MARK({ type: 'object' }) + 'give n'))
  const first = await step($, 'a8', 0)
  const id = first.chunks.find(c => c.kind === 'tool').id
  const verdict = async (toolUseId: string, isError: boolean) =>
    $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: 'n must be > 1' }] },
      door: 'tool-result',
      origin: { kind: 'engine' },
      uuid: `a8-${toolUseId}-${isError}`,
      agentId: 'a8',
    } as any).catch((err: unknown) => {
      if (!String(err).includes('no implementation for session.append')) throw err
    })
  await verdict('toolu_some_mirrored_call', true)
  expect((await step($, 'a8', 1)).result.answer).toBe('Structured output delivered.')
  await verdict(id, true)
  await step($, 'a8', 2)
  expect(spawned).toHaveLength(2)
  expect(spawned[1].argv.at(-1)).toContain('n must be > 1')
})
