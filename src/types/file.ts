
export type FileContents = {
  url: string
  mimeType: string
  contents: string
}

export type AppDirectory = 'home' | 'appData' | 'userData' | 'sessionData' | 'temp' | 'documents' | 'downloads'

export type FileProperties = {
  directory?: AppDirectory
  prompt?: boolean
  subdir?: string | false
  filename?: string
  workspace?: string
}

export type FileSaveParams = {
  contents: string
  url?: string
  properties?: FileProperties
}

export type FileDownloadParams = {
  url: string
  properties?: FileProperties
}

export type FilePickParams = {
  packages?: boolean
  location?: boolean
  multiselection?: boolean
  filters?: Array<{
    name: string
    extensions: string[]
  }>
}

export type FileStats = {
  createdAt: number
  size: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  lastModified: number
}

export type SearchMatch = {
  file: string
  line: number
  content: string
  isMatch: boolean  // true for actual match, false for context line
}

export type SearchOptions = {
  glob?: string
  caseInsensitive?: boolean
  contextLines?: number
  maxResults?: number
}

export type SearchResult = {
  matches: SearchMatch[]
  filesSearched: number
  // the result was cut short: more matches exist (maxResults) or not every file was searched
  truncated: boolean
  // not every file was searched (file limit reached, or a file could not be read):
  // no match in the result does not mean no match in the folder
  incomplete?: boolean
}
