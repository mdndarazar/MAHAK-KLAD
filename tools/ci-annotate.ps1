# Runs one Node test file on CI and, when it fails, mirrors the tail of its
# output into a GitHub error annotation. Job log downloads can be unavailable to
# the development sandbox, while annotations are returned by the GitHub API.
# Diagnostic wrapper only: it does not retry, skip or otherwise alter the test.
param(
  [Parameter(Mandatory = $true)][string]$Test
)
if (-not (Test-Path -LiteralPath $Test -PathType Leaf)) {
  Write-Output "::error title=Missing test::$Test"
  exit 2
}
$name = [IO.Path]::GetFileNameWithoutExtension($Test)
$log = Join-Path $env:RUNNER_TEMP ($name + '-' + [Guid]::NewGuid().ToString('N') + '.log')
cmd /c "node --import ./test/harness/register.mjs `"$Test`" > `"$log`" 2>&1"
$code = $LASTEXITCODE
$text = ''
if (Test-Path -LiteralPath $log) {
  Get-Content -LiteralPath $log
  $raw = Get-Content -LiteralPath $log -Raw
  if ($null -ne $raw) { $text = $raw }
}
if ($code -ne 0) {
  if ($text.Length -gt 12000) { $text = $text.Substring($text.Length - 12000) }
  $text = $text.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
  Write-Output "::error title=${name}::exit ${code}%0A${text}"
  exit $code
}
exit 0
