# Builds dist/dsh-lan-bridge-<version>-macos.zip from the current tree.
#
#   powershell -File scripts\build-macos-zip.ps1
#
# Layout inside the zip:
#   install-macos.sh
#   更新说明.txt
#   dsh-lan-bridge/{index.js,client.js,lib,package.json,...}
#
# Two gotchas this script exists to avoid:
#   1. Entry names use forward slashes: [ZipFile]::CreateFromDirectory writes
#      backslashes, which macOS unzip turns into literal file names.
#   2. Entry names are listed explicitly instead of being derived from a temp
#      staging path: %TEMP% is the 8.3 short form (ADMINI~1) while Get-ChildItem
#      reports long paths, so Substring() on them yields a wrong prefix.

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
$zipName = "dsh-lan-bridge-$version-macos.zip"

$entries = New-Object System.Collections.ArrayList
function Add-Entry($sourcePath, $entryName) {
  if (-not (Test-Path $sourcePath)) { throw "missing file: $sourcePath" }
  [void]$entries.Add([pscustomobject]@{ Path = $sourcePath; Name = $entryName })
}

Add-Entry (Join-Path $repo "scripts\install-macos.sh") "install-macos.sh"
Add-Entry (Join-Path $repo "scripts\更新说明.txt") "更新说明.txt"

$files = @("index.js", "client.js", "cordis.patch.yml", "icon.svg", "README.md", "CHANGELOG.md", "package.json")
foreach ($file in $files) {
  Add-Entry (Join-Path $repo $file) "dsh-lan-bridge/$file"
}
foreach ($file in (Get-ChildItem (Join-Path $repo "lib") -File | Sort-Object Name)) {
  Add-Entry $file.FullName ("dsh-lan-bridge/lib/" + $file.Name)
}

$dist = Join-Path $repo "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zipPath = Join-Path $dist $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($zipPath, "Create")
try {
  foreach ($entry in $entries) {
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $entry.Path, $entry.Name, [IO.Compression.CompressionLevel]::Optimal)
  }
} finally {
  $zip.Dispose()
}

$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "built: $zipPath ($size KB, $($entries.Count) entries)"