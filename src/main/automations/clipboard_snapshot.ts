
import { clipboard, NativeImage } from 'electron'

// What the user had on the clipboard before an automation borrowed it.
// Electron gives portable access to text, HTML, RTF and images: these are saved and put back.
// Other content (files copied in a file manager, application specific formats) cannot be
// read back portably and is still lost.
export type ClipboardSnapshot = {
  text: string
  html: string
  rtf: string
  image: NativeImage | null
}

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

export const saveClipboard = (): ClipboardSnapshot => {
  const image = read<NativeImage | null>(() => clipboard.readImage?.(), null)
  return {
    text: clipboard.readText(),
    html: read(() => clipboard.readHTML?.(), ''),
    rtf: read(() => clipboard.readRTF?.(), ''),
    image: isEmptyImage(image) ? null : image,
  }
}

export const restoreClipboard = (snapshot: ClipboardSnapshot): void => {
  try {

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
