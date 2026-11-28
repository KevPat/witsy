# Witsy CLI launcher for PowerShell (Windows PowerShell 5.1 and PowerShell 7). witsy.cmd does the same
# for cmd.exe, and is the one to use when the execution policy does not allow scripts.
#
# It runs cli.js on the app binary started as Node.js (ELECTRON_RUN_AS_NODE=1), or on the Node.js of
# the computer (18 or later, found through the PATH only) when the "runtime" file next to cli.js says
# "node" (a build made with WITSY_CLI_RUNTIME=node, see build/cli_runtime.ts).
#
# Where cli.js and the app binary are, from the folder of this file (D = $PSScriptRoot), first match wins
# (the same order as witsy.cmd):
#   1. D\app-X.Y.Z\ : the launcher copied by the app next to its Squirrel versions (the folder on the
#      PATH). The highest X.Y.Z, compared as numbers, of the folders named exactly app-<n>.<n>.<n> that
#      contain Witsy.exe and resources\cli\cli.js. cli = app-X.Y.Z\resources\cli\cli.js,
#      app = app-X.Y.Z\Witsy.exe
#   2. D\..\cli.js : the launcher inside an app (D = <app>\resources\cli\bin, zip install) or inside a
#      CLI build of the repository (D = <repo>\dist\cli\bin). app = D\..\..\..\Witsy.exe, else
#      D\..\..\..\node_modules\electron\dist\electron.exe
#   3. D\..\dist\cli\cli.js : the launcher of the repository (D = <repo>\bin), after npm run build:cli.
#      app = D\..\node_modules\electron\dist\electron.exe
# Nothing is ever looked for in, or run from, the current folder.
#
# The CLI is started with System.Diagnostics.Process and a command line built here, because Windows
# PowerShell 5.1 drops empty arguments and breaks the ones with double quotes when it starts a program.
# Its console, stdout and stderr are the ones of PowerShell (the CLI is interactive): to capture or pipe
# its output inside PowerShell, call witsy.cmd. Pipeline input (... | witsy) goes to its stdin, in UTF-8.
# ELECTRON_RUN_AS_NODE is only given to the CLI, never set in this session.
#
# In ConstrainedLanguage mode (an unsigned script under WDAC or AppLocker) .NET cannot be used: the CLI is
# then started with the call operator, and arguments are passed the way PowerShell passes them.

begin {

  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'

  $script:full = $ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage'
  $script:child = $null
  $script:writing = $false
  $script:pending = $null
  $script:savedOutputEncoding = $null

  function Write-Failure([string[]]$lines) {
    foreach ($line in $lines) {
      if ($script:full) {
        [Console]::Error.WriteLine($line)
      } else {
        # No .NET method can be called in this language mode, and Write-Error adds its own lines: cmd.exe
        # writes the line to stderr, read from the environment with delayed expansion (nothing parsed)
        $env:WITSY_MESSAGE = $line
        & "$env:SystemRoot\System32\cmd.exe" /d /v:on /c 'echo(!WITSY_MESSAGE!>&2'
        Remove-Item -LiteralPath env:WITSY_MESSAGE -ErrorAction SilentlyContinue
      }
    }
  }

  function Restore-Console {
    if ($null -ne $script:savedOutputEncoding) {
      try { [Console]::OutputEncoding = $script:savedOutputEncoding } catch { }
      $script:savedOutputEncoding = $null
    }
  }

  function Stop-Launcher([string[]]$lines) {
    Write-Failure $lines
    Restore-Console
    exit 1
  }

  # an argument as CommandLineToArgvW (and so Node.js) reads it back
  function ConvertTo-Argument([string]$value) {
    if ($value.Length -gt 0 -and $value -notmatch '[\s"]') { return $value }
    $escaped = $value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
  }

  if ($script:full) {
    # our messages may hold paths with any character; restored before leaving
    try {
      $script:savedOutputEncoding = [Console]::OutputEncoding
      [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
    } catch {
      $script:savedOutputEncoding = $null
    }
  }

  $dir = $PSScriptRoot
  $cli = $null
  $app = $null
  $tried = @()

  # 1. Squirrel: the app-* folders next to this file
  $bestKey = $null
  foreach ($folder in @(Get-ChildItem -LiteralPath $dir -Directory -Filter 'app-*' -ErrorAction SilentlyContinue)) {
    if ($folder.Name -notmatch '^app-([0-9]+)\.([0-9]+)\.([0-9]+)$') { continue }
    $key = 'v' + ((@($Matches[1], $Matches[2], $Matches[3]) | ForEach-Object { $_.PadLeft(9, '0') }) -join '.')
    if (-not (Test-Path -LiteralPath (Join-Path $folder.FullName 'Witsy.exe') -PathType Leaf)) { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $folder.FullName 'resources\cli\cli.js') -PathType Leaf)) { continue }
    if ($null -eq $bestKey -or $key -gt $bestKey) {
      $bestKey = $key
      $cli = Join-Path $folder.FullName 'resources\cli\cli.js'
      $app = Join-Path $folder.FullName 'Witsy.exe'
    }
  }

  if ($null -eq $cli) {
    $parent = Split-Path -Parent $dir
    if (Test-Path -LiteralPath (Join-Path $parent 'cli.js') -PathType Leaf) {
      # 2. inside an app (zip install) or a CLI build of the repository
      $cli = Join-Path $parent 'cli.js'
      $top = Split-Path -Parent (Split-Path -Parent $parent)
      $tried = @((Join-Path $top 'Witsy.exe'), (Join-Path $top 'node_modules\electron\dist\electron.exe'))
    } elseif (Test-Path -LiteralPath (Join-Path $parent 'dist\cli\cli.js') -PathType Leaf) {
      # 3. the launcher of the repository
      $cli = Join-Path $parent 'dist\cli\cli.js'
      $tried = @(Join-Path $parent 'node_modules\electron\dist\electron.exe')
    } else {
      Stop-Launcher @(
        'Witsy CLI: cannot find the Witsy CLI (cli.js). Looked for:',
        "  $(Join-Path $dir 'app-X.Y.Z\resources\cli\cli.js') (with app-X.Y.Z\Witsy.exe)",
        "  $(Join-Path $dir '..\cli.js')",
        "  $(Join-Path $dir '..\dist\cli\cli.js')",
        'Reinstall Witsy, or run npm run build:cli in a copy of the repository.'
      )
    }
    foreach ($candidate in $tried) {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $app = $candidate; break }
    }
  }

  # Which Node.js runs the CLI was decided when the app was built:
  # - "electron", or no file: the app binary, as a Node.js runtime
  # - "node": the Node.js of this computer. The app binary cannot be used: it no longer
  #   accepts to run as Node.js (the RunAsNode fuse is off), for any program or user
  $runtime = 'electron'
  $runtimeFile = Join-Path (Split-Path -Parent $cli) 'runtime'
  if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
    $runtime = ("$(Get-Content -LiteralPath $runtimeFile -TotalCount 1)") -replace '\s', ''
  }

  $cwd = (Get-Location -PSProvider FileSystem).ProviderPath
  $environment = @{}

  if ($runtime -eq 'node') {

    # Get-Command does not look in the current folder, but an entry of the PATH such as "." does
    $cwdKey = $cwd.TrimEnd('\')
    $node = $null
    foreach ($command in @(Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue)) {
      if ($command.Path -notlike '*.exe') { continue }
      if ((Split-Path -Parent $command.Path).TrimEnd('\') -eq $cwdKey) { continue }
      $node = $command.Path
      break
    }
    if ($null -eq $node) {
      Stop-Launcher @(
        "Witsy CLI requires Node.js 18 or later, and no 'node' was found in your PATH.",
        'Install Node.js (https://nodejs.org) and try again.'
      )
    }

    $ErrorActionPreference = 'Continue'
    $major = "$(& $node -p "process.versions.node.split('.')[0]" 2>$null | Select-Object -First 1)".Trim()
    $ErrorActionPreference = 'Stop'
    if ($major -notmatch '^[1-9][0-9]{0,3}$' -or [int]$major -lt 18) {
      $ErrorActionPreference = 'Continue'
      $version = "$(& $node --version 2>$null | Select-Object -First 1)".Trim()
      $ErrorActionPreference = 'Stop'
      if ($version -eq '') { $version = 'not a working Node.js' }
      Stop-Launcher @(
        "Witsy CLI requires Node.js 18 or later: '$node' is $version.",
        'Install a recent Node.js (https://nodejs.org) and try again.'
      )
    }
    $program = $node

  } else {

    # the app binary, as Node.js
    if ($null -eq $app) {
      Stop-Launcher (@("Witsy CLI: found $cli but not the Witsy app to run it. Looked for:") + @($tried | ForEach-Object { "  $_" }) + @('Reinstall Witsy, or run npm install in the repository.'))
    }
    $program = $app
    $environment['ELECTRON_RUN_AS_NODE'] = '1'

  }

  # the arguments, one string each (an array given as one argument is several, as for any program)
  $arguments = @('--no-deprecation', $cli)
  foreach ($argument in $args) {
    foreach ($item in @($argument)) { $arguments += "$item" }
  }

  $script:program = $program
  $script:arguments = $arguments
  $script:environment = $environment
  $script:cwd = $cwd
  # items of the pipeline for ConstrainedLanguage, given to the CLI at the end
  $script:pending = @()
  $script:piped = $false

  # Started at the first item of the pipeline, with its stdin from here, or at the end without
  # any (its stdin is then the one of PowerShell: powershell.exe -File says it expects input but
  # gives the script none, and the CLI must still read what is sent to powershell.exe)
  function Start-Child([bool]$redirect) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $script:program
    $info.Arguments = ($script:arguments | ForEach-Object { ConvertTo-Argument $_ }) -join ' '
    $info.UseShellExecute = $false
    $info.WorkingDirectory = $script:cwd
    foreach ($name in $script:environment.Keys) { $info.EnvironmentVariables[$name] = $script:environment[$name] }
    $info.RedirectStandardInput = $redirect

    # The stdin writer of .NET uses the input encoding of the console, with a BOM when it is UTF-8:
    # UTF-8 without BOM while the CLI is started.
    $savedInputEncoding = $null
    if ($redirect) {
      try {
        $savedInputEncoding = [Console]::InputEncoding
        [Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
      } catch {
        $savedInputEncoding = $null
      }
    }
    try {
      $script:child = [System.Diagnostics.Process]::Start($info)
    } catch {
      Stop-Launcher @("Witsy CLI: cannot start $($script:program): $($_.Exception.Message)")
    } finally {
      if ($null -ne $savedInputEncoding) {
        try { [Console]::InputEncoding = $savedInputEncoding } catch { }
      }
    }
    $script:piped = $redirect
    $script:writing = $redirect
  }

}

process {

  if (-not $MyInvocation.ExpectingInput) { return }

  if (-not $script:full) {
    $script:pending += , $_
    return
  }

  if ($null -eq $script:child) { Start-Child $true }
  if (-not $script:writing) { return }

  # strings as they are, other objects as PowerShell shows them, one line each
  if ($_ -is [string]) { $lines = @($_) } else { $lines = @($_ | Out-String -Stream) }
  try {
    foreach ($line in $lines) { $script:child.StandardInput.Write("$line`n") }
    $script:child.StandardInput.Flush()
  } catch {
    # the CLI does not read any more (it has exited)
    $script:writing = $false
  }

}

end {

  if (-not $script:full) {
    # ConstrainedLanguage: the call operator, ELECTRON_RUN_AS_NODE set and removed again around it
    $saved = @{}
    foreach ($name in $script:environment.Keys) {
      $saved[$name] = $null
      $current = Get-Item -LiteralPath "env:$name" -ErrorAction SilentlyContinue
      if ($null -ne $current) { $saved[$name] = $current.Value }
      Set-Item -LiteralPath "env:$name" -Value $script:environment[$name]
    }
    $ErrorActionPreference = 'Continue'
    $code = 1
    try {
      if ($script:pending.Count -gt 0) {
        $script:pending | & $script:program @($script:arguments)
      } else {
        & $script:program @($script:arguments)
      }
      $code = $LASTEXITCODE
    } finally {
      foreach ($name in $saved.Keys) {
        if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "env:$name" -ErrorAction SilentlyContinue }
        else { Set-Item -LiteralPath "env:$name" -Value $saved[$name] }
      }
    }
    exit $code
  }

  if ($null -eq $script:child) {
    Start-Child $false
  } elseif ($script:piped) {
    try { $script:child.StandardInput.Close() } catch { }
  }

  # Ctrl+C reaches the CLI too (same console): this waits until it has exited, so it is never left behind
  try {
    $script:child.WaitForExit()
  } finally {
    if (-not $script:child.HasExited) { $script:child.WaitForExit() }
    Restore-Console
  }
  exit $script:child.ExitCode

}
