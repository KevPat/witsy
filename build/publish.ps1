
# Detect the system architecture
$architecture = $Env:PROCESSOR_ARCHITECTURE.ToLower()
if ($architecture -eq "amd64") { $architecture = "x64" }
Write-Host "Detected architecture: $architecture"

# Extract version from package.json
$packageJsonContent = Get-Content -Raw -Path "package.json"
$version = ($packageJsonContent | ConvertFrom-Json).version
Write-Host "Version: $version"
. "$PSScriptRoot\windows_artifacts.ps1"
$artifacts = Get-WitsyWindowsArtifactPaths -Version $version -Architecture $architecture

# Upload
gh release upload "v$version" $artifacts.Releases $artifacts.Installer $artifacts.Nupkg
gh release upload "v$version" $artifacts.Zip
