
import { Expert, ExpertCategory, ExpertData } from 'types/index'
import { app, App } from 'electron'
import { createI18n } from './i18n.base'
import { getLocaleMessages } from './i18n'
import { workspaceFolderPath } from './workspace'
import defaultExpertsData from '@root/defaults/experts.json'
import Monitor from './monitor'
import * as window from './window'
import * as file from './file'
import { backupCorruptFile, writeFileAtomicSync } from './atomic'
import path from 'path'
import fs from 'fs'

const monitor: Monitor = new Monitor(() => {
  window.emitIpcEventToAll('file-modified', 'experts');
});

const isEntry = (entry: any): boolean => {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string'
}

export const expertsFilePath = (app: App, workspaceId: string): string => {
  const workspacePath = workspaceFolderPath(app, workspaceId)
  return path.join(workspacePath, 'experts.json')
}

export const loadExperts = (source: App|string, workspaceId: string): Expert[] => {
  const expertData = loadExpertData(source, workspaceId)
  return expertData.experts
}

export const saveExperts = (dest: App|string, workspaceId: string, content: Expert[]): void => {
  try {
    const expertData = loadExpertData(dest, workspaceId)
    expertData.experts = content
    saveExpertData(dest, workspaceId, expertData)
  } catch (error) {
    console.log('Error saving experts data', error)
  }
}

export const loadCategories = (source: App|string, workspaceId: string): ExpertCategory[] => {
  const expertData = loadExpertData(source, workspaceId)
  return expertData.categories
}

export const saveCategories = (dest: App|string, workspaceId: string, content: ExpertCategory[]): void => {
  try {
    const expertData = loadExpertData(dest, workspaceId)
    expertData.categories = content
    saveExpertData(dest, workspaceId, expertData)
  } catch (error) {
    console.log('Error saving categories', error)
  }
}

const loadExpertData = (source: App|string, workspaceId: string): ExpertData => {

  // init
  let jsonData: any
  const expertsFile = typeof source === 'string' ? source : expertsFilePath(source, workspaceId)

  // read
  try {
    jsonData = JSON.parse(fs.readFileSync(expertsFile, 'utf-8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // the defaults returned now are saved over this file at the next save: keep a copy
      console.log('Error retrieving experts', error)
      backupCorruptFile(expertsFile)
    }
  }

  // needed
  const defaultCategories = Array.isArray(defaultExpertsData.categories) ? defaultExpertsData.categories : (defaultExpertsData as any).categories
  const defaultExperts = Array.isArray(defaultExpertsData) ? defaultExpertsData : (defaultExpertsData as any).experts

  // migrations can update
  let updated = false

  // migrate old experts format
  const expertData: ExpertData = {
    categories: [...defaultCategories] as ExpertCategory[],
    experts: [...defaultExperts] as Expert[],
  }

  if (Array.isArray(jsonData)) {

    // this is a migration from old array format
    // as this is a breaking change we backup the old file
    try {
      if (!process.env.TEST) {
        const backupFile = expertsFile.replace('.json', '-backup-v2.json')
        fs.copyFileSync(expertsFile, backupFile)
      }
    } catch (error) {
      console.warn('Error creating experts backup file', error)
    }

    // migrate to new format
    expertData.experts = jsonData.filter(isEntry) as Expert[]
    updated = true

  } else if (jsonData !== null && typeof jsonData === 'object' && Array.isArray(jsonData.experts)) {

    // entries of the wrong shape are dropped instead of crashing at startup (EXPERTS.LOAD is synchronous)
    const experts = jsonData.experts.filter(isEntry)
    const categories = Array.isArray(jsonData.categories) ? jsonData.categories.filter(isEntry) : [...defaultCategories]
    if (experts.length !== jsonData.experts.length || !Array.isArray(jsonData.categories) || categories.length !== jsonData.categories.length) {
      backupCorruptFile(expertsFile)
      updated = true
    }
    expertData.categories = categories as ExpertCategory[]
    expertData.experts = experts as Expert[]

  } else {

    // valid JSON that is not an experts file: keep a copy before the defaults replace it
    if (jsonData !== undefined) {
      backupCorruptFile(expertsFile)
    }
    return expertData

  }

  // a system expert takes its name and prompt from the defaults: one that was retired from
  // the defaults and has no text of its own cannot be shown, so it is dropped
  expertData.experts = expertData.experts.filter((expert: Expert) => {
    if (expert.type !== 'system') return true
    if (defaultExperts.some((de: Expert) => de.id === expert.id)) return true
    if (typeof expert.name === 'string' && expert.name && typeof expert.prompt === 'string' && expert.prompt) return true
    updated = true
    return false
  })

  // i18n migrate label and template
  const t = createI18n(getLocaleMessages(app), 'en', { missingWarn: false }).global.t as CallableFunction
  for (const expert of expertData.experts) {

    const defaultExpert = defaultExperts.find((de: Expert) => de.id === expert.id)

    const key = `experts.experts.${expert.id}`
    if (expert.name === t(`${key}.name`)) {
      delete expert.name
      updated = true
    }
    if (expert.prompt === t(`${key}.prompt`)) {
      delete expert.prompt
      updated = true
    }

    // Initialize stats if missing
    if (!expert.stats) {
      expert.stats = { timesUsed: 0 }
      updated = true
    }

    // assign categoryId from defaults for system experts if missing
    if (expert.type === 'system' && !expert.categoryId) {
      if (defaultExpert?.categoryId !== undefined) {
        expert.categoryId = defaultExpert.categoryId
        updated = true
      }
    }

    // add empty description
    if (expert.type === 'system' && !expert.description) {
      if (defaultExpert?.description) {
        expert.description = defaultExpert.description
        updated = true
      }
    }

  }

  // add new categories
  for (const category of defaultCategories) {
    const c = expertData.categories.find((cat: ExpertCategory) => cat.id === category.id)
    if (c == null) {
      expertData.categories.push(category as ExpertCategory)
      updated = true
    }
  }

  // now add new experts
  for (const prompt of defaultExperts) {
    const p = expertData.experts.find((prt: Expert) => prt.id === prompt.id)
    if (p == null) {
      expertData.experts.push(prompt as Expert)
      updated = true
    }
  }

  // delete deprecated experts
  const deprecated = [
    '6e197c43-1074-479b-89d5-3ab8d54ad36b' // doctor
  ]
  for (const id of deprecated) {
    const index = expertData.experts.findIndex((expert: Expert) => expert.id === id)
    if (index !== -1) {
      expertData.experts.splice(index, 1)
      updated = true
    }
  }

  // save if needed
  if (updated) {
    saveExpertData(source, workspaceId, expertData)
  }

  // start monitoring
  if (typeof source !== 'string') {
    monitor.start(expertsFile)
  }

  // done
  return expertData

}

export const saveExpertData = (dest: App|string, workspaceId: string, content: ExpertData): void => {
  try {
    const expertsFile = typeof dest === 'string' ? dest : expertsFilePath(dest, workspaceId)
    fs.mkdirSync(path.dirname(expertsFile), { recursive: true })
    writeFileAtomicSync(expertsFile, JSON.stringify(content, null, 2))
  } catch (error) {
    console.log('Error saving experts', error)
  }
}

export const exportExperts = (app: App, workspaceId: string) => {

  // pick a directory
  const filepath = file.pickDirectory(app)
  if (!filepath) {
    return false
  }

  // a fresh workspace has no file yet: export what is loaded
  let contents: string
  try {
    contents = fs.readFileSync(expertsFilePath(app, workspaceId), 'utf-8')
  } catch {
    contents = JSON.stringify(loadExpertData(app, workspaceId), null, 2)
  }

  // write
  try {
    fs.writeFileSync(path.join(filepath, 'experts.json'), contents)
  } catch (error) {
    console.log('Error exporting experts', error)
    return false
  }

  // done
  return true

}

export const importExperts = (app: App, workspaceId: string) => {

  // pick the file
  const filename = file.pickFile(app, { location: true, filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (!filename) {
    return false
  }

  // read and check that this is an experts export (current or legacy format)
  let contents: string
  try {
    contents = fs.readFileSync(filename as string, 'utf-8')
    const json = JSON.parse(contents)
    const entries = Array.isArray(json) ? json : json?.experts
    if (!Array.isArray(entries) || !entries.every(isEntry)) {
      console.log('Refusing to import a file that is not an experts export', filename)
      return false
    }
    // a commands export is also an array of { id, type } entries
    if (entries.some((entry: any) => 'action' in entry || 'template' in entry)) {
      console.log('Refusing to import a commands export as experts', filename)
      return false
    }
  } catch (error) {
    console.log('Error importing experts', error)
    return false
  }

  // write
  try {
    const target = expertsFilePath(app, workspaceId)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    writeFileAtomicSync(target, contents)
  } catch (error) {
    console.log('Error importing experts', error)
    return false
  }

  // done
  return true

}
