# Linux factory service

One Linux factory owns the ledger. Agents and Herdr on the owner's devices connect
over HTTP on a private tailnet. The service listens on both `127.0.0.1:19998` and
the configured tailnet IPv4 address. Remote requests require the factory token;
loopback access keeps the existing local trust rules. The token grants the same
operator access as a local client. Assignment grants and scope checks still apply.

Install Git, mise, Python 3, a C/C++ build toolchain and the system libraries needed
by Erlang/Elixir. The installer uses `elixir/mise.toml` for Node, Erlang and Elixir.
The user needs a working systemd user manager with linger enabled.

From a checkout on the server:

```sh
SYMPP_SERVICE_HOST=100.123.207.19 just install
```

From a global Skills installation on the server:

```sh
SYMPP_SERVICE_HOST=100.123.207.19 bash ~/.agents/skills/symphony-plus-plus/scripts/setup-sympp-service.sh
```

The Skills helper builds the official `beta` branch in
`~/.local/share/symphony-plus-plus/source`. `SYMPP_SERVICE_REF` selects another
branch or tag. It refuses to overwrite local changes. It installs the same
systemd user service as `just install`; it does not register an MCP client.

The installer builds the release, installs it under
`~/.agents/splusplus/service/`, enables `symphony-plus-plus.service`, and restarts
it. Repeating the command updates that service. It uses the existing ledger at
`~/.agents/splusplus/symphony_plus_plus.sqlite3`; it never chooses a fallback
ledger. Set `SYMPP_HOME` and `SYMPP_DATABASE` to explicit absolute paths for an
isolated factory. `SYMPP_BACKEND_PORT` overrides the default port and
`SYMPP_SERVICE_NAME` selects a separate unit. Set `SYMPP_WORKFLOW_FILE` if the
factory needs workspace hooks from a workflow. Unix hooks run through `sh`.

On first startup the service creates `remote-token` inside `SYMPP_HOME` with
mode `0600`. It preserves that token on subsequent starts. Retrieve it privately:

```sh
ssh jjdev cat ~/.agents/splusplus/remote-token
```

Clients send `Authorization: Bearer <token>` on every remote HTTP request,
including MCP, readiness, leases and dashboard API calls. Missing or incorrect
credentials return `401`. Forwarded requests remain rejected. A browser URL alone
does not supply this header; use an authenticated client. No proxy, SSH tunnel or
TLS endpoint is required on the private tailnet.

The service stays running with zero clients and restarts on process failure.
It does not open a browser. Inspect or stop it with:

```sh
systemctl --user status symphony-plus-plus.service
journalctl --user -u symphony-plus-plus.service
systemctl --user stop symphony-plus-plus.service
```

To prevent startup on future logins, use `systemctl --user disable --now
symphony-plus-plus.service`. The ledger and token remain on disk. Token changes
require a service restart. Keep tokens out of logs and shared configuration.

For Linux checkout validation, install the locked dashboard dependencies with
`npm --prefix elixir/assets ci`, then run `just test`. This covers the launcher
JavaScript, factory access, token persistence, Unix worktree cleanup, and dashboard
checks. Full repository qualification remains `make -C elixir all`.
