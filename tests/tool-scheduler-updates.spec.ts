/** A dynamically registered MCP tool must not disturb the core tool scheduler or scoped restrictions. */
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { TOOL_RUNTIME_SCHEDULER, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'

const scopes: { dispose(): Promise<void> }[] = []
afterEach(async () => { for (const scope of scopes.splice(0)) await scope.dispose() })

it('preserves the scheduler and restricted Bash across late MCP registrations', async () => {
  const ctx = new Context()
  ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  new ToolRuntime(ctx)
  expect(ctx.tools[TOOL_RUNTIME_SCHEDULER]).toBeDefined()
  // A scope identity is enough for a registry-only test; no model or session is started.
  const agent = { id: 'main' } as Agent
  const main = createScope(ctx, agent)
  scopes.push(main)
  const noopOutput = { schema: { type: 'object' as const, additionalProperties: true }, render: () => [] }
  const executeBash = vi.fn(async () => ({ ok: true }))
  const bash = { name: 'bash', description: 'Test command', parameters: { type: 'object' as const, properties: {} },
    output: noopOutput, execute: executeBash }
  const secret = { name: 'mcp__secrets__reveal', description: 'Should stay excluded',
    parameters: { type: 'object' as const, properties: {} }, output: noopOutput, execute: async () => ({ ok: false }) }
  ctx.tools.register(bash)
  ctx.tools.register(secret)
  const lift = main.ctx.tools.restrict({ allow: ['bash'] })
  try {
    expect(ctx.tools.get('bash', agent)).toBeDefined()
    expect(ctx.tools.get('mcp__secrets__reveal', agent)).toBeUndefined()
    const unregisterMcp = ctx.tools.register({ name: 'mcp__example__judge', description: 'Late MCP registration',
      parameters: { type: 'object' as const, properties: {} }, output: noopOutput, execute: async () => ({ likely: true }) })
    try {
      // A late model tool update may invalidate the surface, not the scheduler service or Bash execution.
      expect(ctx.tools.get('bash', agent)).toBeDefined()
      expect(ctx.tools.get('mcp__example__judge', agent)).toBeUndefined()
      expect(ctx.tools.get('mcp__secrets__reveal', agent)).toBeUndefined()
      const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
      expect(scheduler).toBeDefined()
      expect(scheduler.prepare).toBeTypeOf('function')
      // Match the DSH agent-loop's scheduler pathway, rather than calling the tool body ourselves.
      const prepared = await scheduler.prepare({
        name: 'bash', callId: ToolCallId('bash-after-mcp-update'), agent, arguments: {}, signal: new AbortController().signal,
      })
      expect(prepared.kind).toBe('dispatch')
      if (prepared.kind !== 'dispatch') throw new Error('Bash did not reach the scheduler')
      const dispatched = await scheduler.dispatch(prepared.exec)
      const result = dispatched.kind === 'post-result'
        ? await scheduler.finalize(prepared.exec, dispatched.result)
        : scheduler.finish(prepared.exec, dispatched.result)
      expect(result.isError).not.toBe(true)
      expect(executeBash).toHaveBeenCalledOnce()
    } finally { unregisterMcp() }
  } finally { lift() }
})
