<#
.SYNOPSIS
  Build Valheim WebMap on Windows and package it for a server.

.DESCRIPTION
  1. Copies the game assemblies the mod compiles against into libs/valheim
     (from the Valheim dedicated server or the game install).
  2. Downloads BepInEx into libs/BepInEx if it is not there yet.
  3. dotnet build (Release). Krafs.Publicizer publicizes the game assemblies
     at build time, so there is no separate publicize step.
  4. Packages dist/ValheimWebMap-<version>.zip and, with
     -Deploy, copies the plugin folder into a BepInEx/plugins directory.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -ValheimManaged "D:\Steam\steamapps\common\Valheim dedicated server\valheim_server_Data\Managed"
  .\build.ps1 -Deploy "\\server\valheim\BepInEx\plugins"
#>
param(
  [string]$ValheimManaged = "",
  [string]$Deploy = "",
  [string]$BepInExVersion = "5.4.23.2",
  [switch]$SkipPackage
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# --- 1. game assemblies -------------------------------------------------------
$candidates = @(
  $ValheimManaged,
  "${env:ProgramFiles(x86)}\Steam\steamapps\common\Valheim dedicated server\valheim_server_Data\Managed",
  "${env:ProgramFiles(x86)}\Steam\steamapps\common\Valheim\valheim_Data\Managed",
  "C:\Steam\steamapps\common\Valheim dedicated server\valheim_server_Data\Managed"
) | Where-Object { $_ -and (Test-Path $_) }
if (-not $candidates) {
  throw "Valheim assemblies not found. Install the 'Valheim Dedicated Server' tool in Steam (or the game) and pass -ValheimManaged <path to ...\valheim_server_Data\Managed>."
}
## Force array semantics when only one candidate path matches.
$managed = @($candidates)[0]
Write-Host "Game assemblies: $managed"
New-Item -ItemType Directory -Force libs\valheim | Out-Null
$needed = @("assembly_valheim.dll", "assembly_utils.dll", "Mono.Security.dll", "UnityEngine.dll", "UnityEngine.CoreModule.dll",
            "UnityEngine.JSONSerializeModule.dll", "UnityEngine.ImageConversionModule.dll", "Splatform.dll", "com.rlabrecque.steamworks.net.dll")
foreach ($f in $needed) {
  $src = Join-Path $managed $f
  if (Test-Path $src) { Copy-Item $src libs\valheim\ -Force } else { Write-Warning "missing $f (build may still succeed)" }
}

# --- 2. BepInEx ---------------------------------------------------------------
if (-not (Test-Path libs\BepInEx\core\BepInEx.dll)) {
  $zip = "$env:TEMP\BepInEx_$BepInExVersion.zip"
  $url = "https://github.com/BepInEx/BepInEx/releases/download/v$BepInExVersion/BepInEx_win_x64_$BepInExVersion.zip"
  Write-Host "Downloading BepInEx $BepInExVersion"
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath "$env:TEMP\BepInEx_$BepInExVersion" -Force
  New-Item -ItemType Directory -Force libs | Out-Null
  Copy-Item "$env:TEMP\BepInEx_$BepInExVersion\BepInEx" libs\BepInEx -Recurse -Force
}

# --- 3. build -----------------------------------------------------------------
dotnet build WebMap\WebMap.csproj -c Release -v minimal
if ($LASTEXITCODE -ne 0) { throw "build failed" }

# --- 4. package ---------------------------------------------------------------
$version = (Get-Content manifest.json | ConvertFrom-Json).version_number
# plugins\WebMap\ inside the zip: r2modman, Gale and Thunderstore know that folder and keep
# everything under it together (the web folder included) when they install
$pkg = "dist\pkg\plugins\WebMap"
if (Test-Path dist\pkg) { Remove-Item dist\pkg -Recurse -Force }
New-Item -ItemType Directory -Force $pkg | Out-Null
Copy-Item WebMap\bin\Release\WebMap.dll, WebMap\bin\Release\websocket-sharp.dll $pkg
Copy-Item WebMap\web $pkg\web -Recurse
New-Item -ItemType Directory -Force $pkg\tools | Out-Null
Copy-Item tools\extract_textures.py, tools\extract_meshes.py $pkg\tools\
Copy-Item manifest.json, README.md, CHANGELOG.md, icon.png, LICENSE dist\pkg\
if (-not $SkipPackage) {
  $zipOut = "dist\ValheimWebMap-$version.zip"
  if (Test-Path $zipOut) { Remove-Item $zipOut }
  Compress-Archive -Path dist\pkg\* -DestinationPath $zipOut
  Write-Host "Packaged $zipOut"
}
if ($Deploy) {
  $dest = Join-Path $Deploy "WebMap"
  Write-Host "Deploying to $dest"
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item "$pkg\*" $dest -Recurse -Force
}
Write-Host "Done. Plugin folder: $pkg"
