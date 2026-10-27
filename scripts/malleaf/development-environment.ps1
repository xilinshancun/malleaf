param([Parameter(Mandatory=$true)][string]$RepositoryRoot)
$ErrorActionPreference = "Stop"
$MalleafLoaderUrl = & node -e "process.stdout.write(require('node:url').pathToFileURL(process.argv[1]).href)" (Join-Path $RepositoryRoot "node_modules/tsx/dist/loader.mjs")
if ($LASTEXITCODE -ne 0) { throw "Malleaf loader URL resolution failed" }
$MalleafEnvironmentJson = & node --conditions=source --import $MalleafLoaderUrl "$RepositoryRoot/scripts/malleaf/development-environment.mts" $RepositoryRoot --prepare --json
if ($LASTEXITCODE -ne 0) { throw "Malleaf development isolation failed" }
$MalleafEnvironment = $MalleafEnvironmentJson | ConvertFrom-Json
Get-ChildItem Env:PASEO_* | Remove-Item
Get-ChildItem Env:MALLEAF_* | Remove-Item
foreach ($Property in $MalleafEnvironment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($Property.Name, [string]$Property.Value, "Process")
}
