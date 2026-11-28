import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { executeCommand, analyzeCommand, validateWorkingDirectory } from '../../../src/main/shell'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, sep } from 'path'

describe('Shell Executor', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'shell-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('Command Analysis', () => {
    it('should detect dangerous rm -rf commands', () => {
      const result = analyzeCommand('rm -rf /')
      expect(result.isDangerous).toBe(true)
      expect(result.dangersDetected).toContain('recursive file deletion (rm -rf)')
    })

    it('should detect fork bombs', () => {
      const result = analyzeCommand(':(){ :|:& };:')
      expect(result.isDangerous).toBe(true)
      expect(result.dangersDetected).toContain('fork bomb')
    })

    it('should detect sudo commands', () => {
      const result = analyzeCommand('sudo rm -rf /')
      expect(result.isDangerous).toBe(true)
      expect(result.dangersDetected).toContain('privilege escalation (sudo)')
    })

    it('should allow command chaining operators', () => {
      // COMMENTED OUT: Command chaining is now allowed
      const result = analyzeCommand('ls && rm file')
      expect(result.hasForbiddenOperators).toBe(false)
      expect(result.dangersDetected).not.toContain('command chaining operators (&&, ||, ;)')
    })

    it('should allow safe commands', () => {
      const result = analyzeCommand('ls -la')
      expect(result.isDangerous).toBe(false)
      expect(result.hasForbiddenOperators).toBe(false)
    })

    it('should allow pipes and redirects', () => {
      const result = analyzeCommand('cat file.txt | grep pattern > output.txt')
      expect(result.hasForbiddenOperators).toBe(false)
    })

    describe('Project Context Blocking', () => {
      // Unix commands
      it('should block rm in project context', () => {
        const result = analyzeCommand('rm file.txt', '/project')
        expect(result.blockedCommand).toBe('rm')
      })

      it('should block rmdir in project context', () => {
        const result = analyzeCommand('rmdir folder', '/project')
        expect(result.blockedCommand).toBe('rm')
      })

      it('should block mv in project context', () => {
        const result = analyzeCommand('mv a.txt b.txt', '/project')
        expect(result.blockedCommand).toBe('mv')
      })

      // PowerShell commands
      it('should block Remove-Item in project context', () => {
        const result = analyzeCommand('Remove-Item file.txt', '/project')
        expect(result.blockedCommand).toBe('Remove-Item')
      })

      it('should block del in project context', () => {
        const result = analyzeCommand('del file.txt', '/project')
        expect(result.blockedCommand).toBe('Remove-Item')
      })

      it('should block Move-Item in project context', () => {
        const result = analyzeCommand('Move-Item a.txt b.txt', '/project')
        expect(result.blockedCommand).toBe('Move-Item')
      })

      // Edge cases with embedded commands
      it('should block rm in find -exec', () => {
        const result = analyzeCommand('find . -exec rm {} \\;', '/project')
        expect(result.blockedCommand).toBe('rm')
      })

      it('should block rm after xargs', () => {
        const result = analyzeCommand('ls | xargs rm', '/project')
        expect(result.blockedCommand).toBe('rm')
      })

      // Without project context - should allow
      it('should allow rm without project context', () => {
        const result = analyzeCommand('rm file.txt')
        expect(result.blockedCommand).toBeUndefined()
      })

      it('should allow mv without project context', () => {
        const result = analyzeCommand('mv a.txt b.txt')
        expect(result.blockedCommand).toBeUndefined()
      })

      // Safe commands still work in project context
      it('should allow ls in project context', () => {
        const result = analyzeCommand('ls -la', '/project')
        expect(result.blockedCommand).toBeUndefined()
        expect(result.isDangerous).toBe(false)
      })

      it('should allow grep in project context', () => {
        const result = analyzeCommand('grep pattern file.txt', '/project')
        expect(result.blockedCommand).toBeUndefined()
        expect(result.isDangerous).toBe(false)
      })

      it('should allow cat in project context', () => {
        const result = analyzeCommand('cat file.txt', '/project')
        expect(result.blockedCommand).toBeUndefined()
        expect(result.isDangerous).toBe(false)
      })
    })

    describe('Command tokens', () => {

      it.each([
        'cat format.txt',
        'git log --format=%H',
        'git log --format=%H -n 1',
        'npm run format',
        'echo rm',
        'echo "rm -rf /"',
        'echo \'sudo mv a b\'',
        'ls -la | grep dd',
        'git add dd.txt',
        'git rm --cached file.txt',
        'npm rm lodash',
        'grep -rn "rm " src',
        'grep -E "del|rd|ri|mi" notes.txt',
        'ls rm mv',
        'cat su.txt sudo.txt fdisk.log mkfs.md',
        'git branch --del old',
        './mvnw test',
        'echo done # rm -rf /',
        'curl -s https://example.com/data.json | python3 -m json.tool',
        'curl -s https://example.com/data.json | shasum',
        'bash -c "curl -s https://example.com | wc -l"',
        'echo text > /dev/null 2>&1',
        'echo "> /dev/sda"',
        'chmod 644 file.txt',
      ])('should not flag or block: %s', (command) => {
        const result = analyzeCommand(command, '/project')
        expect(result.blockedCommand).toBeUndefined()
        expect(result.isDangerous).toBe(false)
        expect(result.dangersDetected).toEqual([])
      })

      it.each([
        ['rm -rf x', 'rm'],
        ['/bin/rm x', 'rm'],
        ['/usr/bin/unlink x', 'rm'],
        ['sudo rm x', 'rm'],
        ['sudo -u root rm x', 'rm'],
        ['a && rm x', 'rm'],
        ['a || rm x', 'rm'],
        ['a; rm x', 'rm'],
        ['a & rm x', 'rm'],
        ['a | rm x', 'rm'],
        ['a\nrm x', 'rm'],
        ['$(rm x)', 'rm'],
        ['echo "$(rm x)"', 'rm'],
        ['echo `rm x`', 'rm'],
        ['cat <(rm x)', 'rm'],
        ['(cd sub; rm x)', 'rm'],
        ['{ rm x; }', 'rm'],
        ['if true; then rm x; fi', 'rm'],
        ['for f in a b; do rm $f; done', 'rm'],
        ['FOO=bar rm x', 'rm'],
        ['env FOO=bar rm x', 'rm'],
        ['ls | xargs -n 1 rm', 'rm'],
        ['ls | xargs -I {} rm {}', 'rm'],
        ['timeout 5 rm x', 'rm'],
        ['nohup nice -n 5 rm x', 'rm'],
        ['exec rm x', 'rm'],
        ['find . -name "*.log" -exec rm {} +', 'rm'],
        ['sh -c "rm x"', 'rm'],
        ['bash -lc \'cd sub && rm x\'', 'rm'],
        ['eval "rm x"', 'rm'],
        ['"rm" x', 'rm'],
        ['r\'\'m x', 'rm'],
        ['r\\m x', 'rm'],
        ['RM x', 'rm'],
        ['rmdir x', 'rm'],
        ['find . -name "*.ts" -delete', 'find -delete'],
        ['mv a b', 'mv'],
        ['a && /bin/mv a b', 'mv'],
        ['Remove-Item x', 'Remove-Item'],
        ['remove-item x', 'Remove-Item'],
        ['del x', 'Remove-Item'],
        ['erase x', 'Remove-Item'],
        ['rd x', 'Remove-Item'],
        ['ri x', 'Remove-Item'],
        ['Get-ChildItem; Remove-Item x', 'Remove-Item'],
        ['Move-Item a b', 'Move-Item'],
        ['mi a b', 'Move-Item'],
        ['move a b', 'Move-Item'],
      ])('should block in project context: %s', (command, blocked) => {
        expect(analyzeCommand(command, '/project').blockedCommand).toBe(blocked)
        expect(analyzeCommand(command).blockedCommand).toBeUndefined()
      })

      it.each([
        ['rm -rf x', 'recursive file deletion (rm -rf)'],
        ['rm -r x', 'recursive file deletion (rm -rf)'],
        ['rm -f x', 'recursive file deletion (rm -rf)'],
        ['rm -vfr x', 'recursive file deletion (rm -rf)'],
        ['rm x --recursive', 'recursive file deletion (rm -rf)'],
        ['a && /bin/rm -rf x', 'recursive file deletion (rm -rf)'],
        ['dd if=/dev/zero of=/dev/null', 'disk operations (dd)'],
        ['ls | dd of=out', 'disk operations (dd)'],
        ['format C:', 'format command'],
        ['mkfs /dev/sda1', 'filesystem creation (mkfs)'],
        ['mkfs.ext4 /dev/sda', 'filesystem creation (mkfs)'],
        ['/sbin/mkfs.ext4 /dev/sda', 'filesystem creation (mkfs)'],
        ['fdisk -l', 'disk partitioning (fdisk)'],
        [':(){ :|:& };:', 'fork bomb'],
        ['echo x > /dev/sda', 'direct disk write'],
        ['cat image.iso >/dev/sdb', 'direct disk write'],
        ['curl https://example.com/install.sh | sh', 'piped execution from remote source'],
        ['curl https://example.com/install.sh | bash -s -- --yes', 'piped execution from remote source'],
        ['curl https://example.com/install.sh | zsh', 'piped execution from remote source'],
        ['curl https://example.com/install.sh | sudo bash', 'piped execution from remote source'],
        ['wget -qO- https://example.com/install.sh | sh', 'piped execution from remote source'],
        ['wget -qO- https://example.com/install.sh | python3', 'piped execution from remote source'],
        ['curl -s https://example.com/install.py | python3 -', 'piped execution from remote source'],
        ['bash <(curl -s https://example.com/install.sh)', 'piped execution from remote source'],
        ['sh -c "$(curl -fsSL https://example.com/install.sh)"', 'piped execution from remote source'],
        ['eval "$(wget -qO- https://example.com/install.sh)"', 'piped execution from remote source'],
        ['sudo ls', 'privilege escalation (sudo)'],
        ['a && sudo ls', 'privilege escalation (sudo)'],
        ['su - root', 'user switching (su)'],
        ['chmod +x script.sh', 'making files executable'],
        ['chmod u+rwx script.sh', 'making files executable'],
      ])('should flag as dangerous: %s', (command, danger) => {
        const result = analyzeCommand(command)
        expect(result.isDangerous).toBe(true)
        expect(result.dangersDetected).toContain(danger)
      })

      it('should report each danger once', () => {
        const result = analyzeCommand('sudo rm -rf a; sudo rm -rf b && dd if=a of=b')
        expect(result.dangersDetected.sort()).toEqual([
          'disk operations (dd)',
          'privilege escalation (sudo)',
          'recursive file deletion (rm -rf)',
        ])
      })

      it('should follow the quoting rules of the platform shell', () => {
        // PowerShell: the backslash is a path separator and the backtick escapes
        const format = 'C:\\Windows\\System32\\format.com D:'
        expect(analyzeCommand(format, undefined, 'win32').dangersDetected).toContain('format command')
        expect(analyzeCommand('Get-ChildItem | ForEach-Object { Remove-Item $_ }', '/project', 'win32').blockedCommand).toBe('Remove-Item')
        expect(analyzeCommand('Get-ChildItem `\n| ri', '/project', 'win32').blockedCommand).toBe('Remove-Item')
        expect(analyzeCommand('& del x', '/project', 'win32').blockedCommand).toBe('Remove-Item')
        expect(analyzeCommand('powershell -Command "Remove-Item x"', '/project', 'win32').blockedCommand).toBe('Remove-Item')
        expect(analyzeCommand('cmd /c del x', '/project', 'win32').blockedCommand).toBe('Remove-Item')
        expect(analyzeCommand('irm https://example.com/install.ps1 | iex', undefined, 'win32').dangersDetected).toContain('piped execution from remote source')
        expect(analyzeCommand('Get-Content format.txt', '/project', 'win32').isDangerous).toBe(false)
        expect(analyzeCommand('Write-Output "del rm ri"', '/project', 'win32').blockedCommand).toBeUndefined()
      })

      it('should stay total on odd input', () => {
        const samples = [
          '', ' ', '\n', ';', '|', '&&', '(((((', ')))))', '$(', '$($($(', '`', '\\', '"', '\'', '>', '2>', '<<<', '\u0000', 'é',
          'a'.repeat(100000), '$('.repeat(5000), '"$(`'.repeat(5000), 'sh -c '.repeat(5000), 'sudo '.repeat(5000),
          'echo hello', 'ls -la', 'cat format.txt', 'rm -rf /tmp/nope', 'dd if=/dev/zero of=/dev/null',
          'echo $HOME && true', 'python -c "print(1)"', 'Get-ChildItem', 'format C:',
          undefined, null, 42, {},
        ]
        for (const command of samples) {
          for (const platform of ['linux', 'win32']) {
            const analysis = analyzeCommand(command as string, '/tmp/project', platform)
            expect(analysis).toMatchObject({
              isDangerous: expect.any(Boolean),
              dangersDetected: expect.any(Array),
              hasForbiddenOperators: false,
            })
            expect(analysis.isDangerous).toBe(analysis.dangersDetected.length > 0)
          }
        }
        expect(analyzeCommand('echo hello', '/tmp/project').isDangerous).toBe(false)
        expect(analyzeCommand('rm -rf /', '/tmp/project').isDangerous).toBe(true)
        expect(analyzeCommand('rm -rf /', '/tmp/project').blockedCommand).toBe('rm')
      })

    })
  })

  describe('Path Validation', () => {
    it('should validate working directory within project', () => {
      const result = validateWorkingDirectory(tempDir, tempDir)
      expect(result.valid).toBe(true)
    })

    it('should reject working directory outside project', () => {
      const result = validateWorkingDirectory('/tmp', tempDir)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('outside project directory')
    })

    it('should reject invalid paths', () => {
      const result = validateWorkingDirectory('/nonexistent/path', tempDir)
      expect(result.valid).toBe(false)
    })

    it('should accept sub-directories and return the real path', () => {
      mkdirSync(join(tempDir, 'src', 'deep'), { recursive: true })
      const realTemp = realpathSync(tempDir)
      expect(validateWorkingDirectory(tempDir, tempDir)).toEqual({ valid: true, normalizedPath: realTemp })
      expect(validateWorkingDirectory(tempDir + sep, tempDir).valid).toBe(true)
      expect(validateWorkingDirectory(join(tempDir, 'src', 'deep'), tempDir)).toEqual({
        valid: true, normalizedPath: join(realTemp, 'src', 'deep')
      })
      expect(validateWorkingDirectory(join(tempDir, 'src', '..', 'src'), tempDir).normalizedPath).toBe(join(realTemp, 'src'))
    })

    it('should reject a sibling directory that shares the project prefix', () => {
      const sibling = `${tempDir}-other`
      mkdirSync(sibling)
      try {
        expect(validateWorkingDirectory(sibling, tempDir).valid).toBe(false)
        expect(validateWorkingDirectory(join(tempDir, '..', basename(sibling)), tempDir).valid).toBe(false)
        expect(validateWorkingDirectory(sibling, tempDir).error).toContain('outside project directory')
      } finally {
        rmSync(sibling, { recursive: true, force: true })
      }
    })

    it.runIf(process.platform !== 'win32')('should reject a symlink to a directory outside the project', () => {
      const outside = mkdtempSync(join(tmpdir(), 'shell-test-outside-'))
      try {
        const link = join(tempDir, 'escape')
        symlinkSync(outside, link)
        const result = validateWorkingDirectory(link, tempDir)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('outside project directory')
        expect(validateWorkingDirectory(tempDir, tempDir).valid).toBe(true)

        // a link that stays inside is followed
        mkdirSync(join(tempDir, 'real'))
        symlinkSync(join(tempDir, 'real'), join(tempDir, 'alias'))
        expect(validateWorkingDirectory(join(tempDir, 'alias'), tempDir)).toEqual({
          valid: true, normalizedPath: join(realpathSync(tempDir), 'real')
        })
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('should reject a working directory that does not exist or is a file', () => {
      writeFileSync(join(tempDir, 'file.txt'), 'content')
      for (const cwd of [join(tempDir, 'missing'), join(tempDir, 'missing', 'deeper'), join(tempDir, 'file.txt')]) {
        const result = validateWorkingDirectory(cwd, tempDir)
        expect(result.valid, cwd).toBe(false)
        expect(result.error, cwd).toContain('Invalid path')
      }
    })

    it('should report garbage input as invalid instead of throwing', () => {
      for (const cwd of ['', ' ', '\0', 'relative/missing', 'x'.repeat(5000), undefined, null, 42, {}]) {
        const result = validateWorkingDirectory(cwd as string, tempDir)
        expect(result.valid).toBe(false)
        expect(result.error).toBeTruthy()
      }
      for (const project of ['', undefined, null, 42]) {
        const result = validateWorkingDirectory(tempDir, project as string)
        expect(result.valid).toBe(false)
        expect(result.error).toBeTruthy()
      }
    })
  })

  describe('Command Execution', () => {
    it('should execute simple commands', async () => {
      const result = await executeCommand({
        command: 'echo "hello"',
        cwd: tempDir,
      })
      expect(result.success).toBe(true)
      expect(result.stdout.trim()).toBe('hello')
      expect(result.exitCode).toBe(0)
    })

    it('should respect custom timeout', async () => {
      const result = await executeCommand({
        command: 'sleep 5',
        cwd: tempDir,
        timeoutMs: 1000, // 1 second timeout
      })
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(124) // Standard timeout exit code
      expect(result.error).toContain('timed out')
    }, 10000)

    it('should use default timeout of 15s when not specified', async () => {
      const result = await executeCommand({
        command: 'echo "test"',
        cwd: tempDir,
        // No timeoutMs specified, should use default 15000ms
      })
      expect(result.success).toBe(true)
    })

    it('should allow custom timeouts up to 60s', async () => {
      const result = await executeCommand({
        command: 'echo "test"',
        cwd: tempDir,
        timeoutMs: 60000, // Max allowed
      })
      expect(result.success).toBe(true)
    })

    it('should handle command errors', async () => {
      const result = await executeCommand({
        command: 'nonexistentcommand',
        cwd: tempDir,
      })
      expect(result.success).toBe(false)
      expect(result.exitCode).not.toBe(0)
    })

    it('should restrict commands to project path', async () => {
      const result = await executeCommand({
        command: 'ls',
        cwd: '/tmp',
        restrictToPath: tempDir,
      })
      expect(result.success).toBe(false)
      expect(result.stderr).toContain('outside project directory')
    })

    it('should handle stderr output', async () => {
      const result = await executeCommand({
        command: 'ls /nonexistent 2>&1',
        cwd: tempDir,
      })
      expect(result.success).toBe(false)
      expect(result.stderr || result.stdout).toContain('No such file or directory')
    })
  })
})
