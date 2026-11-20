param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$serverFile = Join-Path $appRoot 'server.py'
$pythonExe = $null

if (Get-Command py -ErrorAction SilentlyContinue) {
    $candidate = & py -3 -c 'import sys; print(sys.executable); sys.exit(0 if sys.version_info >= (3,9) else 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { $pythonExe = $candidate | Select-Object -Last 1 }
}
if (-not $pythonExe) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Python39/python.exe')
    )
    $command = Get-Command python -ErrorAction SilentlyContinue
    if ($command -and $command.Source -notlike '*WindowsApps*') { $candidates += $command.Source }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            & $candidate -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)'
            if ($LASTEXITCODE -eq 0) { $pythonExe = $candidate; break }
        }
    }
}
if (-not $pythonExe) {
    Write-Host 'Python 3.9+ is required. Install a current Python release from https://www.python.org/ and try again.'
    Read-Host 'Press Enter to close'
    exit 1
}

if ($Stop) {
    & $pythonExe -X utf8 $serverFile --stop
    exit $LASTEXITCODE
}
$process = Start-Process -FilePath $pythonExe -ArgumentList @('-X', 'utf8', ('"' + $serverFile + '"'), '--open') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appRoot 'server.log') -RedirectStandardError (Join-Path $appRoot 'server-error.log') -PassThru
Start-Sleep -Seconds 2
if ($process.HasExited -and $process.ExitCode -ne 0) {
    Get-Content -LiteralPath (Join-Path $appRoot 'server-error.log')
    Read-Host 'Startup failed. Press Enter to close'
    exit 1
}
Write-Host 'Experiment Data Catalog was opened in your browser. Run this launcher again to reopen it.'
