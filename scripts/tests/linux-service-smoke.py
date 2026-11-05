"""Qualify an explicitly selected disposable systemd factory (kills its main process)."""
import argparse
import json
from pathlib import Path
import stat
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--unit', required=True)
parser.add_argument('--home', type=Path, required=True)
parser.add_argument('--host', required=True)
parser.add_argument('--port', type=int, default=19998)
args = parser.parse_args()
token_path = args.home / 'remote-token'
token = token_path.read_text().strip()
assert stat.S_IMODE(token_path.stat().st_mode) == 0o600


def request(host, route, credential=None, payload=None, headers=None):
    config = []
    if credential:
        config.append('header = "Authorization: Bearer ' + credential + '"')
    for name, value in (headers or {}).items():
        config.append('header = ' + json.dumps(name + ': ' + value))
    command = ['curl', '--silent', '--show-error', '--max-time', '5', '--config', '-',
               '--write-out', '\n%{http_code}', f'http://{host}:{args.port}{route}']
    if payload is not None:
        command += ['--header', 'Content-Type: application/json', '--data', json.dumps(payload)]
    result = subprocess.run(command, input='\n'.join(config), capture_output=True, text=True, check=True)
    body, code = result.stdout.rsplit('\n', 1)
    return int(code), body


def main_pid():
    return subprocess.check_output(['systemctl', '--user', 'show', args.unit, '-p', 'MainPID', '--value'], text=True).strip()


for host, credential, expected in [('127.0.0.1', None, 200), (args.host, None, 401),
                                   (args.host, 'incorrect', 401), (args.host, token, 200)]:
    code, _ = request(host, '/mcp/readiness', credential)
    assert code == expected, f'readiness returned {code}, expected {expected}'
for route in ['/sympp/board', '/api/v1/sympp/herdr/dashboard', '/api/v1/sympp/operator/dashboard']:
    assert request(args.host, route)[0] == 401
    assert request(args.host, route, token)[0] == 200
for action in ['attach', 'heartbeat', 'detach']:
    assert request(args.host, '/mcp/client-lease', token, {'client_id': 'linux-service-smoke', 'action': action})[0] == 200
pid = main_pid()
time.sleep(3)
assert main_pid() == pid and request(args.host, '/mcp/readiness', token)[0] == 200
print('access: loopback_200 remote_missing_401 remote_wrong_401 remote_valid_200')
print('routes: board herdr_dashboard operator_dashboard client_lease')
print('idle: survived_last_detach')
subprocess.run(['systemctl', '--user', 'kill', '--kill-whom=main', '--signal=KILL', args.unit], check=True)
for _ in range(60):
    time.sleep(1)
    try:
        current = main_pid()
        if current not in ['0', pid] and request(args.host, '/mcp/readiness', token)[0] == 200:
            break
    except subprocess.CalledProcessError:
        pass
else:
    raise AssertionError('service did not restart')
assert token_path.read_text().strip() == token
print('restart: passed_token_preserved')
