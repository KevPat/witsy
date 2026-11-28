
import { flushPromises, VueWrapper } from '@vue/test-utils'
import { kArtifactContentMessage, kArtifactReadyMessage } from '@/consts'

// The page of an html artifact is not in the markup of the app: the frame loads the artifact page
// (witsy-artifact://frame/), says it is loaded and is sent the html. jsdom loads no frame, so the
// tests play the part of the frame.

export const artifactFrameOf = (wrapper: VueWrapper<any>): HTMLIFrameElement => {
  return wrapper.find('iframe').element as HTMLIFrameElement
}

/**
 * Says to the app that the frame is loaded and returns what the app sends to it.
 * The component must be mounted in the document (`attachTo: document.body`): a frame that is not
 * in a document has no window.
 */
export const artifactMessagesOf = async (wrapper: VueWrapper<any>, source?: Window | null): Promise<any[]> => {
  const frame = artifactFrameOf(wrapper).contentWindow
  if (!frame) {
    throw new Error('the frame has no window: mount the component with attachTo: document.body')
  }
  const messages: any[] = []
  const postMessage = frame.postMessage
  frame.postMessage = ((message: any) => { messages.push(message) }) as typeof frame.postMessage
  try {
    window.dispatchEvent(new MessageEvent('message', { data: { type: kArtifactReadyMessage }, source: source === undefined ? frame : source }))
    await flushPromises()
  } finally {
    frame.postMessage = postMessage
  }
  return messages
}

/**
 * The html the frame is given, with the script the app adds to it.
 */
export const artifactPageOf = async (wrapper: VueWrapper<any>): Promise<string | undefined> => {
  const messages = await artifactMessagesOf(wrapper)
  return messages.find((message) => message?.type === kArtifactContentMessage)?.html
}
