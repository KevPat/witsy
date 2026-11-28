import { LlmStructuredOutput } from 'multi-llm-ts'
import { z, ZodType } from 'zod/v3'

// Structured-output schemas are built with the zod/v3 API that ships inside
// zod 4. multi-llm-ts hands them to openai's zodResponseFormat (OpenAI) and to
// zod-to-json-schema (Google, Ollama), and zod-to-json-schema only reads v3
// schemas: a zod 4 schema comes out as an empty {} and the provider gets no
// schema. multi-llm-ts types `structure` as zod 4's ZodType, hence the cast.
export const v3Structure = (schema: ZodType): LlmStructuredOutput['structure'] => {
  return schema as unknown as LlmStructuredOutput['structure']
}

export const generateSimpleSchema = (data: any): any => {
  // Handle null/undefined
  if (data === null || data === undefined) {
    return 'unknown'
  }

  // Handle primitives
  const type = typeof data
  if (type === 'string') return 'string'
  if (type === 'number') return 'number'
  if (type === 'boolean') return 'boolean'

  // Handle arrays
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return []
    }
    // Use first element's type
    return [generateSimpleSchema(data[0])]
  }

  // Handle objects
  if (type === 'object') {
    const schema: Record<string, any> = {}
    for (const [key, value] of Object.entries(data)) {
      schema[key] = generateSimpleSchema(value)
    }
    return schema
  }

  // Default to unknown for anything else
  return 'unknown'
}

export const parseSimpleFormatToZod = (structure: any): ZodType => {

  // when we a get type object return its type
  if (typeof structure === 'object' && Object.keys(structure ?? {}).includes('type')) {
    if (structure['type'] !== 'object') {
      return parseSimpleFormatToZod(structure['type'])
    }
  }

  // simple types
  if (typeof structure === 'string') {
    switch (structure) {
      case 'string': return z.string()
      case 'number': return z.number()
      case 'boolean': return z.boolean()
      case 'unknown': return z.string()
      case 'string[]': return z.array(z.string())
      case 'number[]': return z.array(z.number())
      case 'boolean[]': return z.array(z.boolean())
      default: return z.string()
    }
  } else if (typeof structure === 'number') {
    return z.number()
  } else if (typeof structure === 'boolean') {
    return z.boolean()
  }
  
  // array
  if (Array.isArray(structure)) {
    return z.array(parseSimpleFormatToZod(structure[0]))
  }

  // object
  if (typeof structure === 'object' && structure !== null) {
    
    const zodObject: Record<string, ZodType> = {}
    for (const [key, value] of Object.entries(structure)) {
      zodObject[key] = parseSimpleFormatToZod(value)
    }

    // if formal spec
    if (Object.keys(zodObject).includes('type') && Object.keys(zodObject).includes('properties')) {
      return zodObject['properties']
    }

    // default
    return z.object(zodObject)

  }
  
  // default
  return z.string()
}

export const processJsonSchema = (name: string, jsonSchema?: string): LlmStructuredOutput|null => {

  if (!jsonSchema) return null

  let parsedSchema: any
  try {
    parsedSchema = JSON.parse(jsonSchema)
  } catch (e) {
    console.warn('Provided schema is not valid JSON :', e)
    return null
  }

  try {
    return {
      name,
      structure: v3Structure(parseSimpleFormatToZod(parsedSchema))
    }
  } catch (e) {
    console.error('Failed to parse structured output schema:', e)
    return null
  }
}