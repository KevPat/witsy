
import type { IpcMain, IpcMainEvent } from 'electron'

// A renderer that calls ipcRenderer.sendSync is blocked until the listener assigns event.returnValue.
// A listener that throws, or an async one that rejects, before assigning it used to leave the window frozen.
// Listeners registered through safeIpcMain get a reply in that case too.

// What the caller of sendSync receives when its handler failed before replying.
// null rather than undefined because preload does JSON.parse(sendSync(...)) for many channels:
// JSON.parse(null) is null, JSON.parse(undefined) throws. null is also falsy for the callers
// that expect a success boolean, so a failure is never mistaken for a success.
export const kIpcErrorReturnValue: null = null

type IpcListener = (event: IpcMainEvent, ...args: any[]) => any

// reads a property of a native-backed object through a proxy:
// the original object must be the receiver of getters and the `this` of methods
const forward = (target: object, prop: string | symbol): unknown => {
  const value = Reflect.get(target, prop, target)
  if (typeof value !== 'function') return value
  // a proxy must report the exact value of a frozen data property
  const descriptor = Reflect.getOwnPropertyDescriptor(target, prop)
  if (descriptor && 'value' in descriptor && !descriptor.configurable && !descriptor.writable) return value
  return value.bind(target)
}

const isThenable = (value: unknown): value is PromiseLike<unknown> => {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as PromiseLike<unknown>).then === 'function'
}

export const safeIpcListener = (channel: string, listener: IpcListener): IpcListener => {

  const safeListener = function(this: unknown, event: IpcMainEvent, ...args: unknown[]): unknown {

    // nothing to reply to
    if (event === null || typeof event !== 'object') {
      return listener.call(this, event, ...args)
    }

    // same event, but we know if a reply was sent
    let replied = false
    const watchedEvent = new Proxy(event, {
      get: forward,
      set(target, prop, value) {
        const assigned = Reflect.set(target, prop, value, target)
        if (assigned && prop === 'returnValue') replied = true
        return assigned
      },
    })

    // payloads are not logged: they can contain secrets
    const onError = (error: unknown): void => {
      console.error(`[ipc] Error in handler of '${channel}':`, error)
      if (replied) return
      try {
        event.returnValue = kIpcErrorReturnValue
        replied = true
      } catch (replyError) {
        console.error(`[ipc] Could not reply to '${channel}':`, replyError)
      }
    }

    try {
      const result = listener.call(this, watchedEvent, ...args)
      return isThenable(result) ? Promise.resolve(result).then((value) => value, onError) : result
    } catch (error) {
      onError(error)
    }

  }

  // same convention as EventEmitter.once: removeListener(channel, listener) finds the wrapper
  safeListener.listener = listener
  return safeListener

}

// same API as ipcMain, except that listeners added with `on` are wrapped by safeIpcListener.
// `handle` is untouched: Electron already rejects the promise of ipcRenderer.invoke when a handler fails.
export const safeIpcMain = (ipcMain: IpcMain): IpcMain => {
  const safe: IpcMain = new Proxy(ipcMain, {
    get(target, prop) {
      if (prop !== 'on') return forward(target, prop)
      return (channel: string, listener: IpcListener): IpcMain => {
        target.on(channel, safeIpcListener(channel, listener))
        return safe
      }
    },
  })
  return safe
}
