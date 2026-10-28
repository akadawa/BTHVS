# Builds the browser version of CorsixTH into dist/ (needs tools/emsdk, see README).
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
foreach ($d in "Lua","Bitmap","Levels","Campaigns") { Copy-Item -Recurse "$src\$d" "$stage\$d" }
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

Write-Host "Build done -> dist/game (hash: $combinedHash)"

