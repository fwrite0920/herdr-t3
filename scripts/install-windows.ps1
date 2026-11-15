# Herdr T3 + Omarchy Theme + Unified Agent Chat (herdr-chat) One-Click Installer for Windows
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1

$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $PSScriptRoot
$app = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME ".config\herdr-app" }

Write-Host "==> Installing Herdr T3 + Omarchy Theme + Unified Agent Chat into $app ..." -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path "$app\mods", "$app\layouts", "$app\themes" | Out-Null

# 1. Install all T3 mods (excluding dev check files)
Get-ChildItem -Directory "$src\mods\t3-*" | ForEach-Object {
  $dest = Join-Path "$app\mods" $_.Name
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem -Path $_.FullName -Recurse | Where-Object {
    $_.Name -notlike "check*.cjs" -and $_.Name -ne "gpui-kit.d.ts" -and $_.Name -ne "jsconfig.json"
  } | ForEach-Object {
    $rel = $_.FullName.Substring($_.Directory.FullName.Length)
    $targetDir = Join-Path $dest ($_.FullName.Substring((Join-Path $src "mods\$($_.Directory.Name)").Length) | Split-Path -Parent)
  }
  Copy-Item -Recurse -Force "$($_.FullName)\*" $dest -Exclude "check*.cjs", "gpui-kit.d.ts", "jsconfig.json"
}

# 2. Install themes (including Omarchy)
Get-ChildItem -File "$src\extras\themes\*.json" | ForEach-Object {
  Copy-Item -Force $_.FullName (Join-Path "$app\themes" $_.Name)
}

# 3. Install Unified Agent Chat (herdr-chat) mods and runtime dependencies
$hcRoot = Join-Path $src "extras\herdr-chat"
if (Test-Path $hcRoot) {
  Write-Host "==> Installing herdr-chat runtime dependencies..." -ForegroundColor Cyan
  if (-not (Test-Path (Join-Path $hcRoot "node_modules\ws"))) {
    npm --prefix $hcRoot install --omit=dev --no-audit --no-fund
  }

  foreach ($m in @("chat", "new-chat")) {
    $mDest = Join-Path "$app\mods" $m
    if (Test-Path $mDest) { Remove-Item -Recurse -Force $mDest }
    Copy-Item -Recurse -Force (Join-Path $hcRoot "herdr-app\mods\$m") $mDest
  }

  # Auto-detect CLI binary paths on this machine
  $findCmd = {
    param($name, $fallback)
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { return $c.Source.Replace("\", "/") }
    if ($fallback -and (Test-Path $fallback)) { return (Resolve-Path $fallback).Path.Replace("\", "/") }
    return $name
  }

  $hostPath = (Join-Path $hcRoot "host\main.ts").Replace("\", "/")
  $nodePath = & $findCmd "node" "C:\Program Files\nodejs\node.exe"
  $hcPath   = & $findCmd "hc" "$env:LOCALAPPDATA\Programs\herdr-core\hc.exe"
  $agyPath  = & $findCmd "agy" "$env:LOCALAPPDATA\agy\bin\agy.EXE"
  $ompPath  = & $findCmd "omp" "$env:LOCALAPPDATA\omp\omp.exe"
  $cdxPath  = & $findCmd "codex.cmd" "$env:APPDATA\npm\codex.cmd"
  $piPath   = & $findCmd "pi" $null

  $cfg = [ordered]@{
    version = "0.3.0"
    host    = $hostPath
    node    = $nodePath
    hc      = $hcPath
    agy     = $agyPath
    omp     = $ompPath
    codex   = $cdxPath
    pi      = $piPath
    claude  = "claude"
  } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText((Join-Path "$app\mods\chat" "config.json"), $cfg.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

# 4. Install herdr-t3 layout with floating new-chat block and Omarchy theme
Copy-Item -Force "$src\layouts\herdr-t3.svg" "$app\layouts\herdr-t3.svg"
$layoutObj = Get-Content -Raw "$src\layouts\herdr-t3.json" | ConvertFrom-Json
if (Test-Path "$app\mods\new-chat") {
  $floating = @($layoutObj.floating | Where-Object { $_.id -ne "new-chat" })
  $floating += [pscustomobject]@{
    id      = "new-chat"
    content = [pscustomobject]@{
      mod   = "new-chat"
      props = [pscustomobject]@{ role = "commands" }
    }
    edge    = "bottom"
    align   = "start"
  }
  $layoutObj.floating = $floating
}
$layoutJson = $layoutObj | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText("$app\layouts\herdr-t3.json", $layoutJson.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))

# 5. Merge keys.json
$keysPath = "$app\keys.json"
$repoKeys = Get-Content -Raw "$src\keys.json" | ConvertFrom-Json
$userKeys = if (Test-Path $keysPath) { Get-Content -Raw $keysPath | ConvertFrom-Json } else { [pscustomobject]@{} }
if (-not $userKeys.PSObject.Properties["global"]) {
  $userKeys | Add-Member -NotePropertyName "global" -NotePropertyValue ([pscustomobject]@{}) -Force
}
$userKeys.global | Add-Member -NotePropertyName "ctrl-i" -NotePropertyValue "new-chat.open" -Force
$userKeys.global | Add-Member -NotePropertyName "cmd-i" -NotePropertyValue "new-chat.open" -Force

foreach ($prop in $repoKeys.PSObject.Properties) {
  $sec = $prop.Name
  $val = $prop.Value
  if (-not $userKeys.PSObject.Properties[$sec]) {
    $userKeys | Add-Member -NotePropertyName $sec -NotePropertyValue $val -Force
  } else {
    foreach ($k in $val.PSObject.Properties) {
      $userKeys.$sec | Add-Member -NotePropertyName $k.Name -NotePropertyValue $k.Value -Force
    }
  }
}
$keysJson = $userKeys | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($keysPath, $keysJson.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))

# 6. Switch to herdr-t3 layout if herdr-app is running
try {
  herdr-app do layout.switch --name herdr-t3 2>$null | Out-Null
} catch {}

Write-Host "==> Done! Layout 'herdr-t3' (Omarchy theme + Unified Agent Chat) is ready." -ForegroundColor Green
