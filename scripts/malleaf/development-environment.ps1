param([Parameter(Mandatory=$true)][string]$RepositoryRoot)
$ErrorActionPreference = "Stop"
$MalleafEnvironmentJson = & node --conditions=source --import "$RepositoryRoot/node_modules/tsx/dist/loader.mjs" "$RepositoryRoot/scripts/malleaf/development-environment.mts" $RepositoryRoot --prepare --json
if ($LASTEXITCODE -ne 0) { throw "Malleaf development isolation failed" }
$MalleafEnvironment = $MalleafEnvironmentJson | ConvertFrom-Json
Get-ChildItem Env:PASEO_* | Remove-Item
Get-ChildItem Env:MALLEAF_* | Remove-Item
foreach ($Property in $MalleafEnvironment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($Property.Name, [string]$Property.Value, "Process")
}
