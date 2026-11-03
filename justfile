set windows-shell := ["pwsh", "-NoProfile", "-Command"]

# Build this checkout and replace the explicitly selected local factory.
install:
    pwsh -NoProfile -File scripts/install-sympp-checkout.ps1

# Fast launcher, native view, and dashboard checks; no release qualification.
test:
    pwsh -NoProfile -File plugins/symphony-plus-plus-mcp/tests/launcher/checkout-pin-tests.ps1
    node --test plugins/symphony-plus-plus-mcp/tests/launcher/*-tests.js plugins/symphony-plus-plus-mcp/tests/launcher/*.test.js integrations/herdr-next/*.test.mjs
    npm --prefix elixir/assets run quality
    npm --prefix elixir/assets test
    node scripts/package-portable-skills.mjs --check
