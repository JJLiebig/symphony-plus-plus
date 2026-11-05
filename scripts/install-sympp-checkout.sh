#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo 'This installer requires Linux.' >&2; exit 1; }
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SYMPP_SERVICE_SOURCE="$repo_root"
export SYMPP_SERVICE_REF="${SYMPP_SERVICE_REF:-$(git -C "$repo_root" symbolic-ref --short -q HEAD || git -C "$repo_root" config --get sympp.serviceRef || echo beta)}"
export SYMPP_HOME="${SYMPP_HOME:-$HOME/.agents/splusplus}"
export SYMPP_REPOS_ROOT="${SYMPP_REPOS_ROOT:-$HOME/Code}"
export SYMPP_DATABASE="${SYMPP_DATABASE:-$SYMPP_HOME/symphony_plus_plus.sqlite3}"
export SYMPP_SERVICE_HOST="${SYMPP_SERVICE_HOST:?Set SYMPP_SERVICE_HOST to the machine tailnet IPv4 address}"
export SYMPP_BACKEND_PORT="${SYMPP_BACKEND_PORT:-19998}"
export SYMPP_SERVICE_NAME="${SYMPP_SERVICE_NAME:-sympp}"
export SYMPP_SERVICE_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
[[ "$SYMPP_HOME" == /* && "$SYMPP_DATABASE" == /* && "$SYMPP_REPOS_ROOT" == /* ]] || { echo 'Factory home, ledger and repos root paths must be absolute.' >&2; exit 1; }
[[ "$SYMPP_SERVICE_NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid service name.' >&2; exit 1; }
systemctl --user show-environment >/dev/null
command -v ss >/dev/null

# Build before stopping the existing service. Never select a substitute ledger.
cd "$repo_root/elixir"
mise install
mise exec -- npm --prefix assets ci
mise exec -- npm --prefix assets run build
mise exec -- mix local.hex --force
mise exec -- mix local.rebar --force
MIX_ENV=prod mise exec -- mix deps.get --only prod
export SYMPP_SOURCE_REVISION="$(git -C "$repo_root" rev-parse HEAD)"
MIX_ENV=prod mise exec -- mix release symphony_elixir --overwrite

git -C "$repo_root" config sympp.serviceRef "$SYMPP_SERVICE_REF"

release="$SYMPP_HOME/service/releases/$(date -u +%Y%m%dT%H%M%S)-$$"
mkdir -p "$release" "$SYMPP_HOME/logs" "$SYMPP_SERVICE_CONFIG"
cp -a _build/prod/rel/symphony_elixir/. "$release/"
ln -s "$release" "$SYMPP_HOME/service/current.new"
mv -Tf "$SYMPP_HOME/service/current.new" "$SYMPP_HOME/service/current"

python3 - <<'PY'
import os
from pathlib import Path

def quoted(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('\n', '\\n') + '"'

home = os.environ['SYMPP_HOME']
env = {
    'HOME': os.environ['HOME'],
    'PATH': os.environ['PATH'],
    'SYMPP_HOME': home,
    'SYMPP_SERVICE_SOURCE': os.environ['SYMPP_SERVICE_SOURCE'],
    'SYMPP_SERVICE_REF': os.environ['SYMPP_SERVICE_REF'],
    'SYMPP_DATABASE': os.environ['SYMPP_DATABASE'],
    'SYMPP_REPOS_ROOT': os.environ['SYMPP_REPOS_ROOT'],
    'SYMPP_SOURCE_REVISION': os.environ['SYMPP_SOURCE_REVISION'],
    'SYMPP_SERVICE_MODE': '1',
    'SYMPP_SERVICE_HOST': os.environ['SYMPP_SERVICE_HOST'],
    'SYMPP_BACKEND_PORT': os.environ['SYMPP_BACKEND_PORT'],
    'SYMPP_RUNTIME_ARTIFACT': '1',
    'SYMPP_RUNTIME_ARTIFACT_ACKNOWLEDGED': '1',
    'SYMPP_LOGS_ROOT': home + '/logs',
    'SYMPP_OPEN_DASHBOARD': '0',
    'RELEASE_TMP': home + '/service/tmp',
}
for key in ['SYMPP_WORKFLOW_FILE', 'ERL_FLAGS']:
    if os.environ.get(key):
        env[key] = os.environ[key]
unit = '\n'.join([
    '[Unit]', 'Description=sympp factory', 'After=network-online.target', '',
    '[Service]', 'Type=simple', 'UMask=0077', 'Restart=on-failure', 'RestartSec=3',
    'WorkingDirectory=' + home.replace('%', '%%'),
    *['Environment=' + quoted(key + '=' + value) for key, value in env.items()],
    'ExecStart=' + quoted(home + '/service/current/bin/symphony_elixir') + ' start',
    '', '[Install]', 'WantedBy=default.target', '',
])
Path(home + '/service/tmp').mkdir(parents=True, exist_ok=True)
file = Path(os.environ['SYMPP_SERVICE_CONFIG']) / (os.environ['SYMPP_SERVICE_NAME'] + '.service')
file.write_text(unit)
print('unit: ' + str(file))
PY
# Link also supports a scratch XDG_CONFIG_HOME without changing the default unit.
systemctl --user link "$SYMPP_SERVICE_CONFIG/$SYMPP_SERVICE_NAME.service"
systemctl --user daemon-reload
systemctl --user enable "$SYMPP_SERVICE_NAME.service"
systemctl --user restart "$SYMPP_SERVICE_NAME.service"
python3 - <<'READY'
import json
import os
import time
import subprocess
import urllib.error
import urllib.request

port = os.environ['SYMPP_BACKEND_PORT']
unit = os.environ['SYMPP_SERVICE_NAME'] + '.service'
addresses = {'127.0.0.1:' + port, os.environ['SYMPP_SERVICE_HOST'] + ':' + port}
url = 'http://127.0.0.1:' + port + '/mcp/readiness'
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            health = json.load(response)
        pid = subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', 'MainPID', '--value'], text=True).strip()
        sockets = subprocess.check_output(['ss', '-H', '-ltnp', 'sport = :' + port], text=True).splitlines()
        owned = {line.split()[3] for line in sockets if 'pid=' + pid + ',' in line}
        if (pid != '0' and addresses <= owned and health.get('status') == 'ok'
                and health.get('ledger', {}).get('reachable') is True
                and health.get('source', {}).get('revision') == os.environ['SYMPP_SOURCE_REVISION']):
            break
    except (OSError, ValueError, urllib.error.URLError):
        pass
    time.sleep(0.2)
else:
    raise SystemExit('Service did not become ready. Inspect journalctl --user -u ' + os.environ['SYMPP_SERVICE_NAME'])
READY
printf 'service: %s\nendpoint: http://%s:%s\n' "$SYMPP_SERVICE_NAME" "$SYMPP_SERVICE_HOST" "$SYMPP_BACKEND_PORT"
