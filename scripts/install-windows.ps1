# Herdr T3 + Omarchy Theme + Better Search One-Click Installer for Windows
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1

$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $PSScriptRoot
$app = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME ".config\herdr-app" }

Write-Host "==> Installing Herdr T3 + Omarchy Theme + Better Search into $app ..." -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path "$app\mods", "$app\layouts", "$app\themes" | Out-Null

# 1. Install all shipped mods (t3-* and better-search), excluding dev check files
$modDirs = @(Get-ChildItem -Directory "$src\mods\t3-*")
if (Test-Path "$src\mods\better-search") {
  $modDirs += Get-Item "$src\mods\better-search"
}
foreach ($modDir in $modDirs) {
  $dest = Join-Path "$app\mods" $modDir.Name
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Recurse -Force "$($modDir.FullName)\*" $dest -Exclude "check*.cjs", "gpui-kit.d.ts", "jsconfig.json"
  Get-ChildItem -Path $dest -Filter "check*.cjs" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

# Remove retired mods (t3-todos, t3-favorites, chat, new-chat) if present from earlier installs
foreach ($retired in @("t3-todos", "t3-favorites", "chat", "new-chat")) {
  $retiredPath = Join-Path "$app\mods" $retired
  if (Test-Path $retiredPath) {
    Remove-Item -Recurse -Force $retiredPath -ErrorAction SilentlyContinue
  }
}

# 2. Install themes (including Omarchy)
Get-ChildItem -File "$src\extras\themes\*.json" | ForEach-Object {
  Copy-Item -Force $_.FullName (Join-Path "$app\themes" $_.Name)
}

# 3. Install herdr-t3 layout
Copy-Item -Force "$src\layouts\herdr-t3.svg" "$app\layouts\herdr-t3.svg"
$layoutObj = Get-Content -Raw "$src\layouts\herdr-t3.json" | ConvertFrom-Json
$layoutJson = $layoutObj | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText("$app\layouts\herdr-t3.json", $layoutJson.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))

# 4. Merge keys.json
$keysPath = "$app\keys.json"
$repoKeys = Get-Content -Raw "$src\keys.json" | ConvertFrom-Json
$userKeys = if (Test-Path $keysPath) { Get-Content -Raw $keysPath | ConvertFrom-Json } else { [pscustomobject]@{} }

# Remove retired new-chat bindings only if they still hold our old defaults
if ($userKeys.PSObject.Properties["global"]) {
  foreach ($k in @("ctrl-i", "ctrl-shift-i", "cmd-i")) {
    if ($userKeys.global.PSObject.Properties[$k] -and $userKeys.global.$k -eq "new-chat.open") {
      $userKeys.global.PSObject.Properties.Remove($k)
    }
  }
}

if ($userKeys.PSObject.Properties["layout:herdr-t3"]) {
  $oldLayoutKeys = @{
    "ctrl-p"       = "mod.open:t3-picker"
    "ctrl-]"       = "t3-tabs.next"
    "ctrl-["       = "t3-tabs.prev"
    "ctrl-w"       = "t3-tabs.close-tab"
    "ctrl-t"       = "t3-tabs.new"
    "cmd-i"        = "new-chat.open"
    "ctrl-shift-i" = "new-chat.open"
  }
  foreach ($ok in $oldLayoutKeys.Keys) {
    if ($userKeys."layout:herdr-t3".PSObject.Properties[$ok] -and $userKeys."layout:herdr-t3".$ok -eq $oldLayoutKeys[$ok]) {
      $userKeys."layout:herdr-t3".PSObject.Properties.Remove($ok)
    }
  }
}

foreach ($retiredSec in @("mod:t3-todos", "mod:t3-favorites", "mod:new-chat", "mod:chat")) {
  if ($userKeys.PSObject.Properties[$retiredSec]) {
    $userKeys.PSObject.Properties.Remove($retiredSec)
  }
}

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

# 5. Switch to herdr-t3 layout if herdr-app is running
try {
  herdr-app do layout.switch --name herdr-t3 2>$null | Out-Null
} catch {}

Write-Host "==> Done! Layout 'herdr-t3' (with Better Search) is ready." -ForegroundColor Green
