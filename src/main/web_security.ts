
import { protocol, session, Session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { kArtifactContentMessage, kArtifactFrameUrl, kArtifactReadyMessage, kArtifactScheme } from '../consts'
import { isPathInside } from './path_containment'

// What stands between web content and the windows of the app (S-14).
//
// 1. The page of the app has a content security policy (index.html): scripts come from the app
//    itself and from the few places listed there, never from the markup of a message. Inline
//    scripts, inline event handlers and javascript: urls do not run.
//
// 2. An html artifact is a page that must run its own inline scripts. A srcdoc, data: or blob:
//    frame inherits the policy of the page that creates it, so the artifact is loaded from a
//    scheme of its own instead: witsy-artifact://frame/ is a fixed page, served below, that has
//    no policy and writes the html the app posts to it. The frame keeps its sandbox attribute:
//    its origin is opaque and it only exchanges messages with the app.
//
// 3. On a file: page the 'self' of a policy is every local file: Chromium has no way to name a
//    folder. The packaged app is such a page, so the main process refuses the scripts that are
//    not in the folder of the app (installLocalScriptGuard).
//
// 4. Web security is on for the packaged app (windows/index.ts). Electron gives a file: page
//    access to other origins whatever this setting is, which is what lets the app call the model
//    providers and read local images in a canvas. With it off, a frame that is not the app could
//    read local files too: an html artifact could, from inside its sandbox. It no longer can.
//    tools/web_security_probe.cjs checks all of this in a real Electron: run it again when
//    Electron is upgraded.

/**
 * The page html artifacts are loaded in. It waits for the html of the artifact, sent by the app
 * (its parent), and becomes that page. Nothing in it comes from the artifact or from the request.
 */
export const kArtifactFramePage = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script>
(() => {
  const onMessage = (event) => {
    const data = event.data;
    if (event.source !== window.parent || !data || data.type !== '${kArtifactContentMessage}' || typeof data.html !== 'string') return;
    window.removeEventListener('message', onMessage);
    document.open();
    document.write(data.html);
    document.close();
  };
  window.addEventListener('message', onMessage);
  window.parent.postMessage({ type: '${kArtifactReadyMessage}' }, '*');
})();
</script>
</head>
<body></body>
</html>
`

const respond = (status: number, body: string | null = null, headers: Record<string, string> = {}): Response => {
  return new Response(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  })
}

/**
 * Must be called before the app is ready, and only once per process (Electron keeps the last call).
 * `standard` gives the scheme real urls and origins; `secure` keeps the artifact a secure context,
 * as it was in a srcdoc frame of the app.
 */
export const registerPrivilegedSchemes = (): void => {
  protocol.registerSchemesAsPrivileged([
    { scheme: kArtifactScheme, privileges: { standard: true, secure: true } },
  ])
}

/**
 * Answers witsy-artifact://frame/ with the fixed page above and nothing else.
 */
export const handleArtifactRequest = (request: { url: string, method: string }): Response => {
  try {
    const url = new URL(request.url)
    const frame = new URL(kArtifactFrameUrl)
    if (url.protocol !== frame.protocol || url.host !== frame.host || url.pathname !== frame.pathname) {
      return respond(404)
    }
    if (request.method !== 'GET') {
      return respond(405, null, { 'Allow': 'GET' })
    }
    return respond(200, kArtifactFramePage, { 'Content-Type': 'text/html; charset=utf-8' })
  } catch {
    return respond(400)
  }
}

/**
 * True when a script may be loaded from this url as far as local files are concerned:
 * anything that is not a file: url is left to the content security policy of the page,
 * a local file must be in the folder of the app (`appFolder`), a file on a share never is.
 */
export const isAllowedScriptUrl = (url: string, appFolder: string): boolean => {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (target.protocol !== 'file:') {
    return true
  }
  if (target.host !== '') {
    return false
  }
  try {
    return isPathInside(fileURLToPath(target), appFolder)
  } catch {
    return false
  }
}

/**
 * Cancels the scripts (classic, module and imported) that a page of this session asks for from
 * a local file outside `appFolder`. Images, media, styles and fetches of local files are not
 * touched. A session has one listener per webRequest event: this one owns `onBeforeRequest`
 * of the session it is installed on.
 */
export const installLocalScriptGuard = (ses: Session, appFolder: string): void => {
  ses.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
    if (details.resourceType === 'script' && !isAllowedScriptUrl(details.url, appFolder)) {
      console.warn('[security] refused to load a script that is not part of the app:', details.url)
      callback({ cancel: true })
      return
    }
    callback({})
  })
}

/**
 * The folder the packaged page of the app and its scripts are in.
 */
export const appRendererFolder = (): string => path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`)

/**
 * To be called once, when the app is ready and before any window is created.
 * With the dev server the page is not a file: its policy already limits scripts to that server.
 */
export const installWebSecurity = (ses: Session = session.defaultSession): void => {
  ses.protocol.handle(kArtifactScheme, handleArtifactRequest)
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    installLocalScriptGuard(ses, appRendererFolder())
  }
}
