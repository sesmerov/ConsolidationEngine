[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]] $NpmArguments)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolchain = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'node-toolchain.json') | ConvertFrom-Json
$nodeDirectory = Join-Path $projectRoot ('.tools/node/node-v' + $toolchain.version + '-win-x64')
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExecutable)) {
  throw 'Toolchain aislada ausente. Ejecuta scripts/bootstrap-toolchain.ps1 primero.'
}
if ((& $nodeExecutable --version) -ne ('v' + $toolchain.version)) { throw 'Versión Node distinta del pin.' }
$npmCli = Join-Path $nodeDirectory 'node_modules/npm/bin/npm-cli.js'
if ((& $nodeExecutable $npmCli --version) -ne $toolchain.npmVersion) { throw 'Versión npm distinta del pin.' }
$previousPath = $env:PATH
$previousCache = $env:npm_config_cache
$previousOffline = $env:npm_config_offline
Push-Location $projectRoot
try {
  $env:PATH = $nodeDirectory + [IO.Path]::PathSeparator + $previousPath
  $env:npm_config_cache = Join-Path $projectRoot '.cache/npm'
  $env:npm_config_offline = 'false'
  & $nodeExecutable $npmCli @NpmArguments
  $npmExitCode = $LASTEXITCODE
} finally {
  $env:PATH = $previousPath
  $env:npm_config_cache = $previousCache
  $env:npm_config_offline = $previousOffline
  Pop-Location
}
exit $npmExitCode
