
import { safeStorage } from 'electron'
import { anyDict } from 'types/index'

// MCP server secrets are encrypted in place in settings.json:
// enc:v1:<base64 of safeStorage.encryptString(SECRET_MARKER + value)>
export const MCP_SECRET_PREFIX = 'enc:v1:'

// a wrong key can decrypt to garbage without an error: the marker tells a real value from garbage
const SECRET_MARKER = 'mcp:'

const PUBLIC_TOKEN_FIELDS = ['token_type', 'scope']

type SecretSlot = { holder: anyDict, key: string }

const isObject = (value: unknown): value is anyDict => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const entries = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (isObject(value)) return Object.values(value)
  return []
}

const isEncrypted = (value: unknown): value is string => {
  return typeof value === 'string' && value.startsWith(MCP_SECRET_PREFIX)
}

const isClearText = (value: unknown): value is string => {
  return typeof value === 'string' && value.length > 0 && !value.startsWith(MCP_SECRET_PREFIX)
}

const serverSlots = (server: unknown, inKeyStoreScope: boolean): SecretSlot[] => {

  const slots: SecretSlot[] = []
  if (!isObject(server)) return slots

  for (const field of ['env', 'headers']) {
    const holder = server[field]
    if (!isObject(holder)) continue
    for (const key of Object.keys(holder)) {
      // these ones are moved to the API key store by extractApiKeys: they are left to it
      if (inKeyStoreScope && key.toLowerCase().includes('apikey')) continue
      slots.push({ holder, key })
    }
  }

  const oauth = server.oauth
  if (isObject(oauth)) {
    slots.push({ holder: oauth, key: 'clientSecret' })
    if (isObject(oauth.tokens)) {
      for (const key of Object.keys(oauth.tokens)) {
        if (!PUBLIC_TOKEN_FIELDS.includes(key)) {
          slots.push({ holder: oauth.tokens, key })
        }
      }
    } else {
      slots.push({ holder: oauth, key: 'tokens' })
    }
  }

  return slots

}

// every place of the settings where a MCP server secret can be found
const secretSlots = (config: unknown): SecretSlot[] => {
  if (!isObject(config)) return []
  const mcp = isObject(config.mcp) ? config.mcp : {}
  const legacy = isObject(config.plugins) && isObject(config.plugins.mcp) ? config.plugins.mcp : {}
  return [
    ...entries(mcp.servers).flatMap((server) => serverSlots(server, false)),
    ...entries(legacy.servers).flatMap((server) => serverSlots(server, false)),
    ...entries(mcp.mcpServersExtra).flatMap((server) => serverSlots(server, true)),
    ...entries(config.mcpServers).flatMap((server) => serverSlots(server, true)),
  ]
}

const encrypt = (value: string): string | null => {
  try {
    const plain = SECRET_MARKER + value
    const encrypted = safeStorage.encryptString(plain)
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) return null
    // never write something that cannot be read back
    if (safeStorage.decryptString(encrypted) !== plain) return null
    return MCP_SECRET_PREFIX + encrypted.toString('base64')
  } catch {
    return null
  }
}

const decrypt = (value: string): string | null => {
  try {
    const encrypted = Buffer.from(value.slice(MCP_SECRET_PREFIX.length), 'base64')
    const plain = safeStorage.decryptString(encrypted)
    if (typeof plain !== 'string' || !plain.startsWith(SECRET_MARKER)) return null
    return plain.slice(SECRET_MARKER.length)
  } catch {
    return null
  }
}

const isEncryptionAvailable = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable() === true
  } catch {
    return false
  }
}

// to be called on the object written to settings.json, never on the configuration used by the app.
// a value that cannot be encrypted is left in clear text: nothing is ever dropped
export const protectMcpSecrets = (config: unknown): void => {
  try {
    if (!isEncryptionAvailable()) return
    let failed = 0
    for (const { holder, key } of secretSlots(config)) {
      const value = holder[key]
      if (!isClearText(value)) continue
      const encrypted = encrypt(value)
      if (encrypted === null) {
        failed++
      } else {
        holder[key] = encrypted
      }
    }
    if (failed > 0) {
      console.warn(`[mcp] ${failed} MCP server secret(s) could not be encrypted and are saved in clear text`)
    }
  } catch (error) {
    console.warn('[mcp] Error protecting MCP server secrets:', error?.message)
  }
}

// to be called on the object parsed from settings.json.
// a value that cannot be decrypted is left as it is: it is saved back unchanged and can be decrypted later
export const revealMcpSecrets = (config: unknown): void => {
  try {
    let failed = 0
    for (const { holder, key } of secretSlots(config)) {
      const value = holder[key]
      if (!isEncrypted(value)) continue
      const decrypted = decrypt(value)
      if (decrypted === null) {
        failed++
      } else {
        holder[key] = decrypted
      }
    }
    if (failed > 0) {
      console.warn(`[mcp] ${failed} MCP server secret(s) could not be decrypted and are kept encrypted`)
    }
  } catch (error) {
    console.warn('[mcp] Error revealing MCP server secrets:', error?.message)
  }
}

// true when settings.json holds MCP server secrets in clear text while they should, and can all, be encrypted:
// saving again when one of them cannot be encrypted would rewrite the file on every load
export const hasUnprotectedMcpSecrets = (config: unknown): boolean => {
  try {
    if (!isObject(config)) return false
    if (isObject(config.general) && config.general.safeKeys === false) return false
    const clearTexts = secretSlots(config).map(({ holder, key }) => holder[key]).filter(isClearText)
    if (clearTexts.length === 0 || !isEncryptionAvailable()) return false
    return clearTexts.every((value) => encrypt(value) !== null)
  } catch {
    return false
  }
}
