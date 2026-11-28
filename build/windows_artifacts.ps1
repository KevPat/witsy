function Get-WitsyWindowsArtifactNames {
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Architecture
  )

  return [PSCustomObject]@{
    Installer = "Witsy-$Version-win32-$Architecture.Setup.exe"
    Nupkg = "witsy-$Version-win32-$Architecture-full.nupkg"
    Zip = "Witsy-$Version-win32-$Architecture.zip"
  }
}

function Get-WitsyWindowsArtifactPaths {
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Architecture
  )

  $names = Get-WitsyWindowsArtifactNames -Version $Version -Architecture $Architecture
  return [PSCustomObject]@{
    Releases = "out\make\squirrel.windows\$Architecture\RELEASES"
    Installer = "out\make\squirrel.windows\$Architecture\$($names.Installer)"
    Nupkg = "out\make\squirrel.windows\$Architecture\$($names.Nupkg)"
    Zip = "out\make\zip\win32\$Architecture\$($names.Zip)"
  }
}
