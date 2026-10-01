# Windows PowerShell version of publish.sh.
# Requirements: git and GitHub CLI (winget install GitHub.cli), then: gh auth login
# Usage from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -Only rzip
param([string]$Only = "")
$ErrorActionPreference = "Stop"

$Owner = (gh api user --jq .login).Trim()
$OwnerLower = $Owner.ToLower()
$Root = Split-Path -Parent $PSScriptRoot
$Work = Join-Path ([IO.Path]::GetTempPath()) ("publish-" + [guid]::NewGuid())
New-Item -ItemType Directory $Work | Out-Null

function Publish-Dir($Name, $Src, $Desc, $Topics, $Pages) {
  $homepage = if ($Pages) { "https://$OwnerLower.github.io/$Name/" } else { "" }
  gh repo view "$Owner/$Name" *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "• $Name: repository exists - updating description/topics only"
  } else {
    Write-Host "• $Name: creating repository"
    gh repo create "$Owner/$Name" --public --description $Desc | Out-Null
    $dir = Join-Path $Work $Name
    Copy-Item -Recurse $Src $dir
    Push-Location $dir
    git init -q -b main
    git add -A
    git commit -q -m "Initial commit"
    git remote add origin "https://github.com/$Owner/$Name.git"
    git push -q -u origin main
    Pop-Location
  }
  if ($homepage) { gh repo edit "$Owner/$Name" --description $Desc --homepage $homepage | Out-Null }
  else { gh repo edit "$Owner/$Name" --description $Desc | Out-Null }
  foreach ($t in ($Topics -split ",")) { if ($t) { gh repo edit "$Owner/$Name" --add-topic $t | Out-Null } }
  if ($Pages) {
    gh api -X POST "repos/$Owner/$Name/pages" -f "source[branch]=main" -f "source[path]=/" *> $null
    Write-Host "  Pages: $homepage"
  }
}

foreach ($line in Get-Content (Join-Path $Root "projects\projects.tsv")) {
  $f = $line -split "`t"
  if (-not $f[0] -or ($Only -and $f[0] -ne $Only)) { continue }
  Publish-Dir $f[0] (Join-Path $Root "projects\$($f[0])") $f[1] $f[2] ($f.Count -gt 3 -and $f[3] -eq "pages")
}

if (-not $Only -or $Only -eq "portfolio") {
  $site = Join-Path $Work "site"
  New-Item -ItemType Directory $site | Out-Null
  foreach ($file in "index.html", "styles.css", "script.js", "robots.txt", "sitemap.xml") { Copy-Item (Join-Path $Root $file) $site }
  Publish-Dir "$Owner.github.io" $site "Portfolio of Sumit (Sumitrcs) - full-stack & systems developer from Delhi, India" "portfolio,developer-portfolio,sumitrcs,html,css,javascript" $false
  gh api -X POST "repos/$Owner/$Owner.github.io/pages" -f "source[branch]=main" -f "source[path]=/" *> $null
  gh repo edit "$Owner/$Owner" --description "Sumit (Sumitrcs) - GitHub profile" --homepage "https://$OwnerLower.github.io" | Out-Null
  Write-Host "• Portfolio: https://$OwnerLower.github.io"
}
Remove-Item -Recurse -Force $Work
Write-Host "`nDone. Next: on your profile click 'Customize your pins' and pin your favourite six projects."
