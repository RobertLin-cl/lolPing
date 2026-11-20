param([ValidateRange(1, 10)][int]$Samples = 10)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$outputDir = Join-Path (Get-Location) 'out/desktop-pilot'
$env:LOLPING_PILOT_SIMULATE = '1'
$env:LOLPING_PILOT_SECONDS = '40'
$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:LOLPING_PILOT_DEMO -ErrorAction SilentlyContinue
Remove-Item Env:LOLPING_PILOT_SETTINGS -ErrorAction SilentlyContinue
Remove-Item Env:LOLPING_PILOT_SMOKE -ErrorAction SilentlyContinue
$env:LOLPING_PILOT_BENCHMARK = '1'
$env:LOLPING_PILOT_DATA_DIR = Join-Path $outputDir 'memory-settings'
if (Get-Process lolping-desktop-pilot -ErrorAction SilentlyContinue) { throw 'Quit the existing Rust pilot before measuring.' }
$results = @()
foreach ($runtime in @('electron', 'tauri')) {
  $stdout = Join-Path $outputDir "$runtime.stdout.log"
  $stderr = Join-Path $outputDir "$runtime.stderr.log"
  if ($runtime -eq 'electron') {
    $exe = Join-Path (Get-Location) 'node_modules/electron/dist/electron.exe'
    $arguments = @('tools/desktop-pilot-electron.cjs')
  } else {
    $exe = Join-Path (Get-Location) 'native/desktop-pilot/target/release/lolping-desktop-pilot.exe'
    $arguments = @()
  }
  $start = @{ FilePath = $exe; PassThru = $true; WindowStyle = 'Hidden';
    RedirectStandardOutput = $stdout; RedirectStandardError = $stderr }
  if ($arguments.Length) { $start.ArgumentList = $arguments }
  $process = Start-Process @start
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  try {
    do {
      $process.Refresh()
      if ($process.HasExited) { throw "$runtime exited before ready. See $stderr" }
      if ([DateTime]::UtcNow -gt $deadline) { throw "$runtime did not become ready. See $stderr" }
      Start-Sleep -Milliseconds 250
    } until ((Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue) -match 'Pilot ready:')
    # Both runtimes get the same asset warm-up interval before collecting idle samples.
    Start-Sleep -Seconds 8
    $samplesForRuntime = @()
    for ($sample = 0; $sample -lt $Samples; $sample++) {
      $snapshot = Get-Counter -Counter '\Process(*)\ID Process','\Process(*)\Creating Process ID',
        '\Process(*)\Working Set - Private','\Process(*)\Private Bytes','\Process(*)\Working Set' -ErrorAction SilentlyContinue
      $instances = @{}
      foreach ($counter in $snapshot.CounterSamples) {
        if ($counter.Status -ne 0) { continue }
        if ($counter.Path -match '\\process\((.+)\)\\(.+)$') {
          $instance = $Matches[1]
          $name = $Matches[2]
          if (-not $instances.ContainsKey($instance)) { $instances[$instance] = @{} }
          $instances[$instance][$name] = $counter.CookedValue
        }
      }
      $processes = @($instances.Values | Where-Object { $_.ContainsKey('id process') })
      $ids = [System.Collections.Generic.HashSet[uint32]]::new()
      [void]$ids.Add([uint32]$process.Id)
      do {
        $added = $false
        foreach ($entry in $processes) {
          if ($ids.Contains([uint32]$entry['creating process id']) -and $ids.Add([uint32]$entry['id process'])) { $added = $true }
        }
      } while ($added)
      $counters = @($processes | Where-Object { $ids.Contains([uint32]$_['id process']) })
      if ($counters.Length -lt 3) { throw "$runtime has an incomplete process tree" }
      $samplesForRuntime += [PSCustomObject]@{
        Runtime = $runtime
        Sample = $sample
        Processes = $counters.Length
        PrivateWorkingSetMiB = [Math]::Round(($counters | ForEach-Object { $_['working set - private'] } | Measure-Object -Sum).Sum / 1MB, 2)
        PrivateBytesMiB = [Math]::Round(($counters | ForEach-Object { $_['private bytes'] } | Measure-Object -Sum).Sum / 1MB, 2)
        WorkingSetMiB = [Math]::Round(($counters | ForEach-Object { $_['working set'] } | Measure-Object -Sum).Sum / 1MB, 2)
      }
      Start-Sleep -Seconds 1
    }
    $results += $samplesForRuntime
    $samplesForRuntime | Measure-Object PrivateWorkingSetMiB -Average -Minimum -Maximum | Format-List
  } finally {
    # Each test instance exits on its own; never terminate an existing lolPing process.
    if (-not $process.HasExited) { $process.WaitForExit(45000) | Out-Null }
  }
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDir 'memory-samples.json') -Encoding utf8
$results | Group-Object Runtime | ForEach-Object {
  [PSCustomObject]@{
    Runtime = $_.Name
    AveragePrivateWorkingSetMiB = [Math]::Round(($_.Group | Measure-Object PrivateWorkingSetMiB -Average).Average, 2)
    AveragePrivateBytesMiB = [Math]::Round(($_.Group | Measure-Object PrivateBytesMiB -Average).Average, 2)
  }
} | Format-Table -AutoSize
