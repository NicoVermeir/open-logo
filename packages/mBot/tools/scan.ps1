# ============================================================
#  Bluetooth scanner - find the mBot2 robot
#  Uses Windows' built-in Bluetooth stack (no install needed).
#  Takes a snapshot of nearby + paired Bluetooth LE devices and
#  highlights anything that looks like the robot.
# ============================================================

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# Helper to run a WinRT async operation synchronously
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($op, $resultType) {
    $m = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $m.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

# Load WinRT types
$null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
$collType = [Windows.Devices.Enumeration.DeviceInformationCollection]

Write-Host "Scanning for Bluetooth LE devices..." -ForegroundColor Cyan
Write-Host "(Make sure the mBot2 is ON and not connected to anything else)`n"

$all = @{}

function Add-Devices($pairingState, $label) {
    $selector = [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($pairingState)
    $devs = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) $collType
    foreach ($d in $devs) {
        if ($d.Name) { $script:all[$d.Name] = $label }
    }
}

Add-Devices $true  "paired"
Add-Devices $false "nearby"

Write-Host "================ RESULTS ================" -ForegroundColor Cyan

$robotPattern = 'mbot|cyber|makeblock|bluefi'
$robots = $all.Keys | Where-Object { $_ -match $robotPattern }

if ($robots) {
    Write-Host "`n  ROBOT FOUND! ->" -ForegroundColor Green
    foreach ($r in $robots) { Write-Host ("     {0}   ({1})" -f $r, $all[$r]) -ForegroundColor Green }
} else {
    Write-Host "`n  No obvious robot name found (looked for: mbot/cyber/makeblock)." -ForegroundColor Yellow
}

Write-Host "`n  All Bluetooth LE devices seen:" -ForegroundColor Gray
if ($all.Count -eq 0) {
    Write-Host "     (none)" -ForegroundColor DarkGray
} else {
    foreach ($k in ($all.Keys | Sort-Object)) { Write-Host ("     {0,-32} ({1})" -f $k, $all[$k]) }
}
Write-Host "`n=========================================`n" -ForegroundColor Cyan
