set windows-shell := ["pwsh", "-NoProfile", "-Command"]

# Build this checkout and replace the explicitly selected local factory.
[windows]
install:
    pwsh -NoProfile -File scripts/install-sympp-checkout.ps1

[linux]
install:
    bash scripts/install-sympp-checkout.sh

# Fast launcher, native view, and dashboard checks; no release qualification.
[windows]
test:
    pwsh -NoProfile -File plugins/symphony-plus-plus-mcp/tests/launcher/checkout-pin-tests.ps1
    node --test plugins/symphony-plus-plus-mcp/tests/launcher/*-tests.js plugins/symphony-plus-plus-mcp/tests/launcher/*.test.js integrations/herdr-next/*.test.mjs
    npm --prefix elixir/assets run quality
    npm --prefix elixir/assets test
    node scripts/package-portable-skills.mjs --check

[linux]
test:
    node --test scripts/tests/linux-service-install.test.js
    node --test plugins/symphony-plus-plus-mcp/tests/launcher/*-tests.js plugins/symphony-plus-plus-mcp/tests/launcher/*.test.js integrations/herdr-next/*.test.mjs
    cd elixir && mise exec -- mix test test/symphony_elixir/symphony_plus_plus/mcp_http_endpoint_test.exs test/symphony_elixir/symphony_plus_plus/worktree_lifecycle_compat_test.exs test/symphony_elixir/symphony_plus_plus/factory_service_test.exs
    npm --prefix elixir/assets run quality
    npm --prefix elixir/assets test
    node scripts/package-portable-skills.mjs --check
