// Witsy builds its zod schemas with the zod/v3 API (shipped inside zod 4) because
// multi-llm-ts serializes structured outputs for Google and Ollama with
// zod-to-json-schema, which only understands v3 schemas (a v4 schema comes out as
// an empty {} and the provider gets no schema at all). The expected JSON below was
// generated with zod 3.25.76, before the zod 4 upgrade: what Witsy sends to
// OpenAI, Google, Ollama and the OpenAI Realtime API must stay byte-identical.

import { test, expect, beforeAll } from 'vitest'
import { zodResponseFormat } from 'openai/helpers/zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { useWindowMock } from '@tests/mocks/window'
import { processJsonSchema } from '@services/schema'
import { convertToolToAgentsFormat } from '@services/realtime'
import * as dr from '@services/deepresearch'
import { mainLoopAgent } from '@services/deepresearch_al'
import expected from '../../../fixtures/zod/provider_schemas.json'

const simpleSpecs: Record<string, any> = {
  flat: { name: 'string', age: 'number', ok: 'boolean', tags: 'string[]', nums: 'number[]', flags: 'boolean[]', any: 'unknown', weird: 'date' },
  nested: { user: { name: 'string', address: { city: 'string', zip: 'number' } }, items: [{ id: 'number', label: 'string' }] },
  literals: { a: 'hello', b: 42, c: true, d: [1], e: [] },
  formal: { type: 'object', properties: { title: { type: 'string' }, count: { type: 'number' } } },
  typed: { x: { type: 'string' }, y: { type: 'number' }, z: { type: 'object' } },
  arrayRoot: [{ q: 'string' }],
  scalarRoot: 'number',
}

const jsonSchemas: Record<string, any> = {
  basic: { type: 'object', properties: { q: { type: 'string', description: 'query' }, n: { type: 'integer' }, b: { type: 'boolean', description: 'flag' } }, required: ['q'] },
  enumArr: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] }, list: { type: 'array', items: { type: 'string' }, description: 'L' }, anyArr: { type: 'array' } }, required: ['mode', 'list'] },
  nested: { type: 'object', properties: { o: { type: 'object', properties: { x: { type: 'number', description: 'X' } }, required: [] } } },
  unknownType: { type: 'object', properties: { f: { type: 'null' }, g: {} } },
  notObject: { type: 'string', description: 'root string' },
}

const serialize = (f: () => any) => {
  try { return JSON.parse(JSON.stringify(f() ?? null)) } catch (e: any) { return { THREW: String(e?.message ?? e).slice(0, 300) } }
}

const actual = (): Record<string, any> => {
  const out: Record<string, any> = {}
  const structured: Record<string, any> = {
    planning: dr.planningAgent.steps[0].structuredOutput,
    analysis: dr.analysisAgent.steps[0].structuredOutput,
    title: dr.titleAgent.steps[0].structuredOutput,
    research_decision: mainLoopAgent.steps[0].structuredOutput,
  }
  for (const [k, spec] of Object.entries(simpleSpecs)) {
    structured['spec_' + k] = processJsonSchema('spec_' + k, JSON.stringify(spec))
  }
  for (const [k, so] of Object.entries(structured)) {
    // OpenAI chat completions (multi-llm-ts openai provider)
    out[`so.${k}.openai.response_format`] = serialize(() => {
      const r: any = zodResponseFormat(so.structure, so.name)
      return { type: r.type, json_schema: r.json_schema }
    })
    // Google (responseJsonSchema) and Ollama (format) in multi-llm-ts
    out[`so.${k}.zodToJsonSchema`] = serialize(() => zodToJsonSchema(so.structure))
    out[`so.${k}.zodToJsonSchema.named`] = serialize(() => zodToJsonSchema(so.structure, { name: so.name }))
  }
  // OpenAI Realtime tools (@openai/agents)
  const plugin: any = { execute: async () => ({}) }
  for (const [k, parameters] of Object.entries(jsonSchemas)) {
    out[`rt.${k}.agentsTool`] = serialize(() => {
      const t: any = convertToolToAgentsFormat({ type: 'function', function: { name: 'fn_' + k, description: 'd', parameters } } as any, plugin, 'gpt-realtime')
      return { name: t.name, strict: t.strict, parameters: t.parameters }
    })
  }
  return out
}

beforeAll(() => {
  useWindowMock()
})

test('provider schemas are unchanged from zod 3', () => {
  const got = actual()
  expect(Object.keys(got).sort()).toEqual(Object.keys(expected).sort())
  for (const key of Object.keys(expected)) {
    expect(got[key], key).toEqual((expected as any)[key])
  }
})

test('google and ollama schemas are never empty', () => {
  const got = actual()
  for (const [key, value] of Object.entries(got)) {
    if (!key.endsWith('.zodToJsonSchema')) continue
    expect(Object.keys(value).length, key).toBeGreaterThan(1)
  }
})
