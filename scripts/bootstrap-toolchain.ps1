[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolchain = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'node-toolchain.json') | ConvertFrom-Json
$toolDirectory = Join-Path $projectRoot '.tools'
$archivePath = Join-Path $toolDirectory $toolchain.archive
New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $archivePath)) {
  Invoke-WebRequest -Uri $toolchain.url -OutFile $archivePath
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $toolchain.sha256) {
  throw 'El checksum del archivo Node no coincide; no se extrae ni ejecuta.'
}
Expand-Archive -LiteralPath $archivePath -DestinationPath (Join-Path $toolDirectory 'node') -Force
& (Join-Path $PSScriptRoot 'run-with-toolchain.ps1') --version
