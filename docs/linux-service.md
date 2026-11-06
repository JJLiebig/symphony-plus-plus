# Linux factory service

One Linux factory owns the ledger. Agents and Herdr on the owner's devices connect
over HTTP on a private tailnet. The service listens on both `127.0.0.1:19998` and
the configured tailnet IPv4 address. The board is readable without a token from the tailnet; all other remote requests require the factory token;
loopback access keeps the existing local trust rules. The token grants the same
operator access as a local client. Assignment grants and scope checks still apply.

Install Git, mise, Python 3, iproute2 (`ss`), a C/C++ build toolchain and the system libraries needed
by Erlang/Elixir. The installer uses `elixir/mise.toml` for Node, Erlang and Elixir.
The user needs a working systemd user manager with linger enabled.

From a checkout on the server:

```sh
SYMPP_SERVICE_HOST=100.123.207.19 just install
```

From a global Skills installation on the server:

```sh
SYMPP_SERVICE_HOST=100.123.207.19 bash ~/.agents/skills/sympp/scripts/setup-sympp-service.sh
```

The Skills helper builds the official `main` branch in
`~/.local/share/symphony-plus-plus/source`. `SYMPP_SERVICE_REF` selects another
branch or tag. It refuses to overwrite local changes. It installs the same
systemd user service as `just install`; it does not register an MCP client.

The installer builds the release, installs it under
`~/.agents/splusplus/service/`, enables `sympp.service`, and restarts
it. Repeating the command updates that service. It uses the existing ledger at
`~/.agents/splusplus/symphony_plus_plus.sqlite3`; it never chooses a fallback
ledger. Set `SYMPP_HOME` and `SYMPP_DATABASE` to explicit absolute paths for an
isolated factory. `SYMPP_BACKEND_PORT` overrides the default port and
`SYMPP_SERVICE_NAME` selects a separate unit. Set `SYMPP_WORKFLOW_FILE` if the
factory needs workspace hooks from a workflow. Unix hooks run through `sh`.

Clean up active worktrees before changing the configured worktree root. Existing
recorded worktrees must remain under the root used to create them.

Set `SYMPP_REPOS_ROOT` at installation to the server's checkout directory
(default `$HOME/Code`; on jjdev `/srv/jjdev/Code`). Repositories are selected by
remote URL or `owner/name`. The factory reuses a matching checkout or clones it
once, using the service user's Git credentials. Discovery searches three directory
levels below the root, skips `.worktrees` and directory symlinks, and stops at Git
checkouts. The shallowest matching checkout wins; equally shallow matches return
an ambiguity error. New repositories go beside checkouts of the same GitHub owner
when those checkouts share one parent, otherwise directly under the root. A same-name checkout with a
different remote is refused. Worktrees live under
`<repos root>/.worktrees/<repo>/<branch slug>-<package hash>`.
Clients never prepare local worktrees. The bridge resolves client paths to their
origin and can infer the intake repo from its working checkout. Preparation
returns `worktree: <server alias>:<path>`; the caller launches the worker with
`hc run --bg --on <server alias> --cwd <path> ...`. The factory does not launch
workers automatically. Same-machine factories without `SYMPP_REPOS_ROOT` retain
the existing local checkout and worktree behavior.

On first startup the service creates `remote-token` inside `SYMPP_HOME` with
mode `0600` and preserves it on subsequent starts. On each client, install the
skill with `npx skills add JJLiebig/sympp -g`, then ask the agent to set up sympp.
After initial setup, use:

```sh
sympp --server jjdev
sympp status
sympp update
```

Setup retrieves the credential privately over SSH and installs the panel when
Herdr-app is present. `sympp update` refreshes the skill and client registrations,
then rebuilds and restarts the factory over that same SSH host, preserving its
ledger, repository root, port, workflow and service name. Never print the credential.

For a separate factory, set `SYMPP_REMOTE_HOME`, `SYMPP_REMOTE_PORT`, and
`SYMPP_REMOTE_SERVICE` on the client before setup. Setup saves them for updates.
Service installs record their checkout and ref for future updates. Older Skills
service installs use the documented default checkout and main ref; reinstall a
custom checkout once with `just install` before updating it from a client.

Clients send `Authorization: Bearer <token>` on every remote HTTP request,
including MCP, readiness, leases and dashboard API calls. Missing or incorrect
credentials return `401` except for board reads from the tailnet. Forwarded requests remain rejected.
A plain tailnet browser can read the board; `sympp board` signs in with the saved token for editing. No proxy, SSH tunnel or
TLS endpoint is required on the private tailnet.

The service stays running with zero clients and restarts on process failure.
It does not open a browser. Inspect or stop it with:

```sh
systemctl --user status sympp.service
journalctl --user -u sympp.service
systemctl --user stop sympp.service
```

To prevent startup on future logins, use `systemctl --user disable --now
sympp.service`. The ledger and token remain on disk. Token changes
require a service restart. Keep tokens out of logs and shared configuration.

For Linux checkout validation, install the locked dashboard dependencies with
`npm --prefix elixir/assets ci`, then run `just test`. This covers the launcher
JavaScript, factory access, token persistence, Unix worktree cleanup, and dashboard
checks. Full repository qualification remains `make -C elixir all`.
