import autolib from 'autolib';
import { execFileSync } from 'child_process';
import { App, dialog } from 'electron';
import icns from 'icns-lib';
import { minimatch } from 'minimatch';
import { extensionToMimeType as e2mt } from 'multi-llm-ts';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import plist from 'plist';
import process from 'process';
import { resolveInside, safeBasename } from './path_containment';
import { AppDirectory, FileContents, FileDownloadParams, FilePickParams, FileProperties, FileSaveParams, FileStats, SearchMatch, SearchOptions, SearchResult } from 'types/file';
import { DirectoryItem } from 'types/filesystem';
import { ExternalApp } from 'types/index';

const FILE_SIZE_LIMIT = 256 * 1024 * 1024; // 256MB

export const extensionToMimeType = (ext: string): string => {
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.avi') return 'video/x-msvideo'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.wmv') return 'video/x-ms-wmv'
  if (ext === '.flv') return 'video/x-flv'
  // if (ext === '.webm') return 'video/webm'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.m4v') return 'video/x-m4v'
  if (ext === '.3gp') return 'video/3gpp'
  if (ext === '.ogv') return 'video/ogg'
  if (ext === '.ts') return 'video/mp2t'
  if (ext === '.mts') return 'video/mp2t'
  if (ext === '.m2ts') return 'video/mp2t'
  else return e2mt(ext)
}

export const getFileContents = (app: App, filepath: string): FileContents|null => {

  try {
    if (filepath.startsWith('file://')) {
      filepath = filepath.slice(7);
    }

    // load and check
    const fileContents = fs.readFileSync(filepath);
    if (!fileContents) {
      console.error('File is empty or cannot be read', filepath);
      return null;
    }

    // check size
    if (fileContents.length > FILE_SIZE_LIMIT) {
      console.error('File too large to read', filepath);
      return null;
    }

    // good
    return {
      url: `file://${filepath}`,
      mimeType: extensionToMimeType(path.extname(filepath)),
      contents: fileContents.toString('base64')
    };

  } catch (error) {
    console.error('Error while reading file', error);
  }

  // default
  return null;

}

export const getIconContents = (app: App, filepath: string): FileContents|null => {

  try {

    // check extension
    const extension = path.extname(filepath);
    if (extension === '.icns') {
    
      const buffer = fs.readFileSync(filepath);
      const icons = icns.parse(buffer);
      const icon = icons[Object.keys(icons)[0]]
      return {
        url: `file://${filepath}`,
        mimeType: extensionToMimeType('png'),
        contents: icon.toString('base64')
      };
    
    } else if (process.platform == 'win32') {

      // for windows
      const iconInfo = autolib.getApplicationIcon(filepath);

      // convert iconInfo to base64 encoded string
      if (iconInfo && iconInfo.iconData) {
        return {
          url: `file://${filepath}`,
          mimeType: 'image/x-icon',
          contents: Buffer.from(iconInfo.iconData).toString('base64')
        };
      }

    }
  } catch (error) {
    console.error('Error while reading icon', error);
  }

  // default
  return null;

}

export const deleteFile = (filepath: string): boolean => {

  try {
    let path = filepath;
    if (path.startsWith('file://')) {
      path = path.slice(7);
    }
    if (!fs.existsSync(path)) {
      return false;
    }
    fs.unlinkSync(path);
    return true;
  } catch (error) {
    console.error('Error while deleting file', error);
    return false;
  }

}

export const pickFile = (app: App, payload: FilePickParams): string|string[]|FileContents|null => {

  try {

    // build dialog propertis
    const dialogProperties: ('openFile' | 'treatPackageAsDirectory' | 'noResolveAliases' | 'multiSelections')[] = ['openFile'];
    if (!payload.packages) {
      dialogProperties.push('treatPackageAsDirectory');
    }
    if (payload.location) {
      dialogProperties.push('noResolveAliases');
    }
    if (payload.multiselection) {
      dialogProperties.push('multiSelections');
    }

    // show it and pick
    const fileURL = dialog.showOpenDialogSync({
      properties: dialogProperties,
      filters: payload?.filters || [{ name: 'All Files', extensions: ['*'] }]
    });

    // return
    if (fileURL) {
      if (payload.multiselection) return fileURL;
      else if (payload.location) return fileURL[0];
      else return getFileContents(app, fileURL[0]);
    }

  } catch (error) {
    console.error('Error while picking file', error);
  }

  // default
  return null;

}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const pickDirectory = (app: App): string|null => {

  try {

    // build dialog propertis
    const dialogProperties: ('openDirectory' | 'treatPackageAsDirectory')[] = ['openDirectory', 'treatPackageAsDirectory'];

    // show it and pick
    const fileURL = dialog.showOpenDialogSync({
      properties: dialogProperties,
    });

    // return
    if (fileURL) {
      return fileURL[0];
    }

  } catch (error) {
    console.error('Error while picking directory', error);
  }

  // default
  return null;

}

export const listFilesRecursively = (directoryPath: string, excludePatterns?: string[], visited: Set<string> = new Set()): string[] => {

  let fileList: string[] = []

  try {

    // a directory is listed once: a symbolic link that leads back to it (a link to a parent) would never end
    let realPath = path.resolve(directoryPath)
    try {
      realPath = fs.realpathSync(directoryPath)
    } catch { /* not resolvable: listed by its own path */ }
    if (visited.has(realPath)) {
      return fileList
    }
    visited.add(realPath)

    // Read the contents of the directory
    const files = fs.readdirSync(directoryPath)

    for (const file of files) {

      // ignored files
      if (file === '.DS_Store' || file === 'Thumbs.db') {
        continue
      }

      // check exclude patterns
      if (excludePatterns?.some(pattern => minimatch(file, pattern))) {
        continue
      }

      const filePath = path.join(directoryPath, file)

      // a broken symbolic link (or a file removed meanwhile) is skipped, not the rest of its directory
      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        // If it's a directory, recursively call the function
        fileList = fileList.concat(listFilesRecursively(filePath, excludePatterns, visited));
      } else {
        // If it's a file, add it to the list
        fileList.push(filePath);
      }
    }

  } catch (err) {
    console.error('Error while listing files recursively', err);
  }

  return fileList;
}

export const listDirectory = (app: App, dirPath: string, includeHidden: boolean = false): DirectoryItem[] => {
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true })

    return items
      .filter(item => includeHidden || !item.name.startsWith('.'))
      .map(item => {
        const itemPath = path.join(dirPath, item.name)
        const result: DirectoryItem = {
          name: item.name,
          fullPath: itemPath,
          isDirectory: item.isDirectory()
        }

        if (!item.isDirectory()) {
          try {
            const stats = fs.statSync(itemPath)
            result.size = stats.size
          } catch {
            // Ignore errors for individual files
          }
        }

        return result
      })
  } catch (error) {
    console.error('Error while listing directory', error)
    throw error
  }
}

export const findFiles = async (app: App, basePath: string, pattern: string, maxResults: number = 10): Promise<string[]> => {
  const results: string[] = []

  try {
    const findFilesRecursive = async (currentPath: string, depth: number = 0): Promise<boolean> => {
      // Safety limit to prevent infinite recursion
      if (depth > 50) return false

      try {
        const items = await fsPromises.readdir(currentPath, { withFileTypes: true })

        for (const item of items) {
          // Stop if we've reached the max results
          if (results.length >= maxResults) return true

          // Skip hidden files and system files
          if (item.name.startsWith('.') || item.name === 'node_modules') continue

          const itemPath = path.join(currentPath, item.name)

          if (item.isDirectory()) {
            // Recursively search subdirectories
            if (await findFilesRecursive(itemPath, depth + 1)) return true
          } else {
            // Check if file matches the pattern
            if (minimatch(itemPath, pattern) || minimatch(item.name, pattern)) {
              results.push(itemPath)
            }
          }
        }
      } catch (error) {
        // Silently skip directories we can't read (permissions, etc.)
        console.debug('Skipping directory due to error:', currentPath, error)
      }

      return results.length >= maxResults
    }

    await findFilesRecursive(basePath)

  } catch (error) {
    console.error('Error while finding files', error)
    throw error
  }

  return results
}

export const fileExists = (app: App, filePath: string): boolean => {
  try {
    return fs.existsSync(filePath)
  } catch (error) {
    console.error('Error while checking file existence', error)
    return false
  }
}

export const fileStats = (app: App, filePath: string): FileStats | null => {
  try {
    const stats = fs.lstatSync(filePath)
    return {
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      lastModified: stats.mtimeMs,
      createdAt: stats.birthtimeMs,
    }
  } catch (error) {
    console.error('Error while getting file stats', error)
    return null
  }
}

export const writeFile = (app: App, filePath: string, content: string): boolean => {
  try {
    // Ensure directory exists
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    fs.writeFileSync(filePath, content, 'utf8')
    return true
  } catch (error) {
    console.error('Error while writing new file', error)
    return false
  }
}

export const normalizePath = (app: App, filePath: string): string => {
  try {
    // Handle tilde expansion for home directory
    if (filePath.startsWith('~/')) {
      const homeDir = process.env.HOME || process.env.USERPROFILE
      if (homeDir) {
        filePath = path.join(homeDir, filePath.slice(2))
      }
    } else if (filePath === '~') {
      const homeDir = process.env.HOME || process.env.USERPROFILE
      if (homeDir) {
        filePath = homeDir
      }
    } else if (!path.isAbsolute(filePath)) {
      // Make relative paths relative to home directory
      const homeDir = process.env.HOME || process.env.USERPROFILE
      if (homeDir) {
        filePath = path.join(homeDir, filePath)
      }
    }
    
    return path.resolve(filePath)
  } catch (error) {
    console.error('Error while normalizing path', error)
    return filePath
  }
}

// a bare program name: no path, no whitespace, nothing a shell or the lookup tool could interpret
const PROGRAM_NAME_PATTERN = /^[A-Za-z0-9_+][A-Za-z0-9._+-]{0,127}$/

export const findProgram = (app: App, program: string): string|null => {
  if (typeof program !== 'string' || !PROGRAM_NAME_PATTERN.test(program)) {
    console.error('Refusing to look up an invalid program name');
    return null;
  }
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const output = execFileSync(which, [program], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\n')[0].trim() || null;
  } catch (error) {
    console.error(`Error while finding program ${program}`, error);
  }
  return null;
}

const SAVE_DIRECTORIES: AppDirectory[] = ['home', 'appData', 'userData', 'sessionData', 'temp', 'documents', 'downloads']

// without a save dialog nobody sees where the file goes: only the folders where the app keeps its own files are accepted
// (generated media and attachments in userData, drawings of the design studio in temp).
// with a save dialog the directory is only where the dialog opens
const UNPROMPTED_SAVE_DIRECTORIES: AppDirectory[] = ['userData', 'temp']

const DEFAULT_SAVE_PROPERTIES: FileProperties = {
  directory: 'downloads',
  prompt: false,
  subdir: false,
}

const isSaveDirectoryAccepted = (properties: FileProperties): boolean => {
  if (!SAVE_DIRECTORIES.includes(properties.directory)) {
    console.error('Refusing to save file in unknown directory', properties.directory);
    return false;
  }
  if (!properties.prompt && !UNPROMPTED_SAVE_DIRECTORIES.includes(properties.directory)) {
    console.error('Refusing to save file without a save dialog in directory', properties.directory);
    return false;
  }
  return true;
}

export const writeFileContents = (app: App, payload: FileSaveParams): string => {
  return saveFileContents(app, payload).url
}

// same as writeFileContents, and tells a save dialog the user cancelled from a failure
const saveFileContents = (app: App, payload: FileSaveParams): { url: string|null, cancelled: boolean } => {

  // defaults
  const defaultPayload = {
    contents: '',
    properties: DEFAULT_SAVE_PROPERTIES,
  };

  payload = {
    ...defaultPayload,
    ...payload,
    properties: {
      ...defaultPayload.properties,
      ...payload.properties
    }
  };

  // parse properties
  const properties = payload.properties;
  if (!isSaveDirectoryAccepted(properties)) {
    return { url: null, cancelled: false };
  }

  // the file name is a single segment: directory parts of the requested name are dropped
  const requestedName = properties.filename || (typeof payload.url === 'string' ? payload.url.split('?')[0] : null);
  const filename = requestedName ? safeBasename(requestedName) : null;
  if (!filename) {
    console.error('Refusing to save file without a valid name', requestedName);
    return { url: null, cancelled: false };
  }

  // workspace and subdir come from the caller: they select a folder below the base directory, never one outside of it
  let defaultPath = app.getPath(properties.directory);
  if (properties.workspace && properties.directory === 'userData') {
    const workspace = safeBasename(properties.workspace);
    const workspaceFolder = workspace === properties.workspace
      ? resolveInside(path.join(defaultPath, 'workspaces'), workspace, { excludeBase: true })
      : null;
    if (!workspaceFolder) {
      console.error('Refusing to save file in invalid workspace', properties.workspace);
      return { url: null, cancelled: false };
    }
    defaultPath = workspaceFolder;
  }
  if (properties.subdir) {
    const subdirPath = resolveInside(defaultPath, properties.subdir);
    if (!subdirPath) {
      console.error('Refusing to save file in sub-directory outside of target directory', properties.subdir);
      return { url: null, cancelled: false };
    }
    defaultPath = subdirPath;
  }

  // without a prompt the file lands in that folder; with one it is only the suggestion and the user picks the destination
  let destinationURL = properties.prompt
    ? path.join(defaultPath, filename)
    : resolveInside(defaultPath, filename, { excludeBase: true });
  if (!destinationURL) {
    console.error('Refusing to save file outside of target directory', filename);
    return { url: null, cancelled: false };
  }
  if (!fs.existsSync(defaultPath)) {
    fs.mkdirSync(defaultPath, { recursive: true });
  }
  if (properties.prompt) {
    destinationURL = dialog.showSaveDialogSync({
      defaultPath: destinationURL
    });
    if (!destinationURL) return { url: null, cancelled: true };
  }

  // try
  try {
    fs.writeFileSync(destinationURL, Buffer.from(payload.contents, 'base64'));
    return { url: `file://${destinationURL}`, cancelled: false };
  } catch (error) {
    console.error('Error while writing file', error);
    return { url: null, cancelled: false }
  }

}

// returns the url of the saved file, null when the download or the save failed,
// and an empty string when the user cancelled the save dialog (nothing to report)
export const downloadFile = async (app: App, payload: FileDownloadParams): Promise<string|null> => {

  const savePayload: FileSaveParams = {
    contents: '',
    url: payload.url,
    properties: payload.properties
  }

  // a save that will be refused is not worth a request, or reading a local file
  if (!isSaveDirectoryAccepted({ ...DEFAULT_SAVE_PROPERTIES, ...payload.properties })) {
    return null;
  }

  try {

    // get contents
    if (payload.url.startsWith('file://')) {

      const source = payload.url.slice(7);
      savePayload.contents = fs.readFileSync(source).toString('base64');
      // the url is reset below: without a file name, the copy is named after its source
      if (!payload.properties?.filename) {
        savePayload.properties = { ...payload.properties, filename: path.basename(source) }
      }
      savePayload.url = null

    } else {

      // fal.media has certificate issues
      // if (payload.url.includes('fal.media')) {
      //   process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
      // }

      const response = await fetch(payload.url);
      if (!response.ok) {
        // the body of an error answer is an error page, not the file
        console.error(`Error while downloading file: HTTP ${response.status}`);
        return null
      }
      const contents = await response.arrayBuffer();
      savePayload.contents = Buffer.from(contents).toString('base64');

      // reset
      // delete process.env['NODE_TLS_REJECT_UNAUTHORIZED']      

    }

    // now just save
    const saved = saveFileContents(app, savePayload);
    return saved.cancelled ? '' : saved.url;

  } catch (error) {
    console.error('Error while downloading file', error);
    return null
  }

}

export const getAppInfo = async (app: App, filepath: string): Promise<ExternalApp | null> => {

  // for macos
  if (process.platform == 'darwin') {
    try {
      const plistPath = path.join(filepath, 'Contents', 'Info.plist');
      const plistInfo = plist.parse(fs.readFileSync(plistPath, 'utf-8'));
      let plistIcon = plistInfo.CFBundleIconFile || 'AppIcon';
      if (!plistIcon.endsWith('.icns')) {
        plistIcon = `${plistIcon}.icns`;
      }
      return {
        name: plistInfo.CFBundleName,
        identifier: plistInfo.CFBundleIdentifier,
        icon: getIconContents(app, path.join(filepath, 'Contents', 'Resources', plistIcon))
      };
    } catch (err) {
      console.error('Error while getting app info', err);
    }
  }

  // for windows
  if (process.platform == 'win32') {
    try {

      const exePath = filepath;
      const productName = autolib.getProductName(exePath);
      if (!productName) {
        console.error('Error while getting product name', exePath);
        return null;
      }
      return {
        name: productName,
        identifier: exePath,
        icon: getIconContents(app, exePath)
      }

    } catch (err) {
      console.error('Error while getting app info', err);
    }
  }

  // too bad
  return null

}

// Directories to skip when searching
const SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.svn', '.hg'
])

/**
 * Find files recursively with glob filtering
 */
const findFilesForSearch = (dir: string, globPattern?: string, maxFiles: number = 1000): { files: string[], capped: boolean } => {
  const files: string[] = []
  const stack: string[] = [dir]

  // set when a file had to be left out because of maxFiles
  let capped = false

  while (stack.length > 0 && !capped) {
    const currentDir = stack.pop()!

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      // Skip hidden files and common non-code directories
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) {
        continue
      }

      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile()) {
        if (globPattern) {
          const relativePath = path.relative(dir, fullPath)
          if (!minimatch(relativePath, globPattern, { matchBase: true })) {
            continue
          }
        }
        if (files.length >= maxFiles) {
          capped = true
          break
        }
        files.push(fullPath)
      }
    }
  }

  return { files, capped }
}

/**
 * Search for content inside files
 */
export const searchContent = (
  basePath: string,
  pattern: string,
  options: SearchOptions = {}
): SearchResult => {
  const { glob, caseInsensitive = false, contextLines = 0, maxResults = 100 } = options

  // Validate regex pattern
  let regex: RegExp
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
  } catch {
    return { matches: [], filesSearched: 0, truncated: false }
  }

  const matches: SearchMatch[] = []
  let truncated = false
  let incomplete = false

  // Handle file vs directory
  const stats = fs.statSync(basePath)
  const { files, capped } = stats.isFile() ? { files: [basePath], capped: false } : findFilesForSearch(basePath, glob)

  // the result is also incomplete when not every file could be searched
  if (capped) {
    truncated = true
    incomplete = true
  }

  for (const file of files) {
    if (matches.length >= maxResults) {
      truncated = true
      break
    }

    let content: string
    try {
      content = fs.readFileSync(file, 'utf-8')
    } catch {
      // a file that cannot be read was not searched
      incomplete = true
      continue
    }

    // Skip binary files
    if (content.includes('\0')) continue

    const lines = content.split('\n')
    const relativePath = path.relative(basePath, file)
    const displayPath = relativePath || path.basename(file)

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) {
        truncated = true
        break
      }

      regex.lastIndex = 0
      if (regex.test(lines[i])) {
        if (contextLines > 0) {
          const startLine = Math.max(0, i - contextLines)
          const endLine = Math.min(lines.length - 1, i + contextLines)

          for (let j = startLine; j <= endLine; j++) {
            matches.push({
              file: displayPath,
              line: j + 1,
              content: lines[j],
              isMatch: j === i
            })
          }
        } else {
          matches.push({
            file: displayPath,
            line: i + 1,
            content: lines[i],
            isMatch: true
          })
        }
      }
    }
  }

  return {
    matches,
    filesSearched: files.length,
    truncated,
    ...(incomplete ? { incomplete: true } : {}),
  }
}
