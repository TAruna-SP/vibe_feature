# ViBe Local Setup — runs the whole bootstrap for you.
#
# Run from PowerShell at D:\Vicharanashala prjs\vibe_feature:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# What it does:
#   1. Confirms node/pnpm/java
#   2. Stops any leftover emulator on 9099
#   3. Cleans prior in-memory mongo folders
#   4. Runs pnpm install (idempotent, will skip if already done)
#   5. Starts Firebase Auth Emulator on 127.0.0.1:9099
#   6. (Optional) Seeds a test user via the emulator REST API
#   7. Reports results to setup-result.txt
#
# After it finishes you can:
#   - open http://localhost:5173  (frontend, run via `pnpm dev` in frontend/)
#   - hit http://localhost:3141/api/health  (backend, run via npm script)
#
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
Set-Location $root

$log = Join-Path $root 'setup-result.txt'
"ViBe setup — $(Get-Date -Format 'u')" | Out-File -FilePath $log -Encoding utf8

function Step($name) {
  Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] $name" -ForegroundColor Cyan
  "[$([DateTime]::Now.ToString('HH:mm:ss'))] $name" | Out-File -Append -FilePath $log -Encoding utf8
}

function Fail($msg) {
  Write-Host "  ✗ $msg" -ForegroundColor Red
  "  FAIL: $msg" | Out-File -Append -FilePath $log -Encoding utf8
}

function Ok($msg) {
  Write-Host "  ✓ $msg" -ForegroundColor Green
  "  OK: $msg" | Out-File -Append -FilePath $log -Encoding utf8
}

Step 'Check tooling'
$tools = @(
  @{name='node'; cmd='node'},
  @{name='npm'; cmd='npm'},
  @{name='pnpm'; cmd='pnpm'},
  @{name='firebase'; cmd='firebase'},
  @{name='java'; cmd='java'}
)
foreach ($t in $tools) {
  try {
    $null = & $t.cmd --version 2>&1
    Ok "found $($t.name)"
  } catch {
    Fail "$($t.name) not found in PATH"
  }
}

Step 'Kill any leftover firebase emulator / dev servers'
Get-Process node,java -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match 'firebase|emulator|vibe_feature|backend|ts-node' -or
  $_.MainWindowTitle -match 'firebase|vibe'
} | ForEach-Object {
  Write-Host "  killing pid $($_.Id) ($($_.ProcessName))"
  try { $_.Kill() } catch {}
  Start-Sleep -Milliseconds 200
}
Get-NetTCPConnection -State Listen -LocalPort 9099 -ErrorAction SilentlyContinue |
  ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }
Start-Sleep -Seconds 1
Ok 'cleanup done'

Step 'pnpm install (will reuse existing node_modules if already populated)'
$cache = "$env:LOCALAPPDATA\pnpm-cache"
if (Test-Path (Join-Path $root 'node_modules')) {
  $nmCount = (Get-ChildItem -Path (Join-Path $root 'node_modules') -ErrorAction SilentlyContinue | Measure-Object).Count
  Ok "node_modules exists ($nmCount entries). Skipping install."
} else {
  Write-Host '  running pnpm install — this can take 10–20 minutes'
  $out = & pnpm install --no-frozen-lockfile 2>&1 | Out-String
  $out | Out-File -Append -FilePath $log -Encoding utf8
  if ($LASTEXITCODE -eq 0) {
    Ok 'pnpm install succeeded'
  } else {
    Fail "pnpm install exited $LASTEXITCODE. See setup-result.txt"
  }
}

Step 'Approve build scripts for native modules (bcrypt, mongodb-memory-server, tfjs-node, sharp, ...)'
# pnpm 10 hides a list of packages that have install scripts in
# .pnpmfile.cjs / package.json#pnpm.onlyBuiltDependencies. We add the
# ones our app actually needs to `pnpm-workspace.yaml`. That file
# already lists them; this step just confirms they're set and
# triggers a rebuild so the native binaries actually compile.
$wsYaml = Join-Path $root 'pnpm-workspace.yaml'
if ((Get-Content $wsYaml -Raw) -match 'mongodb-memory-server') {
  Ok 'pnpm-workspace.yaml lists onlyBuiltDependencies'
} else {
  Fail 'pnpm-workspace.yaml missing onlyBuiltDependencies — patch first'
}

# Force a rebuild of the native modules so their .node binaries get
# compiled. Idempotent: if already built, it's a no-op.
foreach ($pkg in @('bcrypt','mongodb-memory-server','sharp','@tensorflow/tfjs-node','@parcel/watcher','esbuild')) {
  Write-Host "  pnpm rebuild $pkg"
  & pnpm rebuild $pkg 2>&1 | Out-File -Append -FilePath $log -Encoding utf8
}
Ok 'native modules rebuilt'
$tsxBin = Join-Path $root 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path $tsxBin)) {
  Write-Host '  installing tsx at workspace root...'
  & pnpm add -w -D tsx 2>&1 | Out-File -Append -FilePath $log -Encoding utf8
  if ($LASTEXITCODE -eq 0) { Ok 'tsx installed' }
  else { Fail "tsx install failed (exit $LASTEXITCODE)" }
} else {
  Ok 'tsx already present'
}

Step 'Verify key binaries are available'
foreach ($bin in @('ts-node','tsc')) {
  $p = Join-Path $root 'node_modules\.bin\' + "$bin.cmd"
  if (Test-Path $p) { Ok "$bin present" } else { Fail "$bin missing — install incomplete" }
}

Step 'Start Firebase auth emulator (port 9099)'
$emuDir = Join-Path $root '.firebase-emulator-cache'
if (-not (Test-Path $emuDir)) { New-Item -ItemType Directory -Path $emuDir | Out-Null }
$env:FIREBASE_EMULATORS_PATH = $emuDir

# start it backgrounded, log to file
$emuLog = Join-Path $root 'firebase-emulator.log'
Start-Process -FilePath 'firebase.cmd' `
  -ArgumentList 'emulators:start','--only','auth','--project','demo-vibe' `
  -WorkingDirectory (Join-Path $root 'backend') `
  -RedirectStandardOutput $emuLog `
  -RedirectStandardError "$emuLog.err" `
  -WindowStyle Hidden

# wait for it to come up
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9099/' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -ge 200) { $ready = $true; break }
  } catch {}
}
if ($ready) { Ok 'auth emulator ready on :9099' }
else         { Fail 'auth emulator did not become ready in 30s. See firebase-emulator.log' }

Step 'Push relaxed email validation to auth emulator'
$cfgPath = Join-Path $root 'backend\auth-emulator-config.json'
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw
    $cfgUri = 'http://127.0.0.1:9099/emulator/v1/projects/demo-vibe/config'
    Invoke-WebRequest -Uri $cfgUri -Method Patch -ContentType 'application/json' -Body $cfg -UseBasicParsing -TimeoutSec 5 | Out-Null
    Ok 'auth emulator config patched'
  } catch {
    Fail "could not patch emulator config: $($_.Exception.Message)"
  }
}

Step 'Seed test user'
$seedFile = Join-Path $root 'scripts\seed-user.json'
if (Test-Path $seedFile) {
  try {
    $body = Get-Content $seedFile -Raw
    $uri = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=***'
    $r = Invoke-WebRequest -Uri $uri -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -in 200,201) {
      $j = $r.Content | ConvertFrom-Json
      Ok "user seeded: $($j.email)"
    } else {
      Fail "seed returned $($r.StatusCode): $($r.Content)"
    }
  } catch {
    Fail "seed error: $($_.Exception.Message)"
  }
} else {
  Fail "missing $seedFile"
}

Step 'Write launch commands file'
$launch = @"
# After setup completes, open TWO terminals and run these:

# === Terminal A: backend (in-memory mongo + tsx) ===
cd backend
node scripts/launch-dev.mjs

# === Terminal B: frontend ===
cd frontend
pnpm dev

# === Terminal C: (already running in background by setup) ===
# firebase emulators:start --only auth --project demo-vibe
"@
$launchPath = Join-Path $root 'launch.txt'
$launch | Out-File -FilePath $launchPath -Encoding utf8
Ok "wrote $launchPath"

Step 'Smoke-test: launch backend in background, hit /health, kill'
$backendRoot = Join-Path $root 'backend'
$backendLog = Join-Path $root 'backend-smoketest.log'
Remove-Item -Force $backendLog -ErrorAction SilentlyContinue
$backendProc = Start-Process -FilePath 'node.cmd' `
  -ArgumentList 'scripts/launch-dev.mjs' `
  -WorkingDirectory $backendRoot `
  -RedirectStandardOutput $backendLog `
  -RedirectStandardError "$backendLog.err" `
  -WindowStyle Hidden `
  -PassThru
# Wait up to 60s for backend to respond on :3141
$backendOk = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3141/health' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $backendOk = $true; break }
  } catch {}
}
try { Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 1
if ($backendOk) { Ok 'backend /health responded 200' }
else {
  Fail 'backend did not respond on :3141/health in 60s. See backend-smoketest.log'
  if (Test-Path "$backendLog.err") {
    Get-Content "$backendLog.err" -Tail 30 | Out-File -Append -FilePath $log -Encoding utf8
  }
}

Write-Host ''
Write-Host 'Done. See:' -ForegroundColor Green
Write-Host "  $log"
Write-Host "  $launchPath"
Write-Host "  $backendLog (smoke test output)"
