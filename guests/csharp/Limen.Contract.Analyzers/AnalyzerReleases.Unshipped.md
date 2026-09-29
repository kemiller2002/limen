; Unshipped analyzer release
; https://github.com/dotnet/roslyn-analyzers/blob/main/src/Microsoft.CodeAnalysis.Analyzers/ReleaseTrackingAnalyzers.Help.md

### New Rules

Rule ID | Category | Severity | Notes
--------|----------|----------|-------
LIMEN001 | Limen.Contract | Error | Branch on a Limen contract union with its generated Match
LIMEN002 | Limen.Contract | Error | No untyped escape hatch at the Limen boundary
LIMEN003 | Limen.Contract | Error | Generated wire plumbing is not an application API
