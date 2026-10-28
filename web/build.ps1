# Builds the browser version of CorsixTH v0.70.2 into dist/ (needs tools/emsdk, see README).
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. "$root\tools\emsdk\emsdk_env.ps1" 2>&1 | Out-Null
$pyScripts = "$env:LOCALAPPDATA\Packages\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\LocalCache\local-packages\Python312\Scripts"
if (Test-Path $pyScripts) { $env:PATH = "$pyScripts;$env:PATH" }

$build = "$root\build"
$stage = "$build\stage\corsixth"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
$src = "$root\third_party\CorsixTH\CorsixTH"

# Stage Lua scripts and Levels; keep Campaigns directory empty (multiplayer-only)
foreach ($d in "Lua","Levels") { Copy-Item -Recurse "$src\$d" "$stage\$d" }
New-Item -ItemType Directory -Force "$stage\Campaigns" | Out-Null

# Stage only runtime Bitmap assets (matching upstream CMakeLists.txt, excluding
# developer .bmp/.spec/.lua source files and unused standalone mainmenu*.dat backgrounds)
New-Item -ItemType Directory -Force "$stage\Bitmap" | Out-Null
Get-ChildItem -File "$src\Bitmap" | Where-Object {
  $_.Extension -match '^\.(tab|pal|dat|png|pl8)$' -and $_.Name -notmatch '^mainmenu\d+\.dat$'
} | ForEach-Object {
  Copy-Item $_.FullName "$stage\Bitmap\$($_.Name)"
}

Copy-Item "$src\CorsixTH.lua" "$stage\CorsixTH.lua"

New-Item -ItemType Directory -Force "$build\wasm" | Out-Null
Push-Location "$build\wasm"
# Remove output data package so Ninja re-runs the linker with updated stage files
if (Test-Path "corsixth.data") { Remove-Item -Force "corsixth.data" }
if (Test-Path "corsixth.js") { Remove-Item -Force "corsixth.js" }
emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release "$root\web"
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
cmake --build . -j 8
if ($LASTEXITCODE -ne 0) { throw "build failed" }
Pop-Location

New-Item -ItemType Directory -Force "$root\dist\game" | Out-Null
Copy-Item "$build\wasm\corsixth.*" "$root\dist\game\" -Force

$jsFile = Get-Item "$root\dist\game\corsixth.js"
$wasmFile = Get-Item "$root\dist\game\corsixth.wasm"
$dataFile = Get-Item "$root\dist\game\corsixth.data"
$hJs = (Get-FileHash $jsFile.FullName -Algorithm SHA256).Hash.ToLower()
$hWasm = (Get-FileHash $wasmFile.FullName -Algorithm SHA256).Hash.ToLower()
$hData = (Get-FileHash $dataFile.FullName -Algorithm SHA256).Hash.ToLower()
$combinedBytes = [System.Text.Encoding]::UTF8.GetBytes("$hJs|$hWasm|$hData")
$sha = [System.Security.Cryptography.SHA256]::Create()
$combinedHash = ([System.BitConverter]::ToString($sha.ComputeHash($combinedBytes)).Replace("-", "").ToLower()).Substring(0, 12)
$manifest = [ordered]@{
  hash = $combinedHash
  jsSize = $jsFile.Length
  wasmSize = $wasmFile.Length
  dataSize = $dataFile.Length
} | ConvertTo-Json
[System.IO.File]::WriteAllText("$root\dist\game\build.json", $manifest, (New-Object System.Text.UTF8Encoding $false))

Write-Host "Build done -> dist/game (hash: $combinedHash | wasm: $($wasmFile.Length) B | data: $($dataFile.Length) B)"
