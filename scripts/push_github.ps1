# scripts/push_github.ps1
# Synchronizes git.gol.lan (with AGENTS.md) and github (without AGENTS.md)
param([string]$CommitMessage = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> 1. Pushing to git.gol.lan (origin main with AGENTS.md)..." -ForegroundColor Cyan
git push origin main -v

Write-Host "==> 2. Preparing clean public branch for GitHub..." -ForegroundColor Cyan
git checkout -B github-release main
if (Test-Path "AGENTS.md") {
    git rm -f AGENTS.md
    git commit -m $(if ($CommitMessage) { $CommitMessage } else { "sync: public release to github" })
}

Write-Host "==> 3. Pushing to GitHub (github main without AGENTS.md)..." -ForegroundColor Cyan
git push github github-release:main --force

Write-Host "==> 4. Restoring local branch main..." -ForegroundColor Cyan
git checkout main
git branch -D github-release

Write-Host "==> Successfully synchronized! git.gol.lan has AGENTS.md, GitHub is clean." -ForegroundColor Green
