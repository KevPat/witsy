
import { App, safeStorage } from 'electron'
import Store from 'electron-store'
import fs from 'fs'
import path from 'path'
import { Configuration } from 'types/config'
import { anyDict, ApiKeyStorageStatus } from 'types/index'
import defaultSettings from '@root/defaults/settings.json'
import { favoriteMockEngine } from '../renderer/services/llms/llm'
import Monitor from './monitor'
import { writeFileAtomicSync } from './atomic'
import { hasUnprotectedMcpSecrets, protectMcpSecrets, revealMcpSecrets } from './mcp_secrets'

type ApiKeyEntry = {
  name: string
  apiKey: string
}

let saveConfigInTest = false
export const setSaveConfigInTests = () => {
  saveConfigInTest = true
}

const isPlainObject = (value: unknown): boolean => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let errorLoadingConfig = false
let lastBackedUpData: string|null = null
let onSettingsChange: CallableFunction = () => {}
let cachedAppConfig: Configuration = undefined

const safeStore = new Store<Record<string, string>>({
  name: process.env.DEBUG ? 'apiKeys-debug' : 'apiKeys',
  accessPropertiesByDotNotation: false,
  watch: false,
  encryptionKey: 'witsy',
});

const monitor: Monitor = new Monitor(() => {
  cachedAppConfig = undefined
  onSettingsChange()
})

export const setOnSettingsChange = (callback: CallableFunction) => {
  onSettingsChange = callback
}

export const settingsFilePath = (app: App): string => {
  const userDataPath = app.getPath('userData')
  const settingsFilePath = path.join(userDataPath, 'settings.json')
  return settingsFilePath
}

export const apiKeysFilePath = (app: App): string => {
  const userDataPath = app.getPath('userData')
  const apiKeysFilePath = path.join(userDataPath, 'apiKeys.json')
  return apiKeysFilePath
}

const engineConfigFilePath = (app: App, engine: string): string => {
  const userDataPath = app.getPath('userData')
  const engineModelsFilePath = path.join(userDataPath, 'engines')
  fs.mkdirSync(engineModelsFilePath, { recursive: true })
  return path.join(engineModelsFilePath, `${engine}.json`)
}

export const settingsFileHadError = (): boolean => errorLoadingConfig

export const clearAppSettingsCache = (): void => {
  cachedAppConfig = undefined
}

export const loadSettings = (app: App): Configuration => {

  // check cache
  if (cachedAppConfig) {
    return JSON.parse(JSON.stringify(cachedAppConfig))
  }

  let data = '{}'
  const settingsFile = settingsFilePath(app)
  const firstLoad = typeof cachedAppConfig === 'undefined'
  if (firstLoad) {
    console.log('Loading settings from', settingsFile)
  }

  let save = true
  try {
    data = fs.readFileSync(settingsFile, 'utf-8')
    save = false
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.log('Error retrieving settings data', error)
    }
  }

  // now try to parse
  let jsonConfig = null 
  try {
    jsonConfig = JSON.parse(data)
    if (!isPlainObject(jsonConfig)) {
      throw new Error('Settings data is not a JSON object')
    }
  } catch (error) {

    // log
    console.log('Error parsing settings data', error)

    // save a backup before starting from scratch
    if (firstLoad || data !== lastBackedUpData) {
      const now = new Date()
      const timestamp = now.getFullYear() + 
               ('0' + (now.getMonth() + 1)).slice(-2) + 
               ('0' + now.getDate()).slice(-2) + 
               ('0' + now.getHours()).slice(-2) + 
               ('0' + now.getMinutes()).slice(-2) + 
               ('0' + now.getSeconds()).slice(-2)
      const backupFile = settingsFile.replace('.json', `.${timestamp}.json`)
      try {
        console.log('Saving backup of settings to', backupFile)
        fs.writeFileSync(backupFile, data)
        lastBackedUpData = data
      } catch (backupError) {
        console.log('Error saving backup of settings', backupError)
      }
    }

    // start with defaults
    errorLoadingConfig = true
    jsonConfig = {}

  }

  // mcp secrets are encrypted in place: a file that has them in clear text is saved again
  if (hasUnprotectedMcpSecrets(jsonConfig)) save = true
  revealMcpSecrets(jsonConfig)

  // safe keys handling (default is true even when we have no config...)
  // stored keys are injected wherever the settings file has no value of its own:
  // a key found in the file (typed by hand, or left there because it could not be encrypted)
  // must never make the other stored keys disappear
  const safeKeys = !isPlainObject(jsonConfig.general) || jsonConfig.general.safeKeys !== false
  const storedKeys = loadApiKeys()
  const plainKeys = extractApiKeys(jsonConfig).filter((entry) => entry.apiKey.length > 0)
  const plainNames = new Set(plainKeys.map((entry) => entry.name))
  injectApiKeys(jsonConfig, storedKeys.filter((entry) => !plainNames.has(entry.name)))
  if (safeKeys ? plainKeys.length > 0 : storedKeys.length > 0) {
    // saving moves the keys to where they belong: the key store or the settings file
    save = true
  }

  // now load engine models
  if (isPlainObject(jsonConfig.engines)) {
    
    for (const engine of Object.keys(jsonConfig.engines)) {

      // wrong shape: buildConfig restores the default
      if (!isPlainObject(jsonConfig.engines[engine])) {
        continue
      }

      // initialize models
      if (!jsonConfig.engines[engine].models) {
        jsonConfig.engines[engine].models = { chat: [] } 
      }

      // now load the models file
      const engineConfigFile = engineConfigFilePath(app, engine)
      if (fs.existsSync(engineConfigFile)) {
        try {
          const engineConfig = fs.readFileSync(engineConfigFile, 'utf-8')
          jsonConfig.engines[engine] = {
            ...jsonConfig.engines[engine],
            ...JSON.parse(engineConfig)
          }
        } catch (error) {
          console.log('Error loading engine models for', engine, error)
        }
      }

    }
  }

  // now build config
  const config = buildConfig(defaultSettings, jsonConfig)

  // save if needed
  if (save && (!process.env.TEST || saveConfigInTest)) {
    saveSettings(app, config)
  }

  // start monitoring
  monitor.start(settingsFile)

  // done
  cachedAppConfig = JSON.parse(JSON.stringify(config))
  return config
}

export const saveSettings = (app: App, config: Configuration, always: boolean = false): void => {
  try {

    // nullify defaults
    nullifyDefaults(config)

    // // debug
    // const jsonCached = JSON.stringify(cachedAppConfig)
    // const jsonConfig = JSON.stringify(config)
    // for (let i=0; i<Math.min(jsonCached.length, jsonConfig.length); i++) {
    //   if (jsonCached[i] !== jsonConfig[i]) {
    //     console.debug(`[main] config difference at index ${i}:`,
    //       '\nCached: ' + jsonCached.substring(Math.max(0, i - 64), Math.min(i + 64, jsonCached.length)),
    //       '\nConfig: ' + jsonConfig.substring(Math.max(0, i - 64), Math.min(i + 64, jsonConfig.length)),
    //     )
    //     break
    //   }
    // }

    // only if modified
    if (!always && cachedAppConfig) {
      if (JSON.stringify(cachedAppConfig) === JSON.stringify(config)) {
        return
      }
    }

    // update cache
    cachedAppConfig = JSON.parse(JSON.stringify(config))

    // make a copy
    const clone: Configuration = JSON.parse(JSON.stringify(config))

    // save api keys separately: only the keys that made it to the key store are removed from the settings file
    if (config.general.safeKeys) {
      const apiKeys = extractApiKeys(clone)
      if (apiKeys.length > 0) {
        const result = storeApiKeys(apiKeys)
        if (result) {
          nullifyApiKeys(clone, apiKeys.filter((entry) => !result.failed.includes(entry)))
        }
      }
    }

    // save engines configuration separately
    for (const engine of Object.keys(clone.engines)) {

      // skip the favorite mock engine
      if (engine === favoriteMockEngine) {
        continue
      }

      // clone user data
      const engineConfig = {
        models: clone.engines[engine].models,
        voices: clone.engines[engine].voices,
      }

      // now save it
      const engineConfigFile = engineConfigFilePath(app, engine)
      writeFileAtomicSync(engineConfigFile, JSON.stringify(engineConfig, null, 2))

      // clear clone
      delete clone.engines[engine].models
      delete clone.engines[engine].voices

    }

    // mcp secrets are encrypted in place, once the api keys have left the clone
    if (config.general.safeKeys) protectMcpSecrets(clone)

    // save
    const settingsFile = settingsFilePath(app)
    writeFileAtomicSync(settingsFile, JSON.stringify(clone, null, 2))

    // the keys leave the key store only once they are safely in the settings file
    if (!config.general.safeKeys) {
      deleteApiKeys()
    }

  } catch (error) {
    console.log('Error saving settings data', error)
  }
}

const mergeConfig = (defaults: anyDict, overrides: anyDict): Configuration => {

  const result = JSON.parse(JSON.stringify(defaults))
  
  Object.keys(overrides).forEach(key => {

    if (typeof defaults[key] === 'object' && typeof overrides[key] === 'object'
      && !Array.isArray(overrides[key]) && overrides[key] !== null
      && !Array.isArray(defaults[key]) && defaults[key] !== null) {
      result[key] = mergeConfig(defaults[key], overrides[key])
    } else {
      result[key] = overrides[key]
    }
  })

  return result
}

// valid JSON of the wrong shape (a section set to null, to a text, to a list...) would throw
// at launch, before any window can report it: such a section is replaced by its default
const restoreInvalidSections = (config: anyDict, defaults: anyDict): void => {

  const restore = (parent: anyDict, parentDefaults: anyDict, key: string, label: string) => {
    const expected = parentDefaults?.[key]
    const valid = Array.isArray(expected) ? Array.isArray(parent[key]) : isPlainObject(parent[key])
    if (valid) return
    console.log(`Invalid settings section ${label}: restoring defaults`)
    if (expected === undefined) {
      delete parent[key]
    } else {
      parent[key] = JSON.parse(JSON.stringify(expected))
    }
  }

  // top-level sections
  for (const key of Object.keys(defaults)) {
    if (isPlainObject(defaults[key])) {
      restore(config, defaults, key, key)
    }
  }

  // engines: also the ones that are not in the defaults (custom engines)
  for (const engine of Object.keys(config.engines)) {
    restore(config.engines, defaults.engines, engine, `engines.${engine}`)
  }

  // nested sections the code relies on
  restore(config.appearance, defaults.appearance, 'chat', 'appearance.chat')
  restore(config.plugins, defaults.plugins, 'mcp', 'plugins.mcp')
  restore(config.llm, defaults.llm, 'defaults', 'llm.defaults')

}

const buildConfig = (defaults: anyDict, overrides: anyDict): Configuration => {

  // 1st merge
  const config = mergeConfig(defaults, overrides)

  // then make sure the code below (and the application) can rely on the shape
  restoreInvalidSections(config, defaults)

  // backwards compatibility
  if ('bypassProxy' in config.general) {
    if (config.general.bypassProxy) {
      config.general.proxyMode = 'bypass'
    }
    delete config.general.bypassProxy
  }

  // backwards compatibility
  if ('tint' in config.appearance) {
    // @ts-expect-error backwards compatibility
    config.appearance.darkTint = config.appearance.tint
    delete config.appearance.tint
  }

  // backwards compatibility: showToolCalls renamed to toolCallsDisplay
  if ('showToolCalls' in config.appearance.chat) {
    const mapping: Record<string, string> = { 'never': 'none', 'calling': 'summary', 'always': 'summary' }
    const chat = config.appearance.chat as Record<string, unknown>
    config.appearance.chat.toolCallsDisplay = (mapping[chat.showToolCalls as string] || 'summary') as typeof config.appearance.chat.toolCallsDisplay
    delete chat.showToolCalls
  }

  // backwards compatibility
  if ('servers' in config.plugins.mcp) {
    config.mcp.servers = config.plugins.mcp.servers
    config.mcp.smitheryApiKey = config.plugins.mcp.smitheryApiKey
    delete config.plugins.mcp
  }

  // backwards compatibility
  // @ts-expect-error backwards compatibility
  if (config.openai || config.ollama) {
    config.engines = {
      // @ts-expect-error backwards compatibility
      openai: config.openai,
      // @ts-expect-error backwards compatibility
      ollama: config.ollama
    }
    // @ts-expect-error backwards compatibility
    delete config.openai
    // @ts-expect-error backwards compatibility
    delete config.ollama
  }

  // backwards compatibility
  if (config.plugins.tavily) {
    config.plugins.search = {
      enabled: config.plugins.tavily.enabled,
      engine: config.plugins.tavily.enabled ? 'tavily' : 'local',
      tavilyApiKey: config.plugins.tavily.apiKey
    }
    delete config.plugins.tavily
  }

  // backwards compatibility
  for (const modelDefaults of config.llm.defaults) {
    // @ts-expect-error backwards compatibility
    if (modelDefaults.prompt) {
    // @ts-expect-error backwards compatibility
      modelDefaults.instructions = modelDefaults.prompt
    // @ts-expect-error backwards compatibility
      delete modelDefaults.prompt
    }
  }

  // backwards compatibility
  // @ts-expect-error backwards compatibility
  if (config.shortcuts.chat) {
    // @ts-expect-error backwards compatibility
    config.shortcuts.main = config.shortcuts.chat
    // @ts-expect-error backwards compatibility
    delete config.shortcuts.chat
  }

  // backwards compatibility: transcribe shortcut renamed to audioBooth
  // @ts-expect-error backwards compatibility
  if (config.shortcuts.transcribe) {
    // @ts-expect-error backwards compatibility
    config.shortcuts.audioBooth = config.shortcuts.transcribe
    // @ts-expect-error backwards compatibility
    delete config.shortcuts.transcribe
  }

  // backwards compatibility: shortcuts without type default to 'electron'
  for (const key of Object.keys(config.shortcuts)) {
    const shortcut = config.shortcuts[key as keyof typeof config.shortcuts]
    if (shortcut && !shortcut.type) {
      shortcut.type = 'electron'
    }
  }

  // backwards compatibility: Python plugin runtime mode
  if (config.plugins.python) {
    // If runtime not specified in user overrides but binpath exists, set to native
    // Check overrides (not merged config) because defaults already set runtime: 'embedded'
    const hadRuntimeInOverrides = overrides.plugins?.python?.runtime
    if (!hadRuntimeInOverrides && config.plugins.python.binpath) {
      config.plugins.python.runtime = 'native'
    }
    // Otherwise ensure it has a runtime (will be 'embedded' from defaults)
    if (!config.plugins.python.runtime) {
      config.plugins.python.runtime = 'embedded'
    }
  }

  // backwards compatibility: codeExecution changed from object to string
  // This feature is now hidden, so just disable it if old format is found
  if (typeof config.llm.codeExecution !== 'string') {
    config.llm.codeExecution = 'disabled'
  }

  // backwards compatibility: quickDictation appearance 'panel' renamed to 'bottom'
  // @ts-expect-error backwards compatibility
  if (config.stt?.quickDictation?.appearance === 'panel') {
    config.stt.quickDictation.appearance = 'bottom'
  }

  // nullify defaults
  nullifyDefaults(config)

  // done
  return config as Configuration

}

const nullifyDefaults = (settings: anyDict) => {
  if (settings.engines.openai && (settings.engines.openai.baseURL == '' || settings.engines.openai.baseURL === defaultSettings.engines.openai.baseURL)) {
    delete settings.engines.openai.baseURL
  }
  if (settings.engines.ollama && (settings.engines.ollama.baseURL == '' || settings.engines.ollama.baseURL === defaultSettings.engines.ollama.baseURL)) {
    delete settings.engines.ollama.baseURL
  }
  if (settings.engines.lmstudio && (settings.engines.lmstudio.baseURL == '' || settings.engines.lmstudio.baseURL === defaultSettings.engines.lmstudio.baseURL)) {
    delete settings.engines.lmstudio.baseURL
  }
  if (settings.engines.sdwebui && (settings.engines.sdwebui.baseURL == '' || settings.engines.sdwebui.baseURL === defaultSettings.engines.sdwebui.baseURL)) {
    delete settings.engines.sdwebui.baseURL
  }
}

// names of the stored keys that could not be decrypted (keychain locked or denied, keyring not ready,
// profile copied from another machine...) and of the keys that could not be stored: for reporting
const undecryptableKeys = new Set<string>()
const notStoredKeys = new Set<string>()
let weakKeyStorageWarned = false

// on Linux without a keyring (gnome-libsecret, kwallet) Electron falls back to the basic_text backend:
// the keys are encrypted with a hard-coded password, which is obfuscation, not protection
export const isKeyStorageWeak = (): boolean => {
  try {
    return process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text'
  } catch {
    return false
  }
}

const warnIfKeyStorageIsWeak = (): void => {
  if (weakKeyStorageWarned || !isKeyStorageWeak()) return
  weakKeyStorageWarned = true
  console.warn('API keys are not protected: no system keyring (gnome-libsecret, kwallet) is available, so they are stored with the basic_text backend, which only obfuscates them. Install and unlock a keyring to have them encrypted.')
}

export const getApiKeyStorageStatus = (): ApiKeyStorageStatus => {
  let encryptionAvailable = false
  try {
    encryptionAvailable = safeStorage.isEncryptionAvailable()
  } catch { /* reported as not available */ }
  return {
    encryptionAvailable,
    weak: isKeyStorageWeak(),
    undecryptable: [...undecryptableKeys].sort(),
    notStored: [...notStoredKeys].sort(),
  }
}

// a decryption error is never a reason to delete the key: the ciphertext stays where it is and is tried again later
const decryptStoredKey = (name: string, buffer: string): string|null => {
  try {
    const apiKey = safeStorage.decryptString(Buffer.from(buffer, 'latin1'))
    undecryptableKeys.delete(name)
    return apiKey
  } catch (error) {
    if (!undecryptableKeys.has(name)) {
      console.warn(`Error decrypting API key for ${name}: the stored key is kept and will be tried again:`, error?.message ?? error)
      undecryptableKeys.add(name)
    }
    return null
  }
}

export const loadApiKeys = (): ApiKeyEntry[] => {

  // check
  if (!safeStorage.isEncryptionAvailable()) {
    return []
  }

  try {
    warnIfKeyStorageIsWeak()
    const apiKeys: ApiKeyEntry[] = []
    for (const [name, buffer] of Object.entries(safeStore.store)) {
      const apiKey = decryptStoredKey(name, buffer)
      if (apiKey !== null) {
        apiKeys.push({ name, apiKey })
      }
    }
    return apiKeys
  } catch (error) {
    console.log('Error loading API keys:', error)
    return []
  }
}

export const deleteApiKeys = (): boolean => {

  try {

    // check
    if (!safeStorage.isEncryptionAvailable()) {
      return false
    }

    // delete the entries we can read: one that cannot be decrypted is not in the settings either, so it is kept
    try {
      const credentials = loadApiKeys()
      for (const credential of credentials) {
        safeStore.delete(credential.name)
      }
    } catch (error) {
      console.log('Error clearing existing API keys:', error)
      return false
    }

    // done
    return true
    

  } catch (error) {
    console.log('Error saving API keys:', error)
    return false
  }

}

// makes the key store match the given keys and tells which ones could not be stored.
// nothing is deleted before the new values are safely written, and a failure for
// one key leaves the others (and the previous value of that key) untouched.
// returns null when the key store cannot be used at all.
const storeApiKeys = (apiKeys: ApiKeyEntry[]): { stored: ApiKeyEntry[], failed: ApiKeyEntry[] }|null => {

  // check
  if (!safeStorage.isEncryptionAvailable()) {
    return null
  }

  warnIfKeyStorageIsWeak()

  const existing: Record<string, string> = { ...safeStore.store }
  const stored: ApiKeyEntry[] = []
  const failed: ApiKeyEntry[] = []

  // save new and modified entries
  for (const entry of apiKeys) {
    if (entry.apiKey.length === 0) continue
    try {
      const unchanged = entry.name in existing && !undecryptableKeys.has(entry.name) && decryptStoredKey(entry.name, existing[entry.name]) === entry.apiKey
      if (!unchanged) {
        const buffer = safeStorage.encryptString(entry.apiKey);
        safeStore.set(entry.name, buffer.toString('latin1'));
      }
      undecryptableKeys.delete(entry.name)
      notStoredKeys.delete(entry.name)
      stored.push(entry)
    } catch (error) {
      console.log(`Error saving API key for ${entry.name}: it stays in the settings file:`, error?.message ?? error)
      notStoredKeys.add(entry.name)
      failed.push(entry)
    }
  }

  // delete the entries the user removed. an entry that cannot be decrypted is missing from
  // the configuration for that reason, not because it was removed: its ciphertext is kept
  const names = new Set(apiKeys.filter((entry) => entry.apiKey.length > 0).map((entry) => entry.name))
  for (const name of Object.keys(existing)) {
    if (names.has(name) || undecryptableKeys.has(name)) continue
    if (decryptStoredKey(name, existing[name]) === null) continue
    try {
      safeStore.delete(name)
      notStoredKeys.delete(name)
    } catch (error) {
      console.log(`Error deleting API key for ${name}:`, error?.message ?? error)
    }
  }

  // done
  return { stored, failed }

}

// true only when every key is in the key store
export const saveApiKeys = (apiKeys: ApiKeyEntry[]): boolean => {
  try {
    const result = storeApiKeys(apiKeys)
    return result !== null && result.failed.length === 0
  } catch (error) {
    console.log('Error saving API keys:', error)
    return false
  }
}

export const extractApiKeys = (config: anyDict, path: string = ''): ApiKeyEntry[] => {

  const apiKeys: ApiKeyEntry[] = []
  
  try {
    
    const traverse = (obj: anyDict, currentPath: string) => {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const value = obj[key]
          const fullPath = currentPath ? `${currentPath}.${key}` : key
          
          if (key.toLowerCase().includes('apikey') && typeof value === 'string') {
            apiKeys.push({ name: fullPath, apiKey: value })
          } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            traverse(value, fullPath)
          }
        }
      }
    }
    
    traverse(config, path)

  } catch (error) {
    console.log('Error extracting API keys:', error)
  }

  // done
  return apiKeys
}


export const injectApiKeys = (config: Configuration, apiKeys: ApiKeyEntry[]): void => {
  
  try {

    for (const entry of apiKeys) {
      const pathParts = entry.name.split('.')
      let current = config as anyDict
      
      // Navigate to the parent object
      for (let i = 0; i < pathParts.length - 1; i++) {
        if (!isPlainObject(current[pathParts[i]])) {
          current[pathParts[i]] = {}
        }
        current = current[pathParts[i]]
      }
      
      // Set the API key
      const lastKey = pathParts[pathParts.length - 1]
      current[lastKey] = entry.apiKey
    }

  } catch (error) {
    console.log('Error injecting API keys:', error)
  }

}

export const nullifyApiKeys = (config: anyDict, apiKeys: ApiKeyEntry[]): void => {

  try {

    for (const entry of apiKeys) {
      const pathParts = entry.name.split('.')
      let current = config

      for (let i = 0; i < pathParts.length - 1; i++) {
        if (current[pathParts[i]] && typeof current[pathParts[i]] === 'object') {
          current = current[pathParts[i]]
        } else {
          break
        }
      }
      
      const lastKey = pathParts[pathParts.length - 1]
      if (current && Object.prototype.hasOwnProperty.call(current, lastKey)) {
        delete current[lastKey]
      }
    }

  } catch (error) {
    console.log('Error nullifying API keys:', error)
  }
  
}
