
import { shell } from 'electron'

// Schemes that may be handed to the operating system. Anything else
// (file:, smb:, ms-msdt:, search-ms:, javascript:, custom app schemes...)
// can run local programs or open local files and is refused.
const ALLOWED_EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:']

export const isSafeExternalUrl = (url: unknown): url is string => {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    const parsed = new URL(url)
    return ALLOWED_EXTERNAL_PROTOCOLS.includes(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * `shell.openExternal` for URLs that do not come from the app itself
 * (links in model output, web pages, MCP servers...).
 * Returns false, without opening anything, when the scheme is not allowed.
 */
export const openExternalUrl = async (url: unknown): Promise<boolean> => {
  if (!isSafeExternalUrl(url)) {
    console.warn('[links] refused to open external url with a disallowed scheme')
    return false
  }
  try {
    await shell.openExternal(url)
    return true
  } catch (error) {
    console.error('[links] error opening external url', error)
    return false
  }
}
