
import { app } from 'electron'
import process from 'node:process'

// DEBUG is a generic variable that many tools set in the environment of a user (the `debug`
// npm package for instance). In a packaged app it must not switch the API key store, the
// assets folder, the dev tools or the CLI install: only WITSY_DEBUG does that.
// This module must be imported before any module that reads process.env.DEBUG.
export const normalizeDebugEnv = (isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): void => {
  if (!isPackaged) return
  if (env.WITSY_DEBUG && env.WITSY_DEBUG !== '0' && env.WITSY_DEBUG !== 'false') {
    env.DEBUG = '1'
  } else {
    delete env.DEBUG
  }
}

normalizeDebugEnv(!!app?.isPackaged)
