#!/usr/bin/env bash
set -euo pipefail
# Read only the chosen unit's install settings; do not print its environment.
python3 - "$1" <<'PY'
import os
from pathlib import Path
import shlex
import subprocess
import sys
unit = sys.argv[1] + '.service'
raw = subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', 'Environment', '--value'], text=True)
values = dict(item.split('=', 1) for item in shlex.split(raw) if '=' in item)
if not values.get('SYMPP_HOME') or not values.get('SYMPP_SERVICE_HOST'):
    raise SystemExit('Factory service is not installed. Run its installer first.')
allowed = ['PATH', 'SYMPP_HOME', 'SYMPP_DATABASE', 'SYMPP_REPOS_ROOT', 'SYMPP_BACKEND_PORT', 'SYMPP_SERVICE_HOST', 'SYMPP_WORKFLOW_FILE', 'ERL_FLAGS', 'SYMPP_SERVICE_SOURCE', 'SYMPP_SERVICE_REF']
env = dict(os.environ, **{key: values[key] for key in allowed if key in values})
env['SYMPP_SERVICE_NAME'] = sys.argv[1]
fragment = subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', 'FragmentPath', '--value'], text=True).strip()
env['XDG_CONFIG_HOME'] = str(Path(fragment).resolve().parents[2])
# Use the saved factory source and ref.
source = Path(values.get('SYMPP_SERVICE_SOURCE', str(Path.home() / '.local/share/symphony-plus-plus/source')))
ref = values.get('SYMPP_SERVICE_REF', 'main')
if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True).strip():
    raise SystemExit('Factory checkout has local changes. Commit or remove them before updating.')
subprocess.run(['git', '-C', str(source), 'fetch', 'origin', ref], check=True)
subprocess.run(['git', '-C', str(source), 'checkout', '--detach', 'FETCH_HEAD'], check=True)
env['SYMPP_SERVICE_REF'] = ref
subprocess.run(['bash', str(source / 'scripts/install-sympp-checkout.sh')], env=env, check=True)
PY
