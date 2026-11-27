# Windows native sync & full check script (equivalent to scripts/sync.sh + scripts/check.sh without requiring rsync).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\check-windows.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\check-windows.ps1 -Install
#   powershell -ExecutionPolicy Bypass -File .\scripts\check-windows.ps1 -SkipTsc
param(
  [switch]$Install,
  [switch]$SkipTsc,
  [switch]$SkipUnitTests
)

$ErrorActionPreference = "Continue"
$src = Split-Path -Parent $PSScriptRoot
$app = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME ".config\herdr-app" }
if ((Test-Path "C:\Program Files\Git\bin") -and ($env:PATH -notlike "*C:\Program Files\Git\bin*")) {
  $env:PATH = "C:\Program Files\Git\bin;$env:PATH"
}
$fail = 0

Write-Host "==> 1. Syncing shared/*.js from scripts/sync.sh declarations..." -ForegroundColor Cyan
$syncLines = Get-Content "$src\scripts\sync.sh"
foreach ($line in $syncLines) {
  if ($line -match '^\s*share\s+([a-z0-9-]+)\s+(.+)$') {
    $modName = $Matches[1]
    $targets = $Matches[2].Trim() -split '\s+'
    $srcFile = Join-Path $src "shared\$modName.js"
    if (-not (Test-Path $srcFile)) {
      Write-Host "FAIL missing shared source: $srcFile" -ForegroundColor Red
      $fail = 1
      continue
    }
    foreach ($t in $targets) {
      $dstDir = Join-Path $src ($t -replace '/', '\')
      if (Test-Path $dstDir) {
        Copy-Item -Force $srcFile (Join-Path $dstDir "$modName.js")
      }
    }
  }
}

Write-Host "==> 2. Verifying RECIPE byte limits (<= 60,000 bytes)..." -ForegroundColor Cyan
foreach ($recipe in @("RECIPE.md", "RECIPE.zh-CN.md")) {
  $bytes = (Get-Item (Join-Path $src $recipe)).Length
  Write-Host ("  {0}: {1} / 60000 bytes" -f $recipe, $bytes)
  if ($bytes -gt 60000) {
    Write-Host "FAIL $recipe exceeds 60000 bytes ($bytes)" -ForegroundColor Red
    $fail = 1
  }
}

Write-Host "==> 3. Verifying shared/*.js copy parity..." -ForegroundColor Cyan
Get-ChildItem "$src\shared\*.js" | ForEach-Object {
  $name = $_.Name
  $srcHash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
  Get-ChildItem -Recurse -File -Path "$src\mods","$src\extras\mods" -Filter $name | ForEach-Object {
    $dstHash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) {
      Write-Host "FAIL $($_.FullName) differs from shared\$name" -ForegroundColor Red
      $fail = 1
    }
  }
}

Write-Host "==> 4. Verifying icon paths, accent_foreground rule, and JSON validity..." -ForegroundColor Cyan
$jsFiles = Get-ChildItem -Recurse -File -Path "$src\shared","$src\mods","$src\extras\mods" -Filter "*.js" | Where-Object { $_.Name -ne "gpui-kit.d.ts" }
$icons = New-Object System.Collections.Generic.HashSet[string]
foreach ($f in $jsFiles) {
  $text = [System.IO.File]::ReadAllText($f.FullName)
  foreach ($m in [regex]::Matches($text, 'mods/(t3-[a-z-]+|review|pulls-review)/[a-z0-9/-]+\.svg')) {
    [void]$icons.Add($m.Value)
  }
  if ($text -match 'accent_foreground' -and $f.FullName -notmatch 'extras\\mods\\review\\controls\.js$') {
    Write-Host "FAIL $($f.FullName) uses forbidden accent_foreground" -ForegroundColor Red
    $fail = 1
  }
}
foreach ($p in $icons) {
  $rel = $p -replace '/', '\'
  if (-not (Test-Path (Join-Path $src $rel)) -and -not (Test-Path (Join-Path $src "extras\$rel"))) {
    Write-Host "FAIL missing icon: $p" -ForegroundColor Red
    $fail = 1
  }
}
Write-Host "  Checked $($icons.Count) icon references."

try {
  $null = Get-Content -Raw "$src\layouts\herdr-t3.json" | ConvertFrom-Json
  $keysObj = Get-Content -Raw "$src\keys.json" | ConvertFrom-Json
} catch {
  Write-Host "FAIL invalid JSON in layouts/herdr-t3.json or keys.json: $_" -ForegroundColor Red
  $fail = 1
}

if ($Install) {
  Write-Host "==> 5. Installing into $app ..." -ForegroundColor Cyan
  & powershell -ExecutionPolicy Bypass -File "$src\scripts\install-windows.ps1"
  if ($LASTEXITCODE -ne 0) { $fail = 1 }
}

Write-Host "==> 6. Running herdr-app check on all mods..." -ForegroundColor Cyan
$modDirs = @(Get-ChildItem -Directory "$src\mods\t3-*")
if (Test-Path "$src\mods\better-search") { $modDirs += Get-Item "$src\mods\better-search" }
if (Test-Path "$src\extras\mods") { $modDirs += @(Get-ChildItem -Directory "$src\extras\mods") }
foreach ($d in $modDirs) {
  $out = (& herdr-app check $d.FullName 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $out -notmatch 'check passed') {
    Write-Host "FAIL herdr-app check $($d.Name)" -ForegroundColor Red
    ($out -split "`r?`n") | Select-Object -Last 15 | ForEach-Object { Write-Host "  $_" }
    $fail = 1
  }
}
Write-Host "  herdr-app check finished across $($modDirs.Count) mods."

if (-not $SkipTsc) {
  Write-Host "==> 7. Running tsc --noEmit --checkJs via Git Bash..." -ForegroundColor Cyan
  $sh = "C:\Program Files\Git\bin\sh.exe"
  if (Test-Path $sh) {
    $tscScript = @'
set -u
fail=0
ts="--noEmit --allowJs --checkJs --target ES2022 --module ES2022 --moduleResolution bundler --lib ES2022 --strict --strictNullChecks false --noImplicitAny false --useUnknownInCatchVariables false --skipLibCheck"
for d in mods/t3-*/ mods/better-search/ extras/mods/*/; do
  [ -d "$d" ] || continue
  dts="${d}gpui-kit.d.ts"; [ -f "$dts" ] || dts="mods/t3-files/gpui-kit.d.ts"
  out=$(bunx -p typescript tsc $ts "$d"*.js "$dts" types/*.d.ts 2>&1) || { echo "FAIL tsc $d"; echo "$out" | tail -20; fail=1; }
done
exit "$fail"
'@
    Push-Location $src
    & $sh -c $tscScript
    if ($LASTEXITCODE -ne 0) { $fail = 1 }
    Pop-Location
  } else {
    Write-Host "WARN Git Bash sh.exe not found; skipping tsc step." -ForegroundColor Yellow
  }
}

if (-not $SkipUnitTests) {
  Write-Host "==> 8. Running Node check*.cjs unit tests..." -ForegroundColor Cyan
  $checks = Get-ChildItem -Recurse -File -Path "$src\shared","$src\mods","$src\extras\mods" -Filter "check*.cjs"
  Push-Location $app
  foreach ($c in $checks) {
    $out = & node -r "$src\scripts\render-guard.cjs" $c.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "FAIL $($c.FullName)" -ForegroundColor Red
      $out | Select-Object -Last 12 | ForEach-Object { Write-Host "  $_" }
      $fail = 1
    } else {
      Write-Host "  OK $($c.Name)"
    }
  }
  Pop-Location
}

if ($fail -eq 0) {
  Write-Host "==> all Windows checks passed" -ForegroundColor Green
} else {
  Write-Host "==> checks failed (see errors above)" -ForegroundColor Red
}
exit $fail
