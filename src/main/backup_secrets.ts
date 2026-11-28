
// What a backup must never hold: API keys, tokens, passwords and any other credential.
//
// A backup is a zip that travels (cloud drive, e-mail, another computer). It carries the data
// and the settings, never key material: no passphrase, no clear-text export, no ciphertext of
// the key store either. This module
// - removes key material from the JSON files of a backup (stripSecrets), on export and again
//   on restore (an older backup, or one made by hand, can hold keys in clear text)
// - puts back, in a file that is being restored, the secrets this computer already had,
//   where the restored file describes the same thing (keepLocalSecrets, keepLocalSettingsSecrets)
//
// What is recognized
// - properties whose name says they hold a credential (apiKey, clientSecret, webhookToken,
//   password...): a text is emptied, OAuth tokens and other objects of credentials are removed
// - `env` and `headers` maps (MCP servers): every value is emptied, the names are kept so that
//   the user sees what has to be entered again
// - command lines of MCP servers (`command`, `args`, and `url` which holds the arguments of a
//   stdio server): the value that follows --key, --api-key, --token..., NAME=value assignments
//   with such a name, and the value of --header
// - any text that is a URL: the user info (user:password@) and the query or fragment parameters
//   that carry a key or a token
// - any text that is a key in a well-known format, whatever the name of the property
//
// What is not looked at: the text of conversations, agent runs, scratchpads, experts and
// commands. A key the user typed in a chat is part of that chat.

import { anyDict } from 'types/index'

export type ApiKeyEntry = {
  name: string
  apiKey: string
}

// names of properties that hold a credential
const SECRET_NAME = /api[-_. ]?key|secret|token|passw|passphrase|credential|authorization|bearer|cookie|(private|access|signing|encryption|auth|license|subscription|master)[-_. ]?key/i

// names that match the pattern above and hold no credential: sizes, counts and kinds of tokens,
// and the address tokens are asked from (a url, which is searched as any url is)
const PUBLIC_NAME = /tokens?[-_. ]?(limit|count|budget|usage|type|size|window|length|endpoint|url|uri)s?$|^(max|min|num|top|budget|context|reasoning|thinking|input|output|prompt|completion|cached|total)[\w.-]*tokens?$|tokeniz/i

// properties that hold credentials as an object or a list (OAuth tokens): removed as a whole
const SECRET_CONTAINER = /^(oauth[-_. ]?)?(tokens?|credentials?|secrets?)$|^(access|refresh|id|auth|bearer|session)[-_. ]?tokens?$|^api[-_. ]?keys?$/i

// dictionaries whose keys are the names the user or a registry gave to things, not property names:
// a server called "secrets" is a server
const NAMED_ENTRIES = /^(mcpServers|mcpServersExtra|engines|plugins)$/

// maps of a name to another name: nothing to look for, and nothing that may be changed
const NAME_MAPS = ['toolMappings']

// properties whose "no value" is null and not an empty text
const NULL_WHEN_STRIPPED = ['webhookToken']

// maps of name -> value where any value can be a credential
const SECRET_MAP_NAME = /^(env|environment|headers|httpHeaders|extraHeaders|customHeaders|requestHeaders)$/i

// the address of a proxy can be typed without a scheme: user:password@host:port
const PROXY_NAME = /proxy/i
const USER_INFO = /^([a-z][a-z0-9+.-]*:\/\/)?[^/@\s]*@/i

// query and fragment parameters of a url
const SECRET_PARAM = /^(key|code|sig|pwd|auth|jwt)$|token|secret|passw|signature|credential|authorization|api[-_.]?key|[-_.]key$|[-_.]auth$|^auth[-_.]/i
const PUBLIC_PARAM = /^(max[-_]?(output[-_]?)?tokens|(next[-_]?)?page[-_]?token|token[-_]?type)$/i

// command line flags whose value is a credential (--key, --api-key, --token, --client-secret...)
const SECRET_FLAG = /^(key|pass|pwd|auth|jwt)$|api[-_.]?key|secret|token|passw|credential|authorization|bearer|cookie|[-_.]key$/i
const HEADER_FLAG = /^(H|header|headers)$/

// environment variable assignments on a command line (SMITHERY_KEY=...), on top of the names above
const SECRET_VARIABLE = /(^|_)key$/i

// keys in a well-known format: a credential whatever the property is called
const WELL_KNOWN_KEY = /^(sk-[\w-]{16,}|[sr]k_(live|test)_\w{16,}|gsk_\w{20,}|xai-\w{20,}|AIza[\w-]{30,}|gh[pousr]_\w{30,}|github_pat_\w{20,}|glpat-[\w-]{16,}|xox[abeprs]-[\w-]{10,}|hf_\w{20,}|r8_\w{20,}|pplx-\w{20,}|tvly-[\w-]{16,}|nvapi-[\w-]{20,}|AKIA[0-9A-Z]{16}|ya29\.[\w.-]{20,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*)$/

const SINGLE_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i
const COMMAND_TOKEN = /"[^"]*"|'[^']*'|\S+/g

const SERVER_TYPES = ['stdio', 'sse', 'http']
const SERVER_IDENTITY = ['type', 'command', 'args', 'url', 'cwd']

const isPlainObject = (value: unknown): value is anyDict => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const has = (object: anyDict, key: string): boolean => {
  return Object.prototype.hasOwnProperty.call(object, key)
}

const clone = <T>(value: T): T => {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => has(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

export const isSecretName = (name: string): boolean => {
  return SECRET_NAME.test(name) && !PUBLIC_NAME.test(name)
}

const isSecretParam = (name: string): boolean => {
  let decoded = name
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, ' '))
  } catch { /* keep the raw name */ }
  decoded = decoded.trim()
  return SECRET_PARAM.test(decoded) && !PUBLIC_PARAM.test(decoded)
}

const redactParams = (params: string): string => {
  return params.split('&').map((param) => {
    const equal = param.indexOf('=')
    if (equal === -1 || equal === param.length - 1) return param
    return isSecretParam(param.slice(0, equal)) ? param.slice(0, equal + 1) : param
  }).join('&')
}

/**
 * A url without its user info and without the value of the parameters that carry a credential.
 * Done on the text, not with URL: what is not a secret stays exactly as the user typed it.
 */
export const redactUrl = (url: string): string => {

  if (!SINGLE_URL.test(url)) return url

  const hashIndex = url.indexOf('#')
  let fragment = hashIndex === -1 ? null : url.slice(hashIndex + 1)
  let rest = hashIndex === -1 ? url : url.slice(0, hashIndex)

  const queryIndex = rest.indexOf('?')
  let query = queryIndex === -1 ? null : rest.slice(queryIndex + 1)
  rest = queryIndex === -1 ? rest : rest.slice(0, queryIndex)

  rest = rest.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1')
  if (query !== null) query = redactParams(query)
  if (fragment !== null && fragment.includes('=')) fragment = redactParams(fragment)

  return rest + (query !== null ? `?${query}` : '') + (fragment !== null ? `#${fragment}` : '')

}

// a text that is not a credential by its name: emptied when its content says it is one
const redactValue = (text: string): string => {
  if (WELL_KNOWN_KEY.test(text.trim())) return ''
  return redactUrl(text)
}

// "Authorization: Bearer xyz" -> "Authorization: "
const redactHeader = (header: string): string => {
  const colon = header.indexOf(':')
  return colon === -1 ? redactValue(header) : `${header.slice(0, colon + 1)} `
}

const unquote = (token: string): { quote: string, body: string } => {
  const quote = token.length >= 2 && (token[0] === '"' || token[0] === '\'') && token[token.length - 1] === token[0] ? token[0] : ''
  return { quote, body: quote ? token.slice(1, -1) : token }
}

/**
 * The arguments of a command without the credentials they carry.
 * The list keeps its length: a value that is removed becomes an empty text.
 */
export const redactArgs = (args: string[]): string[] => {

  let expects: 'value' | 'header' | null = null

  return args.map((arg) => {

    if (typeof arg !== 'string') return arg
    const { quote, body } = unquote(arg)
    const quoted = (text: string) => `${quote}${text}${quote}`

    // what follows a flag such as --key, even when it looks like a flag itself: a key can start with a dash
    if (expects === 'value') {
      expects = null
      return ''
    }
    if (expects === 'header') {
      expects = null
      return quoted(redactHeader(body))
    }

    // --flag, --flag=value
    const flag = body.match(/^(--?)([A-Za-z0-9][\w.-]*)(?:=([\s\S]*))?$/)
    if (flag) {
      const [, dashes, name, value] = flag
      const isHeader = HEADER_FLAG.test(name)
      const isSecret = !isHeader && SECRET_FLAG.test(name)
      if (value === undefined) {
        expects = isHeader ? 'header' : isSecret ? 'value' : null
        return arg
      }
      if (isHeader) return quoted(`${dashes}${name}=${redactHeader(value)}`)
      if (isSecret) return quoted(`${dashes}${name}=`)
      return quoted(`${dashes}${name}=${redactValue(value)}`)
    }

    // NAME=value
    const variable = body.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/)
    if (variable) {
      const [, name, value] = variable
      if (isSecretName(name) || SECRET_VARIABLE.test(name)) return quoted(`${name}=`)
      return quoted(`${name}=${redactValue(value)}`)
    }

    return body.length ? quoted(redactValue(body)) : arg

  })

}

/**
 * Same for a command line held in one text. Untouched when there is nothing to remove.
 */
export const redactCommandLine = (line: string): string => {
  const tokens = line.match(COMMAND_TOKEN) ?? []
  const redacted = redactArgs(tokens)
  if (redacted.every((token, index) => token === tokens[index])) return line
  return redacted.filter((token, index) => token === tokens[index] || unquote(token).body !== '').join(' ')
}

// an entry that starts a program or connects to a server (MCP servers in their two formats)
const isServer = (value: unknown): boolean => {
  return isPlainObject(value) && (typeof value.command === 'string' || Array.isArray(value.args) || SERVER_TYPES.includes(value.type))
}

const REMOVED = Symbol('removed')

type Parent = {
  object: unknown        // the object or the list that holds the value
  name: string | null    // the name of that object in its own parent
}

const stripValue = (value: unknown, key: string | null, parent: Parent, blank: boolean): unknown => {

  // inside an env or headers map: every value goes
  if (blank) {
    if (typeof value === 'string') return ''
    if (Array.isArray(value)) return value.map((item) => stripValue(item, null, { object: value, name: key }, true))
    if (isPlainObject(value)) return stripObject(value, key, true)
    return value
  }

  if (key !== null) {

    // names mapped to names
    if (NAME_MAPS.includes(key)) {
      return clone(value)
    }

    // by name
    if (isSecretName(key)) {
      if (typeof value === 'string') return NULL_WHEN_STRIPPED.includes(key) ? null : ''
      const namedEntry = parent.name !== null && NAMED_ENTRIES.test(parent.name)
      if (typeof value === 'object' && value !== null && SECRET_CONTAINER.test(key) && !namedEntry) return REMOVED
    }

    // maps of credentials
    if (SECRET_MAP_NAME.test(key) && isPlainObject(value)) {
      return stripObject(value, key, true)
    }

    // proxies
    if (PROXY_NAME.test(key) && typeof value === 'string') {
      return redactValue(value.replace(USER_INFO, '$1'))
    }

    // command lines
    if (isServer(parent.object) && ['command', 'args', 'url'].includes(key)) {
      if (typeof value === 'string') return redactCommandLine(value)
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return redactArgs(value)
    }

  }

  // by content
  if (typeof value === 'string') return redactValue(value)
  if (Array.isArray(value)) return value.map((item) => stripValue(item, null, { object: value, name: key }, false))
  if (isPlainObject(value)) return stripObject(value, key, false)
  return value

}

const stripObject = (object: anyDict, name: string | null, blank: boolean): anyDict => {
  const result: anyDict = {}
  for (const key of Object.keys(object)) {
    const value = stripValue(object[key], key, { object, name }, blank)
    if (value !== REMOVED) result[key] = value
  }
  return result
}

/**
 * A copy of a parsed JSON file (settings.json, workspace.json, an agent) without any key material.
 */
export const stripSecrets = <T>(json: T): T => {
  return stripValue(json, null, { object: null, name: null }, false) as T
}

const stableId = (item: unknown): string | null => {
  if (!isPlainObject(item)) return null
  for (const key of ['uuid', 'id', 'registryId']) {
    if (typeof item[key] === 'string' && item[key].length) return `${key}:${item[key]}`
  }
  return null
}

// a credential is only good for what it was entered for: the program or the server must be the same
const sameServer = (a: anyDict, b: anyDict): boolean => {
  return SERVER_IDENTITY.every((key) => deepEqual(a[key], b[key]))
}

// the secret and the tokens of an OAuth client are for that client and no other
const isOAuthClient = (value: unknown): boolean => {
  return isPlainObject(value) && (has(value, 'clientId') || has(value, 'clientSecret'))
}

// restored: what the backup holds, without secrets
// clean and raw: what this computer has, without and with its secrets
const carry = (restored: unknown, clean: unknown, raw: unknown): unknown => {

  if (Array.isArray(restored)) {
    if (!Array.isArray(clean) || !Array.isArray(raw) || clean.length !== raw.length) return restored

    // a list of things: each one is matched with the local one that has the same id
    if (restored.every((item) => isPlainObject(item))) {
      return restored.map((item) => {
        const id = stableId(item)
        if (id === null) return item
        const index = clean.findIndex((candidate) => stableId(candidate) === id)
        return index === -1 ? item : carry(item, clean[index], raw[index])
      })
    }

    // a list of values (the arguments of a command): all or nothing
    return deepEqual(restored, clean) ? clone(raw) : restored
  }

  if (isPlainObject(restored)) {
    if (!isPlainObject(clean) || !isPlainObject(raw)) return restored
    if ((isServer(restored) || isServer(clean)) && !sameServer(restored, clean)) return restored
    if ((isOAuthClient(restored) || isOAuthClient(clean)) && !deepEqual(restored, clean)) return restored

    const result: anyDict = {}
    for (const key of Object.keys(restored)) {
      result[key] = has(clean, key) && has(raw, key) ? carry(restored[key], clean[key], raw[key]) : restored[key]
    }

    // what was removed as a whole (OAuth tokens) comes back when everything else is identical
    const removed = Object.keys(raw).filter((key) => !has(clean, key) && !has(restored, key))
    if (removed.length && deepEqual(restored, clean)) {
      for (const key of removed) result[key] = clone(raw[key])
    }
    return result
  }

  // a value: the local one, when the restored value is what the local one is without its secret
  return restored === clean && raw !== clean ? raw : restored

}

/**
 * Puts the secrets of the local file back in the file that replaces it, wherever both describe the
 * same thing: same place in the file (list items are matched by uuid or id), same content once the
 * secrets are removed, and for anything that starts a program or connects to a server, same command
 * and same address. `restored` is first stripped of any secret of its own: nothing is ever imported.
 */
export const keepLocalSecrets = <T>(restored: T, local: unknown): T => {
  const stripped = stripSecrets(restored)
  if (!isPlainObject(stripped) || !isPlainObject(local)) return stripped
  const restoredId = stableId(stripped)
  const localId = stableId(local)
  if (restoredId !== null && localId !== null && restoredId !== localId) return stripped
  return carry(stripped, stripSecrets(local), local) as T
}

const getAtPath = (object: unknown, parts: string[]): unknown => {
  let current: unknown = object
  for (const part of parts) {
    if (!isPlainObject(current)) return undefined
    current = current[part]
  }
  return current
}

const setAtPath = (object: anyDict, parts: string[], value: unknown): void => {
  let current = object
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current[part])) current[part] = {}
    current = current[part]
  }
  current[parts[parts.length - 1]] = value
}

// true when the path goes through an entry that starts a program or connects to a server
const isInsideServer = (object: anyDict, parts: string[]): boolean => {
  let current: unknown = object
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current)) return false
    current = current[part]
    if (isServer(current)) return true
  }
  return false
}

/**
 * Same as keepLocalSecrets for settings.json, which also holds what the key store manages.
 * - localKeys: the API keys found in the local settings file (safe storage off, or keys that could not be stored)
 * - storedKeyNames: the names of the keys of the key store, which a restore never touches
 * - defaults: the default settings
 *
 * A key of this computer is found by its place in the settings (engines.openai.apiKey). The keys of the
 * key store are put there when the settings are loaded; the ones of the local file are put there now.
 * An engine or a server that owns a key, exists only on this computer and is not a standard one
 * (a custom engine) is kept with its key: without this the key would come back alone, as an entry
 * that has a key and nothing else.
 */
export const keepLocalSettingsSecrets = (restored: anyDict, local: anyDict, localKeys: ApiKeyEntry[], storedKeyNames: string[], defaults: anyDict): anyDict => {

  // an OAuth configuration kept apart from its server (mcpServersExtra) follows that server
  const comparable = clone(local)
  const localServers = isPlainObject(local.mcpServers) ? local.mcpServers : {}
  const restoredServers = isPlainObject(restored?.mcpServers) ? restored.mcpServers : {}
  if (isPlainObject(comparable.mcp?.mcpServersExtra)) {
    for (const name of Object.keys(comparable.mcp.mcpServersExtra)) {
      const same = isPlainObject(localServers[name]) && isPlainObject(restoredServers[name])
        && sameServer(stripSecrets(restoredServers[name]), stripSecrets(localServers[name]))
      if (!same) delete comparable.mcp.mcpServersExtra[name]
    }
  }

  const result = keepLocalSecrets(restored, comparable)
  if (!isPlainObject(result)) return result

  // entries that exist only here and own a key
  const plainKeys = localKeys.filter((entry) => typeof entry.apiKey === 'string' && entry.apiKey.length > 0)
  for (const name of [...storedKeyNames, ...plainKeys.map((entry) => entry.name)]) {
    const parts = name.split('.')
    if (parts.length < 3) continue
    const owner = parts.slice(0, 2)
    if (!isPlainObject(getAtPath(local, owner))) continue
    if (isPlainObject(getAtPath(result, owner)) || isPlainObject(getAtPath(defaults, owner))) continue
    setAtPath(result, owner, clone(getAtPath(local, owner)))
    // the state of such a server (disabled, tool selection) is kept apart
    const extra = ['mcp', 'mcpServersExtra', owner[1]]
    if (owner[0] === 'mcpServers' && isPlainObject(getAtPath(local, extra)) && !isPlainObject(getAtPath(result, extra))) {
      setAtPath(result, extra, clone(getAtPath(local, extra)))
    }
  }

  // the keys of the local settings file. inside a server entry, what is kept was decided above
  for (const entry of plainKeys) {
    const parts = entry.name.split('.')
    if (!isInsideServer(result, parts)) {
      setAtPath(result, parts, entry.apiKey)
    }
  }

  // where this computer keeps its keys is not a setting of the backup
  const usesKeyStore = (settings: anyDict): boolean => !isPlainObject(settings.general) || settings.general.safeKeys !== false
  if (usesKeyStore(result) !== usesKeyStore(local)) {
    if (!isPlainObject(result.general)) result.general = {}
    result.general.safeKeys = usesKeyStore(local)
  }

  return result

}
