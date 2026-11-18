# Safe Production Rebuild & Restart for MarketBrain ONLY (never touches D:\bctest01 / javis)
$ErrorActionPreference = "Stop"
Set-Location "D:\marketbrain"

Write-Host "[1/4] Running secret scan, typecheck, and production build..."
npm run typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[2/4] Stopping existing D:\marketbrain processes only..."
$targets = Get-CimInstance Win32_Process | Where-Object {
  ($_.CommandLine -match "D:\\marketbrain") -or
  ($_.CommandLine -match "deploy\\run-all\.mjs") -or
  ($_.CommandLine -match "13090:127\.0\.0\.1:3090")
}
foreach ($p in $targets) {
  if ($p.ProcessId -ne $PID) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2

Write-Host "[3/4] Launching detached MarketBrain production supervisor..."
$launch = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'wscript.exe "D:\marketbrain\deploy\start_hidden.vbs"'
  CurrentDirectory = 'D:\marketbrain'
}
Write-Host "Started wscript.exe PID=$($launch.ProcessId) (ReturnValue=$($launch.ReturnValue))"

Write-Host "[4/4] Waiting for local web (:3090) & GPU voice (:3091) health..."
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  try {
    $v = Invoke-RestMethod -Uri "https://marketbrain.bcsmethai.com/api/voice/status" -TimeoutSec 5
    if ($v.ok) {
      Write-Host "✅ Live https://marketbrain.bcsmethai.com is ONLINE and Voice GPU ready!"
      exit 0
    }
  } catch {}
}
Write-Warning "Web launched; check .data\marketbrain.log if voice warmup is still in progress."
