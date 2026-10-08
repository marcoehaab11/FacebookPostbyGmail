param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskUrl = 'http://127.0.0.1:3210'
$taskReady = $false
try {
    $taskResponse = Invoke-RestMethod -Uri "$taskUrl/api/bootstrap" -TimeoutSec 2
    $taskReady = $null -ne $taskResponse.settings
} catch { }
if (-not $taskReady) {
    $taskNode = (Get-Command node -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    $taskData = Join-Path $PSScriptRoot 'data'
    New-Item -ItemType Directory -Path $taskData -Force | Out-Null
    Start-Process -FilePath $taskNode -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskData 'server-output.log') -RedirectStandardError (Join-Path $taskData 'server-error.log')
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $taskResponse = Invoke-RestMethod -Uri "$taskUrl/api/bootstrap" -TimeoutSec 2
            if ($null -ne $taskResponse.settings) { $taskReady = $true; break }
        } catch { }
    }
    if (-not $taskReady) { throw 'NUVEXA did not start. See data/server-error.log.' }
}
if (-not $NoBrowser) { Start-Process -FilePath $taskUrl }
Write-Output 'NUVEXA is ready at http://127.0.0.1:3210'
