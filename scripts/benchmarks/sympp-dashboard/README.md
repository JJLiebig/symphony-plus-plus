# Dashboard API payload profile

Profile backend assembly, JSON encoding, BEAM reductions, response bytes, and
the largest serialized fields against a deterministic fixture. This measures
the dashboard, deferred, and hydrated API payloads; it does not measure the
operator board's browser performance.

From `elixir/`, export the fixture and profile it:

```powershell
$env:MIX_ENV = "test"
mise exec -- mix run --no-start ../scripts/benchmarks/sympp-dashboard/fixture.exs ../scripts/benchmarks/sympp-dashboard/fixture.sqlite3
mise exec -- mix run --no-start ../scripts/benchmarks/sympp-dashboard/profile.exs ../scripts/benchmarks/sympp-dashboard/fixture.sqlite3 11
```

Use the same sample count at the baseline and candidate revisions. Report
medians with the sample count; do not compare warm and cold server cohorts.
