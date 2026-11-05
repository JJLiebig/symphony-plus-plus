# Development

## Toolchain

The Elixir project pins its toolchain through `elixir/mise.toml`.

```powershell
mise trust .\elixir\mise.toml
Push-Location .\elixir
mise install
mise exec -- mix deps.get
Pop-Location
```

## Main Gate

See [Testing](testing.md) for native candidate acceptance, hosted evidence, and
the workstation runtime execution restriction. The commands below apply only
where executable validation is authorized.

Run the repository gate from the root:

```powershell
make all
```

For Elixir static checks and the retained qualification suite, run
`make -C elixir all`. `make -C elixir ci-full` also runs Dialyzer. The hosted
`make-all` workflow additionally requires candidate API/browser, installed/offline,
Windows and frontend qualifications described in [Testing](testing.md).

Frontend-only iteration can use:

```powershell
Push-Location .\elixir\assets
npm test
npm run quality
npm run build
npm run build:herdr
Pop-Location
```

## Release Discipline

- Validate the exact pull-request head.
- Keep runtime contract identity synchronized with the live MCP catalog.
- Build runtime artifacts from the intended source revision.
- Treat installed-cache and fresh-session validation as release/cutover work,
  not ordinary feature-branch development.
- Do not mutate the user's installed plugin or running daemon during tests.

See [Runtime](runtime.md) for installed artifact ownership and repair.

## Documentation Changes

Current guides describe implemented behavior. Approved beta target contracts
belong under `docs/design/`, explicitly labeled and linked from the index; they
do not replace current operating procedures. Update the owning skill when agent
procedure changes, code/tests when behavior changes, and the current guides
when the human model changes. Do not keep duplicate plans, migration diaries,
or completed implementation plans in the active tree.
