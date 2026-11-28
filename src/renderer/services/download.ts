
import { v4 as uuidv4 } from 'uuid'
import { store } from './store'
import { t } from './i18n'
import Dialog from '@renderer/utils/dialog'

export const getFileContents = (url: string) => {
  return window.api.file.read(url.replace('file://', ''))
}

export const saveFileContents = (extension: string, contents: string) => {

  // call main
  const fileUrl = window.api.file.save({
    contents: contents,
    properties: {
      filename: `${uuidv4()}.${extension}`,
      directory: 'userData',
      subdir: 'images',
      workspace: store.config.workspaceId,
      prompt: false
    }
  })

  // done
  return fileUrl
}
  
/**
 * Downloads a file to a place the user picks, and tells the user when it failed.
 * The main process answers null for a failure (HTTP error, network, disk) and an
 * empty string when the user cancelled the save dialog.
 */
export const downloadWithPrompt = (url: string, filename: string): string|null => {

  const fileUrl = window.api.file.download({
    url: url,
    properties: {
      prompt: true,
      directory: 'downloads',
      filename: filename,
    }
  })

  if (fileUrl === null) {
    Dialog.alert(t('common.downloadError'))
  }

  return fileUrl

}

export const download = (url: string) => {

  // get extension from url
  let extension = url.split(/[#?]/)[0].split('.').pop().trim()
  if (extension == '') {
    extension = 'jpg'
  }

  // call main
  const fileUrl = window.api.file.download({
    url: url,
    properties: {
      filename: `${uuidv4()}.${extension}`,
      directory: 'userData',
      subdir: 'images',
      workspace: store.config.workspaceId,
      prompt: false
    }
  })

  // done
  return fileUrl

}

/**
 * Save a blob as a file via browser download
 */
export const saveBlobAsFile = (blob: Blob, filename: string, extension: string): void => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith(`.${extension}`) ? filename : `${filename}.${extension}`
  a.click()
  URL.revokeObjectURL(url)
}

