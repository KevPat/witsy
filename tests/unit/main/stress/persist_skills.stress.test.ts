
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import extractZip from 'extract-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettings } from '@main/config'
import { createSkill, extractRepoAndSkillFromInstallInput, getSkillFile, installSkillFromUrl, listSkills, loadSkill, uninstallSkill, updateSkill } from '@main/skills'
import { bug, isPosix } from './bug'

vi.mock('@main/config', () => ({
  loadSettings: vi.fn(),
}))

vi.mock('extract-zip', () => ({
  default: vi.fn(),
}))

// deterministic PRNG so a failing fuzz case can be replayed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const workspaceId = 'workspace-1'

// everything lives in <root>/nested so that a folder escaping by one or two levels still lands inside the temp root
let root: string
let nested: string
let homeDir: string
let userData: string
let customLocation: string
let fakeCwd: string

const app = {
  getPath: (name: string) => {
    if (name === 'home') return homeDir
    if (name === 'userData') return userData
    return nested
  }
} as any

const skillsDir = () => path.join(userData, 'skills')

const writeText = (target: string, text: string): string => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
  return target
}

const skillMd = (name: string) => `---\nname: ${name}\ndescription: A skill\n---\n\n# ${name}\n`

// every file and folder below dir, relative, sorted
const tree = (dir: string): string[] => {
  const result: string[] = []
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name)
      result.push(path.relative(dir, full).split(path.sep).join('/'))
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return result.sort()
}

// the process working directory, as seen by path.resolve, becomes a folder of the temp root
const useFakeCwd = () => {
  vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd)
}

// GitHub answers without network: the default branch is main and the zip "contains" the given files
const stubGithub = (files: Record<string, string>) => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('https://api.github.com/repos/')) {
      return { ok: true, json: async () => ({ default_branch: 'main' }) } as any
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as any
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(os, 'tmpdir').mockReturnValue(path.join(root, 'tmp'))
  vi.mocked(extractZip).mockImplementation(async (_zipFile: string, opts: { dir: string }) => {
    for (const [name, text] of Object.entries(files)) writeText(path.join(opts.dir, 'repo-main', name), text)
  })
  return fetchMock
}

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-skills-'))
  nested = path.join(root, 'nested')
  homeDir = path.join(nested, 'home')
  userData = path.join(nested, 'userData')
  customLocation = path.join(nested, 'custom-skills')
  fakeCwd = path.join(nested, 'cwd')
  for (const dir of [homeDir, userData, customLocation, fakeCwd, path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true })
  vi.mocked(loadSettings).mockReturnValue({ skills: { locations: [customLocation] } } as any)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('creating skills', () => {

  test('fuzz: 120 skills with arbitrary names are created inside the skills folder, listed and loadable', () => {
    const rand = mulberry32(20261129)
    const alphabet = ['a', 'B', 'c', '7', ' ', ' ', '.', '..', '/', '\\', ':', '*', '?', '"', '<', '>', '|', '-', '_', 'é', '日本', '~', '$', '%', '\t']
    const before = tree(nested)
    const roots = new Set<string>()
    for (let i = 0; i < 120; i++) {
      // a letter at each end: names made of dots only, or ending with a dot, are the subject of the bug tests below
      let name = 's'
      const length = Math.floor(rand() * 12)
      for (let c = 0; c < length; c++) name += alphabet[Math.floor(rand() * alphabet.length)]
      name += 'x'
      const result = createSkill(app, workspaceId, { name, description: 'd', instructions: `instructions ${i}` })
      expect(result.success, name).toBe(true)
      expect(path.dirname(result.rootPath), name).toBe(skillsDir())
      expect(path.basename(result.rootPath), name).toMatch(/^[a-z0-9._-]+$/)
      roots.add(result.rootPath)
    }
    expect(roots.size).toBe(120)
    const listed = listSkills(app, workspaceId)
    expect(listed.map(skill => skill.rootPath).sort()).toEqual([...roots].sort())
    expect(new Set(listed.map(skill => skill.id)).size).toBe(120)
    for (const skill of listed.slice(0, 20)) {
      expect(loadSkill(app, workspaceId, skill.id).available_files.map(f => f.path)).toEqual(['SKILL.md'])
    }
    // nothing was written anywhere else
    expect(tree(nested).filter(entry => !entry.startsWith('userData/skills'))).toEqual(before)
  })

  test('the same name used 30 times gives 30 different skills', () => {
    const roots = Array.from({ length: 30 }, () => createSkill(app, workspaceId, { name: 'My Skill', instructions: 'x' }).rootPath)
    expect(new Set(roots).size).toBe(30)
    expect(roots.map(r => path.basename(r)).slice(0, 3)).toEqual(['my-skill', 'my-skill-2', 'my-skill-3'])
  })

  test('a skill can be updated and uninstalled without touching its neighbours', () => {
    const one = createSkill(app, workspaceId, { name: 'one', instructions: 'first' })
    const two = createSkill(app, workspaceId, { name: 'two', instructions: 'second' })
    expect(updateSkill(app, workspaceId, one.skillId, { name: 'ignored', description: 'new', instructions: 'updated' }).success).toBe(true)
    expect(loadSkill(app, workspaceId, one.skillId).instructions).toContain('updated')
    expect(uninstallSkill(app, workspaceId, one.skillId)).toEqual({ success: true, removedPath: one.rootPath })
    expect(listSkills(app, workspaceId).map(skill => skill.id)).toEqual([two.skillId])
    expect(tree(skillsDir())).toEqual(['two', 'two/SKILL.md'])
  })

  test.each([
    ['..'],
    [' .. '],
    ['../'],
    ['.'],
    ['./'],
    ['?.?'],
  ])('a skill named "%s" is created inside the skills folder', (name) => {
    // sanitizeFolderName keeps dots: ".." resolves to the userData folder, which exists, so the skill goes to a "<userData>-2" sibling ("." goes to "skills-2")
    const result = createSkill(app, workspaceId, { name, instructions: 'x' })
    expect(result.success).toBe(true)
    expect(path.dirname(result.rootPath)).toBe(skillsDir())
  })

  test.each([
    ['con'],
    ['NUL'],
    ['aux'],
    ['prn'],
    ['com1'],
    ['lpt1'],
    ['con.md'],
    ['notes.'],
    ['v1...'],
  ])('a skill named "%s" gets a folder name that is valid on Windows', (name) => {
    // reserved device names and trailing dots pass through sanitizeFolderName unchanged
    const result = createSkill(app, workspaceId, { name, instructions: 'x' })
    const folder = result.rootPath ? path.basename(result.rootPath) : ''
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(folder) || /[. ]$/.test(folder)
    expect({ success: result.success, reserved }).toEqual({ success: true, reserved: false })
  })

})

describe('reading skill files', () => {

  let skillId: string
  let skillRoot: string

  beforeEach(() => {
    skillRoot = path.join(customLocation, 'reader')
    writeText(path.join(skillRoot, 'SKILL.md'), skillMd('reader'))
    writeText(path.join(skillRoot, 'docs', 'guide.md'), 'line 1\nline 2\nline 3\n')
    writeText(path.join(customLocation, 'secret.txt'), 'TOP SECRET')
    writeText(path.join(nested, 'private', 'secret.txt'), 'TOP SECRET')
    skillId = listSkills(app, workspaceId).find(skill => skill.rootPath === skillRoot).id
  })

  test('fuzz: no relative path made of dots, slashes and names reads a file outside the skill', () => {
    const rand = mulberry32(99)
    const parts = ['..', '.', 'docs', 'guide.md', 'secret.txt', 'private', '', 'reader', 'custom-skills', 'nested']
    const candidates = [
      '../secret.txt', 'docs/../../secret.txt', './../secret.txt', '..', '.', 'docs/..', '../reader/../secret.txt',
      path.join(customLocation, 'secret.txt'), path.join(nested, 'private', 'secret.txt'), '../../private/secret.txt',
    ]
    while (candidates.length < 400) {
      const length = 1 + Math.floor(rand() * 6)
      candidates.push(Array.from({ length }, () => parts[Math.floor(rand() * parts.length)]).join(rand() < 0.9 ? '/' : path.sep))
    }
    for (const candidate of candidates) {
      const result = getSkillFile(app, workspaceId, skillId, candidate)
      expect(result.content ?? '', candidate).not.toContain('TOP SECRET')
    }
    expect(getSkillFile(app, workspaceId, skillId, 'docs/./guide.md', 2, 2)).toMatchObject({ success: true, content: 'line 2' })
  })

  bug.runIf(isPosix)('a file of the skill that is a link to a file outside of it is not returned', () => {
    // the containment check compares path strings only, and readFileSync follows the link
    fs.symlinkSync(path.join(nested, 'private', 'secret.txt'), path.join(skillRoot, 'notes.txt'))
    expect(getSkillFile(app, workspaceId, skillId, 'notes.txt')).toMatchObject({ success: false })
  })

  bug.runIf(isPosix)('a file reached through a linked folder that leaves the skill is not returned', () => {
    // same string-only check: docs-link/secret.txt is "inside" the skill but resolves outside of it
    fs.symlinkSync(path.join(nested, 'private'), path.join(skillRoot, 'docs-link'))
    expect(getSkillFile(app, workspaceId, skillId, 'docs-link/secret.txt')).toMatchObject({ success: false })
  })

  test.runIf(isPosix)('a link that stays inside the skill is not listed in the manifest', () => {
    fs.symlinkSync(path.join(skillRoot, 'docs', 'guide.md'), path.join(skillRoot, 'alias.md'))
    expect(loadSkill(app, workspaceId, skillId).available_files.map(f => f.path)).toEqual(['docs/guide.md', 'SKILL.md'])
  })

  test('an empty entry in the configured locations does not make the working directory a skill location', () => {
    // resolveSkillLocations resolves '' to the working directory before its filter(Boolean), which therefore never removes anything
    writeText(path.join(fakeCwd, 'SKILL.md'), skillMd('whatever is in the working directory'))
    vi.mocked(loadSettings).mockReturnValue({ skills: { locations: [customLocation, ''] } } as any)
    useFakeCwd()
    const roots = listSkills(app, workspaceId).map(skill => skill.rootPath)
    vi.mocked(process.cwd).mockRestore()
    expect(roots).toEqual([skillRoot])
  })

})

describe('installing skills', () => {

  test.each([
    ['https://github.com/owner/repo', { repoUrl: 'https://github.com/owner/repo' }],
    ['https://github.com/owner/repo.git', { repoUrl: 'https://github.com/owner/repo' }],
    ['https://github.com/owner/repo/tree/dev/skills/pdf', { repoUrl: 'https://github.com/owner/repo', branch: 'dev', repoSubPath: 'skills/pdf' }],
    ['npx skills add https://github.com/owner/repo --skill "My Skill"', { repoUrl: 'https://github.com/owner/repo', skillName: 'My Skill' }],
    ['npx skills add https://github.com/owner/repo --skill=pdf', { repoUrl: 'https://github.com/owner/repo', skillName: 'pdf' }],
  ])('install input is understood: %s', (input, expected) => {
    expect(extractRepoAndSkillFromInstallInput(input)).toEqual(expected)
  })

  test.each([
    [''],
    ['   '],
    ['owner/repo'],
    ['https://gitlab.com/owner/repo'],
    ['https://github.com/owner'],
    ['https://github.com.evil.example/owner/repo'],
    ['npx skills add --skill pdf'],
  ])('install input is refused without any download: "%s"', async (input) => {
    const fetchMock = stubGithub({})
    expect(extractRepoAndSkillFromInstallInput(input)).toBeNull()
    expect(await installSkillFromUrl(app, input, path.join(nested, 'installed'))).toMatchObject({ success: false, installed: [] })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(nested, 'installed'))).toBe(false)
  })

  test('skills of a repository are copied into the install path, twice without overwriting, and the download folder is removed', async () => {
    stubGithub({ 'skills/pdf/SKILL.md': skillMd('PDF Tools'), 'skills/pdf/scripts/run.py': 'print(1)', 'skills/docx/SKILL.md': skillMd('docx'), 'README.md': '# repo' })
    const installPath = path.join(nested, 'installed', 'skills')
    const first = await installSkillFromUrl(app, 'https://github.com/owner/repo', installPath)
    expect(first).toMatchObject({ success: true, location: installPath })
    expect([...first.installed].sort()).toEqual(['docx', 'pdf-tools'])
    const second = await installSkillFromUrl(app, 'https://github.com/owner/repo', installPath)
    expect([...second.installed].sort()).toEqual(['docx-2', 'pdf-tools-2'])
    expect(tree(installPath)).toEqual([
      'docx', 'docx-2', 'docx-2/SKILL.md', 'docx/SKILL.md',
      'pdf-tools', 'pdf-tools-2', 'pdf-tools-2/SKILL.md', 'pdf-tools-2/scripts', 'pdf-tools-2/scripts/run.py',
      'pdf-tools/SKILL.md', 'pdf-tools/scripts', 'pdf-tools/scripts/run.py',
    ])
    expect(vi.mocked(os.tmpdir)).toHaveBeenCalledTimes(2)
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([])
  })

  test('a failed download installs nothing and removes the download folder', async () => {
    stubGithub({})
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as any))
    const installPath = path.join(nested, 'installed', 'skills')
    expect(await installSkillFromUrl(app, 'https://github.com/owner/repo', installPath)).toMatchObject({ success: false, installed: [], error: 'GitHub API error (404)' })
    expect(fs.readdirSync(installPath)).toEqual([])
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([])
  })

  bug.each([
    ['https://github.com/owner/repo/tree/dev'],
    ['https://github.com/owner/repo/tree/dev/'],
    ['npx skills add https://github.com/owner/repo/tree/dev --skill pdf'],
  ])('the branch of a tree URL without sub folder is used: %s', (input) => {
    // the branch is only read when the URL has at least one path segment after it
    expect(extractRepoAndSkillFromInstallInput(input)).toMatchObject({ repoUrl: 'https://github.com/owner/repo', branch: 'dev' })
  })

  bug('installing from a tree URL without sub folder downloads that branch', async () => {
    // same parsing gap: the default branch is looked up and downloaded instead
    const fetchMock = stubGithub({ 'skills/pdf/SKILL.md': skillMd('pdf') })
    await installSkillFromUrl(app, 'https://github.com/owner/repo/tree/dev', path.join(nested, 'installed', 'skills'))
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://codeload.github.com/owner/repo/zip/refs/heads/dev'])
  })

  test.each([
    ['..'],
    ['"../"'],
    ['.'],
  ])('a repository skill whose SKILL.md is named %s is installed inside the install path', async (name) => {
    // the name of the SKILL.md front matter becomes the folder name through sanitizeFolderName, which keeps ".." and "."
    stubGithub({ 'skills/evil/SKILL.md': skillMd(name), 'skills/evil/payload.sh': 'echo hi' })
    const installPath = path.join(nested, 'installed', 'skills')
    const result = await installSkillFromUrl(app, 'https://github.com/owner/repo', installPath)
    expect(result.installed).toHaveLength(1)
    expect(tree(nested).filter(entry => entry.endsWith('payload.sh'))).toEqual([`installed/skills/${result.installed[0]}/payload.sh`])
  })

  test('an empty install path is refused', async () => {
    // normalizePath('') is the working directory, never empty: the "Install path is required" check cannot trigger and the skills land in the working directory
    const fetchMock = stubGithub({ 'skills/pdf/SKILL.md': skillMd('pdf') })
    useFakeCwd()
    const result = await installSkillFromUrl(app, 'https://github.com/owner/repo', '')
    vi.mocked(process.cwd).mockRestore()
    expect({ error: result.error, downloads: fetchMock.mock.calls.length, inWorkingDirectory: fs.readdirSync(fakeCwd) })
      .toEqual({ error: 'Install path is required', downloads: 0, inWorkingDirectory: [] })
  })

})
