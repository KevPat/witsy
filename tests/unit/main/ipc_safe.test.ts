
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { kIpcErrorReturnValue, safeIpcListener, safeIpcMain } from '@main/ipc_safe'

// what Electron hands to an ipcMain listener for ipcRenderer.sendSync: returnValue is an own accessor whose getter
// always returns undefined and whose setter sends the reply, and the other members are backed by a native object:
// they throw when their receiver is not the event itself (private fields behave the same way with a proxy)
class SyncEvent {

  #frame = { url: 'app://witsy' }
  #prevented = false
  replies: unknown[] = []
  sender = { id: 1, send: vi.fn() }

  constructor(send?: (value: unknown) => void) {
    Object.defineProperty(this, 'returnValue', {
      set: (value: unknown) => { send?.(value); this.replies.push(value) },
      get: () => { /* same as Electron */ },
    })
  }

  get senderFrame() { return this.#frame }
  get defaultPrevented() { return this.#prevented }
  preventDefault() { this.#prevented = true }

}

const syncEvent = (send?: (value: unknown) => void): any => new SyncEvent(send)

let errors: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('safeIpcListener', () => {

  test('the fallback reply survives JSON.parse and is falsy', () => {
    expect(kIpcErrorReturnValue).toBeNull()
    expect(JSON.parse(kIpcErrorReturnValue)).toBeNull()
  })

  test('passes the reply of a listener that succeeds', () => {
    const event = syncEvent()
    const listener = safeIpcListener('channel', (e, a, b) => { e.returnValue = a + b })
    expect(listener(event, 1, 2)).toBeUndefined()
    expect(event.replies).toEqual([3])
    expect(errors).not.toHaveBeenCalled()
  })

  test('replies when the listener throws before replying', () => {
    const event = syncEvent()
    const listener = safeIpcListener('channel', (e, payload) => { e.returnValue = JSON.parse(payload) })
    expect(() => listener(event, 'not json')).not.toThrow()
    expect(event.replies).toEqual([null])
  })

  test('logs the channel and the error but not the payload', () => {
    const error = new Error('boom')
    const listener = safeIpcListener('config-save', () => { throw error })
    listener(syncEvent(), 'payload-with-a-secret')
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][0]).toContain('config-save')
    expect(errors.mock.calls[0][1]).toBe(error)
    expect(JSON.stringify(errors.mock.calls)).not.toContain('payload-with-a-secret')
  })

  test('replies when an async listener rejects before replying', async () => {
    const event = syncEvent()
    const listener = safeIpcListener('channel', async (e) => { e.returnValue = await Promise.reject(new Error('boom')) })
    await expect(listener(event)).resolves.toBeUndefined()
    expect(event.replies).toEqual([null])
    expect(errors).toHaveBeenCalledTimes(1)
  })

  test('replies when a listener returns a thenable that rejects', async () => {
    const event = syncEvent()
    const thenable = { then: (_: unknown, reject: (error: Error) => void) => reject(new Error('boom')) }
    await safeIpcListener('channel', () => thenable)(event)
    expect(event.replies).toEqual([null])
  })

  test('passes the reply of an async listener that succeeds', async () => {
    const event = syncEvent()
    const listener = safeIpcListener('channel', async (e) => { e.returnValue = await Promise.resolve('fonts'); return 'done' })
    await expect(listener(event)).resolves.toBe('done')
    expect(event.replies).toEqual(['fonts'])
    expect(errors).not.toHaveBeenCalled()
  })

  test('does not reply twice when the listener throws after replying', () => {
    const event = syncEvent()
    const listener = safeIpcListener('channel', (e) => { e.returnValue = 'first'; throw new Error('late') })
    expect(() => listener(event)).not.toThrow()
    expect(event.replies).toEqual(['first'])
    expect(errors).toHaveBeenCalledTimes(1)
  })

  test('does not reply twice when an async listener rejects after replying', async () => {
    const event = syncEvent()
    const listener = safeIpcListener('channel', async (e) => { e.returnValue = 'first'; await Promise.resolve(); throw new Error('late') })
    await listener(event)
    expect(event.replies).toEqual(['first'])
  })

  test('does not reply for a listener that returns without replying', async () => {
    const sync = syncEvent()
    safeIpcListener('channel', () => { /* replies later from a callback */ })(sync)
    expect(sync.replies).toEqual([])
    const async = syncEvent()
    await safeIpcListener('channel', async () => { /* replies later from a callback */ })(async)
    expect(async.replies).toEqual([])
    expect(errors).not.toHaveBeenCalled()
  })

  test('a reply sent later through the event the listener received is seen', async () => {
    const event = syncEvent()
    let reply: () => void
    const listener = safeIpcListener('channel', async (e) => {
      reply = () => { e.returnValue = 'late' }
      await Promise.resolve()
      reply()
      throw new Error('after the reply')
    })
    await listener(event)
    expect(event.replies).toEqual(['late'])
  })

  test('replies when the reply itself cannot be sent', () => {
    // Electron throws when the value cannot be cloned
    const event = syncEvent((value) => {
      if (typeof value === 'function') throw new Error('An object could not be cloned')
    })
    safeIpcListener('channel', (e) => { e.returnValue = () => {} })(event)
    expect(event.replies).toEqual([null])
  })

  test('does not throw when no reply can be sent at all', () => {
    const event = syncEvent(() => { throw new Error('channel closed') })
    const listener = safeIpcListener('channel', () => { throw new Error('boom') })
    expect(() => listener(event)).not.toThrow()
    expect(event.replies).toEqual([])
    expect(errors).toHaveBeenCalledTimes(2)
  })

  test('getters and methods of the event run against the real event', () => {
    const event = syncEvent()
    const seen: any = {}
    safeIpcListener('channel', (e) => {
      seen.sender = e.sender
      seen.frame = e.senderFrame
      const { preventDefault } = e
      preventDefault()
      seen.prevented = e.defaultPrevented
      seen.hasReturnValue = 'returnValue' in e
      seen.returnValue = e.returnValue
      e.returnValue = true
    })(event)
    expect(seen.sender).toBe(event.sender)
    expect(seen.frame).toEqual({ url: 'app://witsy' })
    expect(seen.prevented).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(seen.hasReturnValue).toBe(true)
    expect(seen.returnValue).toBeUndefined()
    expect(event.replies).toEqual([true])
  })

  test('a frozen method of the event can be read and called', () => {
    const event = syncEvent()
    const reply = vi.fn()
    Object.defineProperty(event, 'reply', { value: reply, writable: false, configurable: false })
    safeIpcListener('channel', (e) => { e.reply('pong'); e.returnValue = true })(event)
    expect(reply).toHaveBeenCalledWith('pong')
    expect(event.replies).toEqual([true])
    expect(errors).not.toHaveBeenCalled()
  })

  test('other properties assigned by the listener reach the event and do not count as a reply', () => {
    const event = syncEvent()
    safeIpcListener('channel', (e: any) => { e.custom = 1; throw new Error('boom') })(event)
    expect(event.custom).toBe(1)
    expect(event.replies).toEqual([null])
  })

  test('an event of ipcRenderer.send gets a harmless returnValue when the listener throws', () => {
    const event: any = { sender: { id: 1 } }
    expect(() => safeIpcListener('channel', () => { throw new Error('boom') })(event)).not.toThrow()
    expect(event.returnValue).toBeNull()
  })

  test('a call without an event object still reaches the listener', () => {
    const listener = vi.fn()
    safeIpcListener('channel', listener)(undefined as any, 'payload')
    expect(listener).toHaveBeenCalledWith(undefined, 'payload')
  })

})

describe('safeIpcMain', () => {

  class FakeIpcMain extends EventEmitter {
    #handlers = new Map<string, (...args: any[]) => any>()
    handle(channel: string, handler: (...args: any[]) => any) { this.#handlers.set(channel, handler) }
    invoke(channel: string, ...args: any[]) { return this.#handlers.get(channel)!(...args) }
  }

  const install = () => {
    const ipcMain = new FakeIpcMain()
    return { ipcMain, safe: safeIpcMain(ipcMain as any) }
  }

  test('a listener registered with on replies when it throws', () => {
    const { ipcMain, safe } = install()
    safe.on('channel', () => { throw new Error('boom') })
    const event = syncEvent()
    expect(() => ipcMain.emit('channel', event, 'payload')).not.toThrow()
    expect(event.replies).toEqual([null])
  })

  test('a listener registered with on replies when it rejects', async () => {
    const { ipcMain, safe } = install()
    safe.on('channel', async () => { throw new Error('boom') })
    const event = syncEvent()
    await ipcMain.rawListeners('channel')[0](event)
    expect(event.replies).toEqual([null])
  })

  test('on receives the arguments and can be chained', () => {
    const { ipcMain, safe } = install()
    const listener = vi.fn((event, a, b) => { event.returnValue = [a, b] })
    expect(safe.on('one', listener).on('two', listener)).toBe(safe)
    const event = syncEvent()
    ipcMain.emit('two', event, 'a', 'b')
    expect(event.replies).toEqual([['a', 'b']])
    expect(ipcMain.listenerCount('one')).toBe(1)
  })

  test('a listener registered with on can be removed', () => {
    const { ipcMain, safe } = install()
    const listener = vi.fn()
    safe.on('channel', listener)
    safe.removeListener('channel', listener)
    expect(ipcMain.listenerCount('channel')).toBe(0)
  })

  test('handle and the other members are those of ipcMain', async () => {
    const { ipcMain, safe } = install()
    const handler = vi.fn(async () => { throw new Error('boom') })
    safe.handle('channel', handler)
    await expect(ipcMain.invoke('channel', 'payload')).rejects.toThrow('boom')
    expect(handler).toHaveBeenCalledWith('payload')
    expect(safe.listenerCount('channel')).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  })

})
