
import { NetworkRequest } from 'types/index'
import { BrowserWindow } from 'electron'
import { debugWindow } from './windows/debug'
import { HttpServer } from './http_server'

const TTL = (process.env.DEBUG ? 10 : 3) * 60 * 1000

export const HIDDEN = '*** hidden ***'
export const MAX_REQUESTS_PER_WINDOW = 500
export const MAX_WEBSOCKET_FRAMES = 200
export const MAX_FRAME_PAYLOAD_LENGTH = 4 * 1024
export const MAX_BODY_LENGTH = 256 * 1024

const SECRET_HEADER = /auth|cookie|token|secret|passw|credential|signature|api[-_]?key|[-_]key$/i
// challenges, handshake nonces and rate limit counters match the pattern above but carry no credential
const PUBLIC_HEADER = /^(www-authenticate|proxy-authenticate|sec-websocket-key|idempotency-key)$|rate-?limit/i
const URL_HEADER = /^(location|content-location|referer)$/i

const SECRET_PARAM = /^(key|code|sig|pwd|auth|jwt)$|token|secret|passw|signature|credential|authorization|api[-_]?key|[-_]key$|[-_]auth$|^auth[-_]/i
const PUBLIC_PARAM = /^(max[-_]?(output[-_]?)?tokens|(next[-_]?)?page[-_]?token|token[-_]?type)$/i

const requests = new Map<string, NetworkRequest>()

// for each intercepted window, the ids it recorded, oldest first
const windowRequests = new Set<Set<string>>()

export const getNetworkHistory = (): NetworkRequest[] => Array.from(requests.values())

export const clearNetworkHistory = () => {
  requests.clear()
  windowRequests.forEach((ids) => ids.clear())
}

const isSecretHeader = (name: string): boolean => SECRET_HEADER.test(name) && !PUBLIC_HEADER.test(name)

const isSecretParam = (name: string): boolean => {
  let decoded = name
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, ' '))
  } catch { /* keep the raw name */ }
  decoded = decoded.trim()
  return SECRET_PARAM.test(decoded) && !PUBLIC_PARAM.test(decoded)
}

const maskParams = (params: string): string => {
  return params.split('&').map((param) => {
    const equal = param.indexOf('=')
    if (equal === -1 || equal === param.length - 1) return param
    return isSecretParam(param.slice(0, equal)) ? `${param.slice(0, equal)}=${HIDDEN}` : param
  }).join('&')
}

// hides the user info, the secret query parameters and the secret fragment parameters: the rest is left as it was
export const maskUrl = (url: string): string => {

  if (typeof url !== 'string') return url

  const hashIndex = url.indexOf('#')
  let fragment = hashIndex === -1 ? null : url.slice(hashIndex + 1)
  let rest = hashIndex === -1 ? url : url.slice(0, hashIndex)

  const queryIndex = rest.indexOf('?')
  let query = queryIndex === -1 ? null : rest.slice(queryIndex + 1)
  rest = queryIndex === -1 ? rest : rest.slice(0, queryIndex)

  rest = rest.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, `$1${HIDDEN}@`)
  if (query !== null) query = maskParams(query)
  if (fragment !== null && fragment.includes('=')) fragment = maskParams(fragment)

  return rest + (query !== null ? `?${query}` : '') + (fragment !== null ? `#${fragment}` : '')

}

export const maskHeaders = (headers: Record<string, string>): Record<string, string> => {
  const masked: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (isSecretHeader(name)) {
      masked[name] = HIDDEN
    } else if (URL_HEADER.test(name)) {
      masked[name] = maskUrl(value)
    } else {
      masked[name] = value
    }
  }
  return masked
}

const truncate = (text: string, maxLength: number): string => {
  if (typeof text !== 'string' || text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n*** truncated: ${text.length - maxLength} more characters ***`
}

export default (window: BrowserWindow) => {

  const ownRequests = new Set<string>()

  try {

    window.webContents.debugger.attach('1.3')
    window.webContents.debugger.sendCommand('Network.enable')
    
    window.webContents.debugger.on('message', async (_: Event, method: string, params: any) => {

      // Handle HTTP requests
      if (method === 'Network.requestWillBeSent') {
        handleHttpRequest(params)
        return
      }

      // Handle WebSocket creation
      if (method === 'Network.webSocketCreated') {
        handleWebSocketCreated(params)
        return
      }

      // Handle WebSocket handshake response
      if (method === 'Network.webSocketHandshakeResponseReceived') {
        handleWebSocketHandshake(params)
        return
      }

      // Handle WebSocket frames (sent/received)
      if (method === 'Network.webSocketFrameSent') {
        handleWebSocketFrameSent(params)
        return
      }

      if (method === 'Network.webSocketFrameReceived') {
        handleWebSocketFrameReceived(params)
        return
      }

      // Handle WebSocket closure
      if (method === 'Network.webSocketClosed') {
        handleWebSocketClosed(params)
        return
      }

      // Handle WebSocket errors
      if (method === 'Network.webSocketFrameError') {
        handleWebSocketError(params)
        return
      }

      // Handle HTTP response received
      if (method === 'Network.responseReceived') {
        handleHttpResponse(params)
        return
      }

      // Handle HTTP loading finished/failed
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        await handleHttpLoadingComplete(params, method, window)
        return
      }

    })

    // nothing more will be reported for these requests: the ones in flight would stay forever
    window.webContents.debugger.on('detach', dropRequests)

    windowRequests.add(ownRequests)

    window.on('closed', () => {
      dropRequests()
      windowRequests.delete(ownRequests)
      try {
        window.webContents.debugger.detach()
      } catch (error) {
        console.error('Error detaching debugger', error)
      }
    })

  } catch (error) {
    console.error('Error attaching network debugger', error)
  }

  // Helper functions
  function recordRequest(request: NetworkRequest) {
    requests.set(request.id, request)
    ownRequests.delete(request.id)
    ownRequests.add(request.id)
    for (const id of ownRequests) {
      if (ownRequests.size <= MAX_REQUESTS_PER_WINDOW) break
      forgetRequest(id)
    }
  }

  function forgetRequest(id: string) {
    ownRequests.delete(id)
    requests.delete(id)
  }

  function forgetRequestLater(request: NetworkRequest) {
    setTimeout(() => {
      if (requests.get(request.id) === request) {
        forgetRequest(request.id)
      }
    }, TTL)
  }

  function dropRequests() {
    for (const id of ownRequests) {
      requests.delete(id)
    }
    ownRequests.clear()
  }

  function handleHttpRequest(params: any) {
    const url = params.request.url

    // Filter URLs
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return
    }

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL && url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL)) {
      return
    }

    if (
      url.includes(`localhost:${(HttpServer.getInstance().getPort())}`) ||
      url.includes('googlefonts') ||
      url.includes('fonts.googleapis.com') ||
      url.includes('googleusercontent.com') ||
      url.includes('gstatic.com')
    ) {
      return
    }

    const { requestId, request } = params
    const networkRequest: NetworkRequest = {
      id: requestId,
      startTime: Date.now(),
      type: 'http',
      url: maskUrl(request.url),
      method: request.method,
      headers: maskHeaders(request.headers),
      postData: truncate(request.postData, MAX_BODY_LENGTH),
    }

    recordRequest(networkRequest)
    debugWindow?.webContents?.send('network', networkRequest)
  }

  function handleWebSocketCreated(params: any) {
    const { requestId, url } = params
    
    // Filter WebSocket URLs if needed
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL && url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL.replace('http', 'ws'))) {
      return
    }

    const networkRequest: NetworkRequest = {
      id: requestId,
      startTime: Date.now(),
      type: 'websocket',
      url: maskUrl(url),
      method: 'OPEN',
      headers: {},
      postData: '',
      frames: [],
    }

    recordRequest(networkRequest)
    debugWindow?.webContents?.send('network', networkRequest)
  }

  function handleWebSocketHandshake(params: any) {
    const { requestId, response } = params
    const request = requests.get(requestId)
    if (!request) return

    request.statusCode = response.status
    request.statusText = response.statusText
    request.responseHeaders = maskHeaders(response.headers)

    debugWindow?.webContents?.send('network', request)
  }

  function handleWebSocketFrameSent(params: any) {
    handleWebSocketFrame('sent', params)
  }

  function handleWebSocketFrameReceived(params: any) {
    handleWebSocketFrame('received', params)
  }

  function handleWebSocketFrame(type: 'sent' | 'received', params: any) {
    const { requestId, timestamp, response } = params
    const request = requests.get(requestId)
    if (!request) return

    request.frames.push({
      type: type,
      timestamp: timestamp,
      opcode: response.opcode,
      mask: response.mask,
      payloadData: truncate(response.payloadData, MAX_FRAME_PAYLOAD_LENGTH),
      payloadLength: response.payloadData?.length || 0
    })

    // only the most recent frames are kept
    if (request.frames.length > MAX_WEBSOCKET_FRAMES) {
      request.frames.splice(0, request.frames.length - MAX_WEBSOCKET_FRAMES)
    }

    debugWindow?.webContents?.send('network', request)
  }

  function handleWebSocketClosed(params: any) {
    const { requestId } = params
    const request = requests.get(requestId)
    if (!request) return

    request.endTime = Date.now()
    debugWindow?.webContents?.send('network', request)

    // console.log('WS Done', JSON.stringify(request))

    // Cleanup after TTL
    forgetRequestLater(request)
  }

  function handleWebSocketError(params: any) {
    const { requestId, errorMessage } = params
    const request = requests.get(requestId)
    if (!request) return

    request.errorMessage = errorMessage
    request.endTime = Date.now()
    debugWindow?.webContents?.send('network', request)

    // Cleanup after TTL
    forgetRequestLater(request)
  }

  function handleHttpResponse(params: any) {
    const { requestId } = params
    if (!requests.has(requestId)) return

    const { response } = params
    const request = requests.get(requestId)
    if (!request) return
    
    request.statusCode = response.status
    request.statusText = response.statusText
    request.responseHeaders = maskHeaders(response.headers)
    request.mimeType = response.mimeType
  }

  async function handleHttpLoadingComplete(params: any, method: string, window: BrowserWindow) {
    const { requestId } = params
    if (!requests.has(requestId)) return

    const request = requests.get(requestId)
    if (!request) return

    // For failed requests (e.g. net::ERR_CONNECTION_REFUSED), set error and end time immediately
    // so the Debug Console updates without waiting for getResponseBody (which can hang or fail).
    if (method === 'Network.loadingFailed') {
      request.errorMessage = params.errorText
      request.endTime = Date.now()
      if (request.statusCode == null) {
        request.statusCode = 0
      }
      debugWindow?.webContents?.send('network', request)
    }

    // Get response body only for successful loads; skip for loadingFailed to avoid hang/failure.
    if (method === 'Network.loadingFinished') {
      try {
        const { body, base64Encoded } = await window.webContents.debugger.sendCommand(
          'Network.getResponseBody', { requestId }
        )
        if (body.length < 256 * 1024) {
          request.responseBody = base64Encoded ? Buffer.from(body, 'base64').toString() : body
        } else {
          request.responseBody = 'Response body too large to display'
        }
      } catch (error) {
        request.responseBody = `Unable to get response body. ${error.message}`
        console.log(`Couldn't get response body for request ${requestId} ${request.url}: ${error.message}`)
      }
      request.endTime = Date.now()
      debugWindow?.webContents?.send('network', request)
    }

    // Cleanup after TTL
    forgetRequestLater(request)
  }
}

