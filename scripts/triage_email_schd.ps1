# Test multiple ways to execute the flow
$PADPath = "C:\Program Files (x86)\Power Automate Desktop\PAD.Console.Host.exe"
$FlowId = "e3582efd-755e-48ef-83d5-ebfb2d2ca706"

Write-Host "=== Testing Different Execution Methods ===" -ForegroundColor Cyan

# Method 1: Basic execution with detailed monitoring
Write-Host "`n1. Basic Execution with Process Monitoring" -ForegroundColor Yellow

$beforeProcesses = Get-Process | Where-Object {$_.ProcessName -like "PAD*"}
Write-Host "PAD processes before: $($beforeProcesses.Count)" -ForegroundColor Gray

$startTime = Get-Date
$process = Start-Process -FilePath $PADPath -ArgumentList "-workflowid", $FlowId -Wait -PassThru -WindowStyle Hidden
$endTime = Get-Date
$duration = $endTime - $startTime

$afterProcesses = Get-Process | Where-Object {$_.ProcessName -like "PAD*"}
Write-Host "PAD processes after: $($afterProcesses.Count)" -ForegroundColor Gray
Write-Host "Duration: $([math]::Round($duration.TotalSeconds, 2)) seconds" -ForegroundColor White
Write-Host "Exit Code: $($process.ExitCode)" -ForegroundColor $(if($process.ExitCode -eq 0){"Green"}else{"Red"})

if ($duration.TotalSeconds -lt 2) {
    Write-Host "⚠️  Execution too fast - likely not actually running" -ForegroundColor Yellow
} else {
    Write-Host "✅ Execution took reasonable time" -ForegroundColor Green
}

# Method 2: Try with different parameters
Write-Host "`n2. Testing with Different Parameters" -ForegroundColor Yellow

$parameterTests = @(
    @{Name="No Environment"; Args=@("-workflowid", $FlowId)},
    @{Name="With Environment"; Args=@("-workflowid", $FlowId, "-environment", "Default-46c98d88-e344-4ed4-8496-4ed7712e255d")},
    @{Name="With Timeout"; Args=@("-workflowid", $FlowId, "-timeout", "300")},
    @{Name="With Culture"; Args=@("-workflowid", $FlowId, "-culture", "en-US")},
    @{Name="Verbose Mode"; Args=@("-workflowid", $FlowId, "-verbose")}
)

foreach ($test in $parameterTests) {
    Write-Host "   Testing: $($test.Name)" -ForegroundColor Cyan
    try {
        $testStart = Get-Date
        $testProcess = Start-Process -FilePath $PADPath -ArgumentList $test.Args -Wait -PassThru -WindowStyle Hidden
        $testDuration = (Get-Date) - $testStart
        
        Write-Host "   Result: Exit $($testProcess.ExitCode), Duration: $([math]::Round($testDuration.TotalSeconds, 2))s" -ForegroundColor $(if($testProcess.ExitCode -eq 0){"Green"}else{"Red"})
        
        if ($testDuration.TotalSeconds -gt 5) {
            Write-Host "   🎯 This method took longer - might be working!" -ForegroundColor Green
        }
    } catch {
        Write-Host "   ❌ Failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}