param(
  [ValidateSet('tauri', 'electron')][string]$Runtime = 'tauri',
  [int]$Seconds = 0,
  [switch]$Simulate,
  [switch]$Demo,
  [switch]$Settings,
  [switch]$Smoke
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (Get-Process lolping-desktop-pilot -ErrorAction SilentlyContinue) { throw 'The Rust pilot is already running.' }
Remove-Item Env:LOLPING_PILOT_BENCHMARK -ErrorAction SilentlyContinue
if ($Smoke) {
  $Settings = $true; $Simulate = $true
  $env:LOLPING_PILOT_SMOKE = '1'
  $env:LOLPING_PILOT_DATA_DIR = Join-Path (Get-Location) 'out/desktop-pilot/smoke-settings'
} else {
  Remove-Item Env:LOLPING_PILOT_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:LOLPING_PILOT_DATA_DIR -ErrorAction SilentlyContinue
}
if ($Demo) { $Simulate = $true; $env:LOLPING_PILOT_DEMO = '1' }
else { Remove-Item Env:LOLPING_PILOT_DEMO -ErrorAction SilentlyContinue }
if ($Settings) { $env:LOLPING_PILOT_SETTINGS = '1' }
else { Remove-Item Env:LOLPING_PILOT_SETTINGS -ErrorAction SilentlyContinue }
if (-not $Simulate -and (Get-Process hook-helper -ErrorAction SilentlyContinue)) {
  throw 'Another input helper is running. Quit lolPing first, or use -Simulate for an isolated comparison.'
}
if ($Seconds -gt 0) { $env:LOLPING_PILOT_SECONDS = "$Seconds" }
else { Remove-Item Env:LOLPING_PILOT_SECONDS -ErrorAction SilentlyContinue }
if ($Simulate) { $env:LOLPING_PILOT_SIMULATE = '1' }
else { Remove-Item Env:LOLPING_PILOT_SIMULATE -ErrorAction SilentlyContinue }
$env:ELECTRON_RUN_AS_NODE = $null
if ($Runtime -eq 'tauri') {
  & ./native/desktop-pilot/target/release/lolping-desktop-pilot.exe
} else {
  & ./node_modules/.bin/electron.cmd tools/desktop-pilot-electron.cjs
}
exit $LASTEXITCODE
