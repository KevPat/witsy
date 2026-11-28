
/**
 * What runs inside the Python sandbox window (see ./pyodide.ts).
 *
 * The window is a Chromium renderer created with `sandbox: true`, no preload and no Node.js
 * integration. Everything here is served to it by the main process from a made-up https origin
 * that never reaches the network.
 */

// `.invalid` never resolves (RFC 6761), and the session of the sandbox answers this origin itself
export const kSandboxOrigin = 'https://pyodide-sandbox.witsy.invalid'

export const kSandboxPagePath = '/index.html'
export const kSandboxRunnerPath = '/runner.js'

// name of the object the runner installs on the page, called through webContents.executeJavaScript
export const kSandboxApi = 'witsyPyodide'

// Scripts and downloads only from the sandbox origin, no eval: `Function("...")`, the usual way
// from a JavaScript object to the global object of its realm, is refused by the page itself.
// WebAssembly compilation is what Pyodide is made of and has to be allowed.
export const kSandboxCsp = [
  `default-src 'none'`,
  `script-src 'self' 'wasm-unsafe-eval'`,
  `connect-src 'self'`,
  `worker-src 'none'`,
  `base-uri 'none'`,
  `form-action 'none'`,
].join('; ')

export const kSandboxPage = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Witsy Python sandbox</title>
</head>
<body>
<script src="pyodide.js"></script>
<script src="runner.js"></script>
</body>
</html>
`

/**
 * Plain JavaScript, sent as text: it is not bundled with the app and must not reference anything
 * but `loadPyodide` (defined by pyodide.js) and `globalThis`.
 *
 * - init(packages) loads the runtime once. Python gets an empty object as its `js` module.
 * - run(script) resolves to { result } or { error }, both strings.
 */
export const kSandboxRunner = `(() => {
  'use strict'

  let pyodide = null
  let loading = null

  const describe = (error) => error instanceof Error ? error.message : String(error)

  const init = async (packages) => {
    if (!loading) {
      loading = loadPyodide({ packages, jsglobals: Object.create(null) })
      loading.catch(() => { loading = null })
    }
    pyodide = await loading
    return true
  }

  const run = async (script) => {
    try {

      if (!pyodide) {
        throw new Error('Pyodide is not initialized')
      }

      // capture stdout
      const stdoutLines = []
      pyodide.setStdout({ batched: (msg) => stdoutLines.push(msg) })

      const result = await pyodide.runPythonAsync(script)

      // use the value of the last expression if there is one, what was printed otherwise
      let resultStr
      const stdoutOutput = stdoutLines.join('\\n')
      if (result === undefined || result === null) {
        resultStr = stdoutOutput || String(result)
      } else if (typeof result === 'object') {
        try {
          resultStr = JSON.stringify(result, null, 2)
        } catch {
          resultStr = String(result)
        }
      } else {
        resultStr = String(result)
      }

      return { result: String(resultStr) }

    } catch (error) {
      return { error: describe(error) }
    }
  }

  Object.defineProperty(globalThis, '${kSandboxApi}', { value: Object.freeze({ init, run }) })

})()
`
