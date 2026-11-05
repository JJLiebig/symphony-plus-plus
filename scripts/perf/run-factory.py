"""Run the packaged Linux factory against disposable ledgers, preserving all receipts."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

root = Path(__file__).resolve().parents[2]
output = Path(os.environ.get("PERF_OUTPUT", root / ".perf")).resolve()
output.mkdir(parents=True, exist_ok=True)
release = root / "elixir/_build/prod/rel/symphony_elixir/bin/symphony_elixir"
for repeat in range(3):
    receipts = output / str(repeat + 1)
    receipts.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sympp-factory-perf-") as scratch:
        home = Path(scratch)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = dict(os.environ, HOME=scratch, SYMPP_HOME=scratch,
                   SYMPP_DATABASE=str(home / "ledger.sqlite3"), SYMPP_LOGS_ROOT=scratch,
                   SYMPP_RUNTIME_ARTIFACT="1", SYMPP_RUNTIME_ARTIFACT_ACKNOWLEDGED="1",
                   SYMPP_BACKEND_PORT="0", PERF_SOURCE=str(root), PERF_PORT=str(port),
                   PERF_OUTPUT=str(receipts))
        env.pop("SYMPP_SERVICE_MODE", None)
        env.pop("SYMPP_WORKFLOW_FILE", None)
        env.pop("SYMPP_OPERATOR_CONFIG", None)
        with (receipts / "server.log").open("w") as log:
            server = subprocess.Popen([str(release), "eval", f'Code.eval_file("{root}/scripts/perf/factory-server.exs")'],
                                      env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                for attempt in range(120):
                    if server.poll() is not None:
                        raise RuntimeError("Packaged server exited; see server.log")
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}/mcp/readiness", timeout=1):
                            break
                    except OSError:
                        time.sleep(.5)
                else:
                    raise RuntimeError("Packaged server readiness timed out; see server.log")
                with (receipts / "client.log").open("w") as client_log:
                    subprocess.run(["node", str(root / "scripts/perf/factory.mjs")], env=env,
                                   stdout=client_log, stderr=subprocess.STDOUT, check=True)
            finally:
                if server.poll() is None:
                    os.killpg(server.pid, signal.SIGTERM)
                    try:
                        server.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(server.pid, signal.SIGKILL)
                        server.wait()
                for log_path in (home / "log").glob("*"):
                    if log_path.is_file():
                        (receipts / log_path.name).write_bytes(log_path.read_bytes())
    print(json.dumps({"repeat": repeat + 1, "summary": str(receipts / "summary.json")}))
