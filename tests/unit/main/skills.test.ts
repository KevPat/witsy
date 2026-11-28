import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { loadSettings } from '@main/config'
import extractZip from 'extract-zip'
import { createSkill, defaultSkillLocations, extractRepoAndSkillFromInstallInput, getSkillFile, installSkillFromUrl, listSkills, loadSkill, uninstallSkill, updateSkill } from '@main/skills'

vi.mock('@main/config', () => ({
  loadSettings: vi.fn(),
}))

vi.mock('extract-zip', () => ({
  default: vi.fn(),
}))

let tmpDir = ''
let homeDir = ''
let userDataDir = ''
let customLocation = ''
const workspaceId = 'workspace-1'

const createTestApp = () => ({
  getPath: (name: string) => {
    if (name === 'home') return homeDir
    if (name === 'userData') return userDataDir
    return tmpDir
  }
}) as any

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-skills-'))
  homeDir = path.join(tmpDir, 'home')
  userDataDir = path.join(tmpDir, 'userdata')
  customLocation = path.join(tmpDir, 'custom-skills')

  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(customLocation, { recursive: true })

  const skillRoot = path.join(customLocation, 'test-skill')
  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `---
name: testing-skill
description: Skill for unit tests
---

# Test Skill
`)
  fs.writeFileSync(path.join(skillRoot, 'scripts', 'helper.py'), 'print("hello")\nprint("world")\n')
  fs.writeFileSync(path.join(skillRoot, 'notes.txt'), 'alpha\nbeta\ngamma\n')

  vi.mocked(loadSettings).mockReturnValue({
    skills: {
      locations: [customLocation]
    }
  } as any)
})

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

test('defaultSkillLocations returns expected paths', () => {
  const app = createTestApp()
  const locations = defaultSkillLocations(app, workspaceId)
  expect(locations).toEqual([
    path.join(userDataDir, 'skills'),
  ])
  expect(fs.existsSync(path.join(userDataDir, 'skills'))).toBe(true)
})

test('listSkills discovers skills from configured locations', () => {
  const app = createTestApp()
  const skills = listSkills(app, workspaceId)
  expect(skills).toHaveLength(1)
  expect(skills[0].name).toBe('testing-skill')
  expect(skills[0].description).toBe('Skill for unit tests')
  expect(skills[0].id).toMatch(/^skill_[a-f0-9]{12}$/)
})

test('loadSkill returns SKILL.md and manifest', () => {
  const app = createTestApp()
  const skill = listSkills(app, workspaceId)[0]
  const loaded = loadSkill(app, workspaceId, skill.id)
  expect(loaded).not.toBeNull()
  expect(loaded?.instructions).toContain('name: testing-skill')
  expect(loaded?.available_files.some(file => file.path === 'scripts/helper.py')).toBe(true)
})

test('getSkillFile reads line ranges', () => {
  const app = createTestApp()
  const skill = listSkills(app, workspaceId)[0]
  const result = getSkillFile(app, workspaceId, skill.id, 'notes.txt', 2, 3)
  expect(result.success).toBe(true)
  expect(result.content).toBe('beta\ngamma')
  expect(result.startLine).toBe(2)
  expect(result.endLine).toBe(3)
})

test('getSkillFile blocks path traversal', () => {
  const app = createTestApp()
  const skill = listSkills(app, workspaceId)[0]
  const result = getSkillFile(app, workspaceId, skill.id, '../outside.txt')
  expect(result.success).toBe(false)
  expect(result.error).toContain('escapes skill directory')
})

const isPosix = process.platform !== 'win32'

const createOutsideSecrets = () => {
  const outsideDir = path.join(tmpDir, 'outside')
  fs.mkdirSync(path.join(outsideDir, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET\n')
  fs.writeFileSync(path.join(outsideDir, 'nested', 'deep.txt'), 'TOP SECRET\n')
  fs.writeFileSync(path.join(customLocation, 'sibling.txt'), 'TOP SECRET\n')
  return outsideDir
}

test.runIf(isPosix)('getSkillFile does not follow links that leave the skill folder', () => {
  const app = createTestApp()
  const outsideDir = createOutsideSecrets()
  const skillRoot = path.join(customLocation, 'test-skill')
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(skillRoot, 'link.txt'))
  fs.symlinkSync(path.join('..', 'sibling.txt'), path.join(skillRoot, 'relative-link.txt'))
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(skillRoot, 'scripts', 'link.py'))
  fs.symlinkSync(outsideDir, path.join(skillRoot, 'linked-dir'))
  fs.symlinkSync(path.join(skillRoot, 'linked-dir'), path.join(skillRoot, 'link-to-link'))
  fs.symlinkSync(path.join(outsideDir, 'missing.txt'), path.join(skillRoot, 'dangling.txt'))

  const skill = listSkills(app, workspaceId)[0]
  for (const relativePath of [
    'link.txt',
    './link.txt',
    'relative-link.txt',
    'scripts/link.py',
    'scripts/../link.txt',
    'linked-dir/secret.txt',
    'linked-dir/nested/deep.txt',
    'link-to-link/secret.txt',
    'dangling.txt',
    path.join(skillRoot, 'link.txt'),
    path.join(skillRoot, 'linked-dir', 'secret.txt'),
  ]) {
    const result = getSkillFile(app, workspaceId, skill.id, relativePath)
    expect(result, relativePath).toStrictEqual({ success: false, error: 'Path escapes skill directory' })
  }

  // regular files next to the links are still served
  expect(getSkillFile(app, workspaceId, skill.id, 'notes.txt').content).toBe('alpha\nbeta\ngamma\n')
  expect(getSkillFile(app, workspaceId, skill.id, 'scripts/helper.py', 1, 1).content).toBe('print("hello")')
  expect(getSkillFile(app, workspaceId, skill.id, path.join(skillRoot, 'notes.txt'), 1, 1).content).toBe('alpha')
})

test.runIf(isPosix)('getSkillFile follows links that stay inside the skill folder', () => {
  const app = createTestApp()
  const skillRoot = path.join(customLocation, 'test-skill')
  fs.symlinkSync(path.join(skillRoot, 'notes.txt'), path.join(skillRoot, 'alias.txt'))
  fs.symlinkSync('scripts', path.join(skillRoot, 'bin'))

  const skill = listSkills(app, workspaceId)[0]
  expect(getSkillFile(app, workspaceId, skill.id, 'alias.txt', 2, 2)).toMatchObject({ success: true, content: 'beta' })
  expect(getSkillFile(app, workspaceId, skill.id, 'bin/helper.py', 2, 2)).toMatchObject({ success: true, content: 'print("world")' })
})

test.runIf(isPosix)('getSkillFile reads a skill whose location is reached through a link', () => {
  const app = createTestApp()
  const linkedLocation = path.join(tmpDir, 'linked-skills')
  fs.symlinkSync(customLocation, linkedLocation)
  vi.mocked(loadSettings).mockReturnValue({ skills: { locations: [linkedLocation] } } as any)

  const skill = listSkills(app, workspaceId)[0]
  expect(skill.rootPath).toBe(path.join(linkedLocation, 'test-skill'))
  expect(skill.skillMdPath).toBe(path.join(linkedLocation, 'test-skill', 'SKILL.md'))
  expect(getSkillFile(app, workspaceId, skill.id, 'notes.txt', 1, 1)).toMatchObject({ success: true, content: 'alpha' })
  expect(getSkillFile(app, workspaceId, skill.id, '../outside.txt').success).toBe(false)
})

test('getSkillFile refuses the skill folder itself and invalid paths', () => {
  const app = createTestApp()
  const skill = listSkills(app, workspaceId)[0]
  for (const relativePath of ['.', './', 'scripts/..', skill.rootPath]) {
    expect(getSkillFile(app, workspaceId, skill.id, relativePath), relativePath).toStrictEqual({ success: false, error: 'Path escapes skill directory' })
  }
  for (const relativePath of ['', '   ', null, undefined, 42, { path: 'notes.txt' }]) {
    expect(getSkillFile(app, workspaceId, skill.id, relativePath as any), String(relativePath)).toStrictEqual({ success: false, error: 'File path is required' })
  }
  expect(getSkillFile(app, workspaceId, skill.id, 'notes.txt\0.md').success).toBe(false)
})

test.runIf(isPosix)('loadSkill does not list or follow links in the skill folder', () => {
  const app = createTestApp()
  const outsideDir = createOutsideSecrets()
  const skillRoot = path.join(customLocation, 'test-skill')
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(skillRoot, 'link.txt'))
  fs.symlinkSync(outsideDir, path.join(skillRoot, 'linked-dir'))
  fs.symlinkSync(outsideDir, path.join(skillRoot, 'scripts', 'linked-dir'))
  fs.symlinkSync(path.join(outsideDir, 'missing.txt'), path.join(skillRoot, 'dangling.txt'))

  const skill = listSkills(app, workspaceId)[0]
  const loaded = loadSkill(app, workspaceId, skill.id)
  expect(loaded?.available_files.map(file => file.path).sort()).toStrictEqual(['SKILL.md', 'notes.txt', 'scripts/helper.py'])
})

test.runIf(isPosix)('a SKILL.md that links outside of its folder is not loaded as a skill', () => {
  const app = createTestApp()
  const outsideDir = createOutsideSecrets()
  const evilRoot = path.join(customLocation, 'evil-skill')
  fs.mkdirSync(evilRoot)
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(evilRoot, 'SKILL.md'))

  const skills = listSkills(app, workspaceId)
  expect(skills.map(skill => skill.rootPath)).toStrictEqual([path.join(customLocation, 'test-skill')])

  // a SKILL.md that links to a file of its own folder is still a skill
  const aliasRoot = path.join(customLocation, 'alias-skill')
  fs.mkdirSync(aliasRoot)
  fs.writeFileSync(path.join(aliasRoot, 'README.md'), '---\nname: alias-skill\ndescription: Linked\n---\n\n# Alias\n')
  fs.symlinkSync('README.md', path.join(aliasRoot, 'SKILL.md'))
  const alias = listSkills(app, workspaceId).find(skill => skill.rootPath === aliasRoot)
  expect(alias?.name).toBe('alias-skill')
  expect(loadSkill(app, workspaceId, alias!.id)?.instructions).toContain('# Alias')
})

test('installSkillFromUrl installs all discovered skills (root and subfolders)', async () => {
  const app = createTestApp()
  const installPath = path.join(tmpDir, 'installed-skills')

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://api.github.com/repos/nicobailon/visual-explainer') {
      return {
        ok: true,
        json: async () => ({ default_branch: 'main' }),
      } as any
    }
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as any
  }))

  vi.mocked(extractZip).mockImplementation(async (_zipFile: string, opts: { dir: string }) => {
    const root = path.join(opts.dir, 'visual-explainer-main')
    const nestedSkillRoot = path.join(root, '.claude', 'skills', 'visual-explainer')
    fs.mkdirSync(nestedSkillRoot, { recursive: true })
    fs.writeFileSync(path.join(root, 'SKILL.md'), `---
name: Root Skill
description: Root level skill
---
`)
    fs.writeFileSync(path.join(nestedSkillRoot, 'SKILL.md'), `---
name: Visual Explainer
description: Explain visuals
---
`)
    fs.writeFileSync(path.join(nestedSkillRoot, 'README.md'), '# hello')
  })

  const result = await installSkillFromUrl(app, 'https://github.com/nicobailon/visual-explainer', installPath)
  expect(result.success).toBe(true)
  expect(result.location).toBe(installPath)
  expect(result.installed).toHaveLength(2)
  expect(result.installed).toContain('root-skill')
  expect(result.installed).toContain('visual-explainer')
  expect(fs.existsSync(path.join(installPath, 'root-skill', 'SKILL.md'))).toBe(true)
  expect(fs.existsSync(path.join(installPath, 'visual-explainer', 'SKILL.md'))).toBe(true)
})

test('installSkillFromUrl rejects unsupported URLs', async () => {
  const app = createTestApp()
  const result = await installSkillFromUrl(app, 'https://example.com/skills/repo', path.join(tmpDir, 'installed'))
  expect(result.success).toBe(false)
  expect(result.error).toContain('Provide a GitHub URL or a skills install command')
})

test('extractRepoAndSkillFromInstallInput parses skills command', () => {
  const parsed = extractRepoAndSkillFromInstallInput('npx skills add https://github.com/anthropics/skills --skill frontend-design')
  expect(parsed).toEqual({
    repoUrl: 'https://github.com/anthropics/skills',
    skillName: 'frontend-design',
  })
})

test('extractRepoAndSkillFromInstallInput parses github tree url', () => {
  const parsed = extractRepoAndSkillFromInstallInput('https://github.com/anthropics/skills/tree/main/skills/brand-guidelines')
  expect(parsed).toEqual({
    repoUrl: 'https://github.com/anthropics/skills',
    branch: 'main',
    repoSubPath: 'skills/brand-guidelines',
  })
})

test('installSkillFromUrl installs only skills under github tree subpath', async () => {
  const app = createTestApp()
  const installPath = path.join(tmpDir, 'installed-tree-skills')

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://api.github.com/repos/anthropics/skills') {
      return {
        ok: true,
        json: async () => ({ default_branch: 'main' }),
      } as any
    }
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as any
  }))

  vi.mocked(extractZip).mockImplementation(async (_zipFile: string, opts: { dir: string }) => {
    const root = path.join(opts.dir, 'skills-main')
    const selected = path.join(root, 'skills', 'brand-guidelines')
    const ignored = path.join(root, 'skills', 'other-skill')
    fs.mkdirSync(selected, { recursive: true })
    fs.mkdirSync(ignored, { recursive: true })
    fs.writeFileSync(path.join(selected, 'SKILL.md'), `---\nname: Brand Guidelines\n---\n`)
    fs.writeFileSync(path.join(ignored, 'SKILL.md'), `---\nname: Other Skill\n---\n`)
  })

  const result = await installSkillFromUrl(app, 'https://github.com/anthropics/skills/tree/main/skills/brand-guidelines', installPath)
  expect(result.success).toBe(true)
  expect(result.installed).toEqual(['brand-guidelines'])
  expect(fs.existsSync(path.join(installPath, 'brand-guidelines', 'SKILL.md'))).toBe(true)
  expect(fs.existsSync(path.join(installPath, 'other-skill', 'SKILL.md'))).toBe(false)
})

test('uninstallSkill removes skills installed in global folder', () => {
  const app = createTestApp()
  const globalSkills = path.join(userDataDir, 'skills')
  const localSkill = path.join(globalSkills, 'local-skill')
  fs.mkdirSync(localSkill, { recursive: true })
  fs.writeFileSync(path.join(localSkill, 'SKILL.md'), '# local skill')

  const skill = listSkills(app, workspaceId).find(item => item.rootPath === localSkill)
  expect(skill).toBeTruthy()

  const result = uninstallSkill(app, workspaceId, skill!.id)
  expect(result.success).toBe(true)
  expect(fs.existsSync(localSkill)).toBe(false)
})

test('uninstallSkill removes skills outside system folder', () => {
  const app = createTestApp()
  const skill = listSkills(app, workspaceId)[0]
  const result = uninstallSkill(app, workspaceId, skill.id)
  expect(result.success).toBe(true)
  expect(fs.existsSync(skill.rootPath)).toBe(false)
})

test('createSkill writes SKILL.md in witsy system location', () => {
  const app = createTestApp()
  const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined as any)
  const result = createSkill(app, workspaceId, {
    name: 'My Skill',
    description: 'Description',
    instructions: 'Do this first.',
  })
  expect(result.success).toBe(true)
  expect(result.rootPath).toContain(path.join('userdata', 'skills'))
  expect(writeSpy).toHaveBeenCalledOnce()
  expect(writeSpy).toHaveBeenCalledWith(path.join(result.rootPath!, 'SKILL.md'), expect.any(String), 'utf-8')
  const skillMd = writeSpy.mock.calls[0][1] as string
  expect(skillMd).toContain('name: my-skill')
  expect(skillMd).toContain('description: Description')
  expect(skillMd).toContain('Do this first.')
  writeSpy.mockRestore()
})

test('createSkill aligns SKILL.md name with folder name', () => {
  const app = createTestApp()
  const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined as any)
  const result = createSkill(app, workspaceId, {
    name: 'Test',
    description: 'Description',
    instructions: 'Do this first.',
  })
  expect(result.success).toBe(true)
  expect(path.basename(result.rootPath!)).toBe('test')
  const skillMd = writeSpy.mock.calls[0][1] as string
  expect(skillMd).toContain('name: test')
  writeSpy.mockRestore()
})

test('updateSkill only allows editing witsy location skills', () => {
  const app = createTestApp()
  const globalSkills = path.join(userDataDir, 'skills')
  const editableSkill = path.join(globalSkills, 'editable-skill')
  fs.mkdirSync(editableSkill, { recursive: true })
  fs.writeFileSync(path.join(editableSkill, 'SKILL.md'), `---\nname: editable-skill\ndescription: Initial\n---\n\nv1\n`)
  const created = listSkills(app, workspaceId).find(skill => skill.rootPath === editableSkill)
  expect(created).toBeTruthy()

  const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined as any)
  const updated = updateSkill(app, workspaceId, created!.id, {
    name: 'Editable Skill',
    description: 'Updated',
    instructions: 'v2',
  })
  expect(updated.success).toBe(true)
  expect(writeSpy).toHaveBeenCalledWith(path.join(editableSkill, 'SKILL.md'), expect.any(String), 'utf-8')
  const skillMd = writeSpy.mock.calls[0][1] as string
  expect(skillMd).toContain('name: editable-skill')
  expect(skillMd).toContain('v2')

  const externalSkill = listSkills(app, workspaceId).find(skill => skill.rootPath.startsWith(customLocation))
  expect(externalSkill).toBeTruthy()
  const rejected = updateSkill(app, workspaceId, externalSkill!.id, {
    name: 'Nope',
    description: 'Nope',
    instructions: 'Nope',
  })
  expect(rejected.success).toBe(false)
  expect(rejected.error).toContain('Only skills in Witsy locations can be edited')
  writeSpy.mockRestore()
})
