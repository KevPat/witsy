
import { clipboard, NativeImage } from 'electron'

// What the user had on the clipboard before an automation borrowed it: Prompt Anywhere, AI
// commands, dictation and the Audio Booth all paste through the clipboard.
//
// What is saved and put back
// - text, HTML, RTF and images: the formats Electron reads and writes on every platform
// - the files copied in a file manager, through the platform format that lists them all:
//     Windows   Shell IDList Array
//     macOS     NSFilenamesPboardType, or public.file-url when one file was copied
//     Linux     x-special/gnome-copied-files, or text/uri-list
//   Windows was checked with a real Electron and the shell's own copy and paste
//   (node tools/clipboard_files_probe.cjs, Windows 11, Electron 38). macOS and Linux follow the
//   documentation of these formats and were not run.
//
// What Electron does not allow, and is still lost
// - Every write of the Electron clipboard empties it first, and writeBuffer writes one format.
//   A restore is therefore either the portable formats together, or one platform format: never
//   both, never two platform formats. When files were copied, their list is what comes back
//   (on Windows, an image that sits next to a file list wins: a file copy has no image there,
//   a screenshot tool that also points to the file it saved has one). The consequences:
//   - Windows: the list comes back as Shell IDList Array alone. Explorer pastes every file.
//     A program that reads the files as CF_HDROP sees none: that format has a number and no
//     name, and readBuffer and writeBuffer only reach formats that are registered by name.
//     FileNameW has a name but holds a single file, never the list.
//     Preferred DropEffect is gone with the rest: files that were cut are pasted as a copy and
//     the originals stay where they are.
//   - macOS: the list of paths comes back, not the text (the names) and not the icon that came
//     with it. A file that is only promised by its app (no path yet) is not in the list.
//   - Linux: one of the two targets comes back, with the cut or copy mark when it is the first
//     one. A file manager that only reads the other target has nothing to paste, and the text
//     (the paths) is not there any more.
// - Application specific formats (the cells of a spreadsheet with their formulas, the layers of
//   an image editor, the objects of a design tool) are not read: only their text, HTML, RTF or
//   image rendering comes back. Such formats come in groups that refer to each other and to
//   the app that wrote them; writing one of them back alone would paste garbage or nothing.
// - What the source app would only have produced when asked (delayed rendering) is read once,
//   now: a format it had not announced in a form Electron reads is not recovered later.
export type ClipboardFiles = {
  format: string
  data: Buffer
}

export type ClipboardSnapshot = {
  text: string
  html: string
  rtf: string
  image: NativeImage | null
  files: ClipboardFiles | null
}

// the formats that hold the whole list of the files copied in a file manager, best first.
// only these are ever written back on their own
const kFileListFormats: Record<string, string[]> = {
  win32: ['Shell IDList Array'],
  darwin: ['NSFilenamesPboardType'],
  linux: ['x-special/gnome-copied-files', 'text/uri-list'],
}

// one file, as its url: only used when the text says that one thing was copied,
// so that a list never comes back as its first item
const kMacSingleFileFormat = 'public.file-url'

const isEmptyImage = (image: any): boolean => {
  if (!image) return true
  if (typeof image.isEmpty === 'function') return image.isEmpty()
  return !!image.empty
}

const read = <T>(reader: () => T, fallback: T): T => {
  try {
    const value = reader()
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

const readFormat = (format: string): ClipboardFiles | null => {
  const data = read<Buffer | null>(() => clipboard.readBuffer?.(format), null)
  return data && data.length > 0 ? { format, data } : null
}

// a list of urls is a list of files when every url is one: a link copied in a browser is not
const isFileUrlList = (data: Buffer): boolean => {
  const lines = data.toString('utf-8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length && !line.startsWith('#'))
  return lines.length > 0 && lines.every((line) => line.toLowerCase().startsWith('file:'))
}

const readFiles = (text: string): ClipboardFiles | null => {

  for (const format of kFileListFormats[process.platform] ?? []) {
    const files = readFormat(format)
    if (!files) continue
    if (format === 'text/uri-list' && !isFileUrlList(files.data)) continue
    return files
  }

  if (process.platform === 'darwin' && !/[\r\n]/.test(text.trim())) {
    return readFormat(kMacSingleFileFormat)
  }

  return null

}

export const saveClipboard = (): ClipboardSnapshot => {
  const text = clipboard.readText()
  const image = read<NativeImage | null>(() => clipboard.readImage?.(), null)
  return {
    text,
    html: read(() => clipboard.readHTML?.(), ''),
    rtf: read(() => clipboard.readRTF?.(), ''),
    image: isEmptyImage(image) ? null : image,
    files: read<ClipboardFiles | null>(() => readFiles(typeof text === 'string' ? text : ''), null),
  }
}

// the list of files, when it is what the clipboard was about
const restoreFiles = (snapshot: ClipboardSnapshot): boolean => {

  if (!snapshot.files || typeof clipboard.writeBuffer !== 'function') return false
  if (process.platform === 'win32' && snapshot.image) return false

  try {
    clipboard.writeBuffer(snapshot.files.format, snapshot.files.data)
    // when the format is not there after all, the portable formats are better than nothing
    return typeof clipboard.has === 'function' ? clipboard.has(snapshot.files.format) : true
  } catch (error) {
    console.error('Error restoring the files of the clipboard', error)
    return false
  }

}

export const restoreClipboard = (snapshot: ClipboardSnapshot): void => {
  try {

    // files copied in a file manager
    if (restoreFiles(snapshot)) {
      return
    }

    // text only: the common case
    if (!snapshot.image && !snapshot.html && !snapshot.rtf) {
      clipboard.writeText(snapshot.text)
      return
    }

    // several formats at once
    if (typeof clipboard.write === 'function') {
      clipboard.write({
        ...(snapshot.text ? { text: snapshot.text } : {}),
        ...(snapshot.html ? { html: snapshot.html } : {}),
        ...(snapshot.rtf ? { rtf: snapshot.rtf } : {}),
        ...(snapshot.image ? { image: snapshot.image } : {}),
      })
      return
    }

    // best we can do
    if (snapshot.image) {
      clipboard.writeImage(snapshot.image)
    } else {
      clipboard.writeText(snapshot.text)
    }

  } catch (error) {
    console.error('Error restoring the clipboard', error)
  }
}
