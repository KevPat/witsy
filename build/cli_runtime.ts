import fs from 'fs';
import path from 'path';

// Which Node.js runs the Witsy CLI (dist/cli/cli.js), decided when the app is packaged (S-15).
//
// - 'electron': the app binary started with ELECTRON_RUN_AS_NODE=1. This needs the RunAsNode fuse,
//   which also lets any local process run its own script as the signed app (on macOS with the
//   permissions the user gave to Witsy).
// - 'node': the Node.js of the user (18 or later). The fuse is off: the app binary only runs the app.
//
// Every platform is 'electron' by default, so the CLI can run without Node.js on the computer
// of the user. Built with WITSY_CLI_RUNTIME=node, the CLI requires Node.js 18 or later and the
// fuse is off.
//
// The choice is written next to cli.js (file `runtime`) and read by bin/witsy.

export type CliRuntime = 'electron' | 'node';

export const kCliRuntimeFile = 'runtime';

export function cliRuntime(_platform: string, env: Record<string, string | undefined> = process.env): CliRuntime {
  return env.WITSY_CLI_RUNTIME === 'node' ? 'node' : 'electron';
}

/**
 * The RunAsNode fuse is only needed when the CLI runs on the app binary.
 */
export function runAsNodeFuse(platform: string, env: Record<string, string | undefined> = process.env): boolean {
  return cliRuntime(platform, env) === 'electron';
}

/**
 * Tells the CLI launcher of this build which Node.js it must use.
 * @param cliDir the folder cli.js is in (dist/cli)
 */
export function writeCliRuntime(cliDir: string, runtime: CliRuntime): void {
  fs.writeFileSync(path.join(cliDir, kCliRuntimeFile), `${runtime}\n`);
}
