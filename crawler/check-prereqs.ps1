Write-Host "=== Kickflip AWS Deploy - Prerequisites Check ===" -ForegroundColor Cyan

$checks = @(
    @{ name = "AWS CLI";    cmd = "aws --version" },
    @{ name = "AWS creds";  cmd = "aws sts get-caller-identity --query Account --output text" },
    @{ name = "Docker";     cmd = "docker info --format Server" },
    @{ name = "jq";         cmd = "jq --version" },
    @{ name = "WSL/Bash";   cmd = "bash --version" }
)

foreach ($check in $checks) {
    try {
        $result = Invoke-Expression $check.cmd 2>&1
        $firstLine = ($result | Out-String).Trim().Split([System.Environment]::NewLine)[0]
        if ($LASTEXITCODE -eq 0 -or $firstLine) {
            Write-Host "  [OK] $($check.name): $firstLine" -ForegroundColor Green
        } else {
            Write-Host "  [MISSING] $($check.name)" -ForegroundColor Red
        }
    } catch {
        Write-Host "  [MISSING] $($check.name)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "If Docker shows [MISSING]: open Docker Desktop from the Start Menu and wait for it to fully start." -ForegroundColor Yellow
Write-Host "If AWS creds shows [MISSING]: run 'aws configure' to set up your credentials." -ForegroundColor Yellow
