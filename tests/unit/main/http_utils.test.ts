import { vi, expect, test, beforeEach, Mock } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError, sendHandlerError, parseParams, HttpError } from '@main/http_utils'

let mockRes: Partial<ServerResponse>
let mockReq: Partial<IncomingMessage>

beforeEach(() => {
  mockRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
  }
  mockReq = {
    method: 'GET',
    headers: {},
    on: vi.fn(),
  }
})

test('sendJson sends JSON response with default status 200', () => {
  const data = { success: true, message: 'test' }
  sendJson(mockRes as ServerResponse, data)

  expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
  expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify(data))
})

test('sendJson sends JSON response with custom status code', () => {
  const data = { success: true }
  sendJson(mockRes as ServerResponse, data, 201)

  expect(mockRes.writeHead).toHaveBeenCalledWith(201, { 'Content-Type': 'application/json' })
  expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify(data))
})

test('sendError sends error response with default status 400', () => {
  sendError(mockRes as ServerResponse, 'Bad request')

  expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' })
  expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: false, error: 'Bad request' }))
})

test('sendError sends error response with custom status code', () => {
  sendError(mockRes as ServerResponse, 'Not found', 404)

  expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' })
  expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: false, error: 'Not found' }))
})

test('parseParams extracts GET query parameters', async () => {
  const parsedUrl = new URL('http://localhost:8090/api/test?name=John&age=30')

  const params = await parseParams(mockReq as IncomingMessage, parsedUrl)

  expect(params).toEqual({ name: 'John', age: '30' })
})

test('parseParams extracts POST JSON body', async () => {
  mockReq.method = 'POST'
  mockReq.headers = { 'content-type': 'application/json' }

  const jsonBody = JSON.stringify({ name: 'Jane', age: '25' })

  // Mock the request stream
  const listeners: Record<string, (...args: any[]) => void> = {}
  mockReq.on = vi.fn((event: string, callback: (...args: any[]) => void) => {
    listeners[event] = callback
    return mockReq as IncomingMessage
  }) as Mock

  const parsedUrl = new URL('http://localhost:8090/api/test')
  const promise = parseParams(mockReq as IncomingMessage, parsedUrl)

  // Simulate receiving data
  listeners['data'](jsonBody)
  listeners['end']()

  const params = await promise

  expect(params).toEqual({ name: 'Jane', age: '25' })
})

const postWithBody = (contentType: string | undefined, chunks: (string | Buffer)[]) => {
  mockReq.method = 'POST'
  mockReq.headers = contentType === undefined ? {} : { 'content-type': contentType }
  mockReq.on = vi.fn((event: string, callback: (...args: any[]) => void) => {
    if (event === 'data') chunks.forEach((chunk) => callback(chunk))
    if (event === 'end') callback()
    return mockReq as IncomingMessage
  }) as Mock
  return parseParams(mockReq as IncomingMessage, new URL('http://localhost:8090/api/test?name=Test'))
}

test.each([
  'application/json',
  'application/json; charset=utf-8',
  'application/json;charset=UTF-8',
  'Application/JSON',
  ' application/json ; charset=utf-8',
])('parseParams accepts a JSON body sent as "%s"', async (contentType) => {
  const params = await postWithBody(contentType, [JSON.stringify({ city: 'NYC' })])
  expect(params).toEqual({ name: 'Test', city: 'NYC' })
})

test.each([
  ['text/plain;application/json'],
  ['text/plain; charset=application/json'],
  ['text/plain; x=application/json'],
  ['text/plain'],
  ['application/x-www-form-urlencoded'],
  ['multipart/form-data; boundary=x'],
  ['application/jsonp'],
  ['application/json-seq'],
  ['x-application/json'],
  [''],
  [undefined],
])('parseParams answers 415 to a body sent as "%s"', async (contentType) => {
  const promise = postWithBody(contentType, [JSON.stringify({ city: 'NYC' })])
  await expect(promise).rejects.toBeInstanceOf(HttpError)
  await expect(promise).rejects.toMatchObject({ statusCode: 415 })
})

test('parseParams accepts a POST without body whatever its content type', async () => {
  const params = await postWithBody('text/plain', [])
  expect(params).toEqual({ name: 'Test' })
})

test('parseParams reassembles a multi-byte character split across chunks', async () => {
  const body = Buffer.from(JSON.stringify({ city: 'Zürich' }))
  const split = body.indexOf(0xc3) + 1
  const params = await postWithBody('application/json', [body.subarray(0, split), body.subarray(split)])
  expect(params).toEqual({ name: 'Test', city: 'Zürich' })
})

test('parseParams answers 413 to a body over the size limit and stops buffering it', async () => {
  const megabyte = Buffer.alloc(1024 * 1024, 0x20)
  const concat = vi.spyOn(Buffer, 'concat')
  const promise = postWithBody('application/json', Array(40).fill(megabyte))
  await expect(promise).rejects.toMatchObject({ statusCode: 413 })
  expect(concat.mock.calls.every(([chunks]) => chunks.length === 0)).toBe(true)
  concat.mockRestore()
})

test('sendHandlerError answers with the status of an HttpError and 500 otherwise', () => {
  sendHandlerError(mockRes as ServerResponse, new HttpError(415, 'Unsupported'))
  expect(mockRes.writeHead).toHaveBeenLastCalledWith(415, { 'Content-Type': 'application/json' })
  expect(mockRes.end).toHaveBeenLastCalledWith(JSON.stringify({ success: false, error: 'Unsupported' }))

  sendHandlerError(mockRes as ServerResponse, new Error('Boom'))
  expect(mockRes.writeHead).toHaveBeenLastCalledWith(500, { 'Content-Type': 'application/json' })
  expect(mockRes.end).toHaveBeenLastCalledWith(JSON.stringify({ success: false, error: 'Boom' }))

  sendHandlerError(mockRes as ServerResponse, 'not an error')
  expect(mockRes.end).toHaveBeenLastCalledWith(JSON.stringify({ success: false, error: 'Internal server error' }))
})

test('parseParams combines GET and POST parameters', async () => {
  mockReq.method = 'POST'
  mockReq.headers = { 'content-type': 'application/json' }

  const jsonBody = JSON.stringify({ city: 'NYC' })

  const listeners: Record<string, (...args: any[]) => void> = {}
  mockReq.on = vi.fn((event: string, callback: (...args: any[]) => void) => {
    listeners[event] = callback
    return mockReq as IncomingMessage
  }) as Mock

  const parsedUrl = new URL('http://localhost:8090/api/test?name=Alice')
  const promise = parseParams(mockReq as IncomingMessage, parsedUrl)

  listeners['data'](jsonBody)
  listeners['end']()

  const params = await promise

  expect(params).toEqual({ name: 'Alice', city: 'NYC' })
})

test('parseParams handles empty POST body gracefully', async () => {
  mockReq.method = 'POST'
  mockReq.headers = { 'content-type': 'application/json' }

  const listeners: Record<string, (...args: any[]) => void> = {}
  mockReq.on = vi.fn((event: string, callback: (...args: any[]) => void) => {
    listeners[event] = callback
    return mockReq as IncomingMessage
  }) as Mock

  const parsedUrl = new URL('http://localhost:8090/api/test?name=Test')
  const promise = parseParams(mockReq as IncomingMessage, parsedUrl)

  listeners['data']('')
  listeners['end']()

  const params = await promise

  expect(params).toEqual({ name: 'Test' })
})

test('parseParams handles invalid JSON gracefully', async () => {
  mockReq.method = 'POST'
  mockReq.headers = { 'content-type': 'application/json' }

  const listeners: Record<string, (...args: any[]) => void> = {}
  mockReq.on = vi.fn((event: string, callback: (...args: any[]) => void) => {
    listeners[event] = callback
    return mockReq as IncomingMessage
  }) as Mock

  const parsedUrl = new URL('http://localhost:8090/api/test?name=Test')
  const promise = parseParams(mockReq as IncomingMessage, parsedUrl)

  listeners['data']('{invalid json}')
  listeners['end']()

  const params = await promise

  // Should still return query params even if JSON parsing fails
  expect(params).toEqual({ name: 'Test' })
})
