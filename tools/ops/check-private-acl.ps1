$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath '.').Path
$taskPrivateRoot = Join-Path $taskRoot '.runtime'
$taskUserSid = (Get-Acl -LiteralPath (Join-Path $taskRoot '.env.local')).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$taskAllowedSids = @($taskUserSid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
$taskItems = @()
foreach ($taskFile in @('.env.local','.env.ops')) { $taskPath = Join-Path $taskRoot $taskFile; if (Test-Path -LiteralPath $taskPath) { $taskItems += Get-Item -LiteralPath $taskPath -Force } }
foreach ($taskFolder in @('keys','objects','backups','restores','fixture-runner','postgres17')) { $taskPath = Join-Path $taskPrivateRoot $taskFolder; if (Test-Path -LiteralPath $taskPath) { $taskItems += Get-Item -LiteralPath $taskPath -Force; $taskItems += Get-ChildItem -LiteralPath $taskPath -Recurse -Force } }
$taskItems += Get-Item -LiteralPath (Join-Path $taskPrivateRoot 'development-config.json') -Force
$taskIssues = @()
foreach ($taskItem in $taskItems) {
 $taskAbsolute = [System.IO.Path]::GetFullPath($taskItem.FullName)
 if (-not $taskAbsolute.StartsWith($taskRoot + [System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'ACL target escaped workspace' }
 if (($taskItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $taskIssues += @{path=$taskAbsolute.Substring($taskRoot.Length+1);reason='reparse_point'}; continue }
 $taskAcl = Get-Acl -LiteralPath $taskAbsolute
 $taskRules = $taskAcl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
 foreach ($taskRule in $taskRules) { if ($taskRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $taskAllowedSids -notcontains $taskRule.IdentityReference.Value) { $taskIssues += @{path=$taskAbsolute.Substring($taskRoot.Length+1);reason='unexpected_allow_principal';rights=[string]$taskRule.FileSystemRights} } }
}
$taskReport = @{status=$(if ($taskIssues.Count -eq 0) {'passed'} else {'failed'});at=(Get-Date).ToUniversalTime().ToString('o');scope='Read-only native Windows private runtime ACLs; Private operator owner/SYSTEM/local administrators baseline. Managed workspace sandbox grants remain unchanged; additional grants block production ACL verification.';checked_paths=$taskItems.Count;violations=$taskIssues;production_acl_claim=$false}
$taskReport | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskRoot 'reports/application/consolidated/private-windows-acl.json') -Encoding utf8
@{status=$taskReport.status;checked_paths=$taskItems.Count;violation_count=$taskIssues.Count;sample=@($taskIssues | Select-Object -First 8);receipt='reports/application/consolidated/private-windows-acl.json';production_acl_claim=$false} | ConvertTo-Json -Depth 6 -Compress
if ($taskIssues.Count -ne 0) { exit 1 }
