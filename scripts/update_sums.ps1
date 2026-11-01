Get-ChildItem -Path deliverables\*.apk, deliverables\*.zip | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    "$hash  $($_.Name)"
} | Set-Content -Path deliverables\SHA256SUMS.txt

Get-Content deliverables\SHA256SUMS.txt
