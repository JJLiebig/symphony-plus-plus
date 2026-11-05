#!/usr/bin/env bash
set -euo pipefail

manifest_paths=()
manifest_dir=""
required_platforms=("linux-x64" "windows-x64" "macos-arm64")
required_platforms_overridden=0
channel="stable"
manifest_version=""
repository=""
release_tag=""
published_base_url=""
published_artifact_url=""
published_manifest_url=""
channel_output_path="artifacts/sympp-runtime-artifacts.json"
dry_run=0

usage() {
  cat <<'USAGE'
Validates built sympp runtime artifacts before advancing a release channel.

Single-manifest mode remains available for PR/main validation. Release-channel
mode validates every required platform, verifies local SHA-256 values, and
writes one aggregate manifest with durable release asset URLs.

Usage:
  scripts/publish-sympp-runtime-artifact.sh --manifest <manifest.json> --dry-run
  scripts/publish-sympp-runtime-artifact.sh --manifest-dir <dir> --published-base-url <release-url> --release-tag <tag> [--channel stable]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      manifest_paths+=("${2:-}")
      shift 2
      ;;
    --manifest-dir)
      manifest_dir="${2:-}"
      shift 2
      ;;
    --required-platform)
      if [[ "$required_platforms_overridden" -eq 0 ]]; then
        required_platforms=()
        required_platforms_overridden=1
      fi
      required_platforms+=("${2:-}")
      shift 2
      ;;
    --channel)
      channel="${2:-}"
      shift 2
      ;;
    --manifest-version)
      manifest_version="${2:-}"
      shift 2
      ;;
    --repository)
      repository="${2:-}"
      shift 2
      ;;
    --release-tag)
      release_tag="${2:-}"
      shift 2
      ;;
    --published-base-url)
      published_base_url="${2:-}"
      shift 2
      ;;
    --published-artifact-url)
      published_artifact_url="${2:-}"
      shift 2
      ;;
    --published-manifest-url)
      published_manifest_url="${2:-}"
      shift 2
      ;;
    --channel-output)
      channel_output_path="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
python_bin="$(command -v python3 || command -v python || true)"
[[ -n "$python_bin" ]] || { echo "Required command was not found on PATH: python3 or python" >&2; exit 1; }

args=(
  "$channel"
  "$manifest_version"
  "$repository"
  "$release_tag"
  "$published_base_url"
  "$published_artifact_url"
  "$published_manifest_url"
  "$channel_output_path"
  "$repo_root"
  "$dry_run"
  "--required-platforms"
)
for platform in "${required_platforms[@]}"; do
  [[ -n "${platform// }" ]] && args+=("$platform")
done
args+=("--manifests")
for manifest_path in "${manifest_paths[@]}"; do
  [[ -n "${manifest_path// }" ]] && args+=("$manifest_path")
done
if [[ -n "${manifest_dir// }" ]]; then
  args+=("--manifest-dir" "$manifest_dir")
fi

"$python_bin" - "${args[@]}" <<'PY'
import datetime
import hashlib
import json
import os
import re
import sys
from urllib.parse import quote, urlparse

(
    channel,
    manifest_version,
    repository,
    release_tag,
    published_base_url,
    published_artifact_url,
    published_manifest_url,
    channel_output_path,
    repo_root,
    dry_run,
) = sys.argv[1:11]
dry_run = dry_run == "1"
rest = sys.argv[11:]

required_platforms = []
manifest_paths = []
i = 0
while i < len(rest):
    token = rest[i]
    if token == "--required-platforms":
        i += 1
        while i < len(rest) and not rest[i].startswith("--"):
            required_platforms.append(rest[i])
            i += 1
    elif token == "--manifests":
        i += 1
        while i < len(rest) and not rest[i].startswith("--"):
            manifest_paths.append(rest[i])
            i += 1
    elif token == "--manifest-dir":
        manifest_dir = rest[i + 1]
        manifest_paths.extend(
            os.path.join(manifest_dir, name)
            for name in sorted(os.listdir(manifest_dir))
            if name.endswith(".manifest.json")
        )
        i += 2
    else:
        raise SystemExit(f"Unknown internal argument: {token}")

def fail(message):
    raise SystemExit(message)

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def require_url(value, label):
    if not value.strip():
        fail(f"{label} is required for release-channel advancement.")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        fail(f"{label} must be an http(s) URL.")

def normalize_platform(platform):
    value = str(platform or "").strip().lower()
    parts = value.split("-")
    if len(parts) < 2:
        fail(f"Artifact manifest platform must look like '<os>-<arch>': {platform}")
    arch = {"x64": "x86_64", "x86_64": "x86_64", "amd64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}.get(parts[1], parts[1])
    abi = parts[2] if len(parts) >= 3 else ("msvc" if parts[0] == "windows" else None)
    return {"key": f"{parts[0]}-{parts[1]}", "os": parts[0], "arch": arch, "abi": abi}

def normalize_mcp_contract_fingerprint(value):
    value = str(value or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{64}", value):
        return value
    return ""

def resolve_mcp_contract_fingerprint(manifest):
    fingerprint = normalize_mcp_contract_fingerprint(manifest.get("mcp_contract_fingerprint"))
    if fingerprint:
        return fingerprint
    launcher_contract = manifest.get("launcher_contract") or {}
    for key in ("mcp_contract_fingerprint", "contract_fingerprint"):
        fingerprint = normalize_mcp_contract_fingerprint(launcher_contract.get(key))
        if fingerprint:
            return fingerprint
    fingerprint = normalize_mcp_contract_fingerprint(manifest.get("contract_fingerprint"))
    if fingerprint:
        return fingerprint
    return ""

def launcher_contract_with_fingerprint(manifest, fingerprint):
    launcher_contract = {
        key: value
        for key, value in dict(manifest.get("launcher_contract") or {}).items()
        if key not in {"workflow", "workflow_path"}
    }
    launcher_contract["mcp_contract_fingerprint"] = fingerprint
    launcher_contract["contract_fingerprint"] = fingerprint
    return launcher_contract

def resolve_plugin_identity(manifest, source_revision):
    plugin = require(manifest, "plugin", "Artifact manifest")
    name = str(require(plugin, "name", "Artifact manifest plugin")).strip()
    version = str(require(plugin, "version", "Artifact manifest plugin")).strip()
    if not name or not version:
        fail("Artifact manifest plugin must declare name and version.")
    identity = {"name": name, "version": version}
    if plugin.get("marketplace"):
        identity["marketplace"] = str(plugin.get("marketplace"))
    if "packages" in plugin:
        identity["packages"] = list(plugin.get("packages") or [])
    identity["source_revision"] = source_revision
    return identity

def plugin_identity_key(plugin):
    return "|".join(
        [
            str(plugin.get("marketplace", "")),
            str(plugin.get("name", "")),
            str(plugin.get("version", "")),
            ",".join(plugin.get("packages", [])),
        ]
    )

def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)

def require(obj, key, label):
    if not isinstance(obj, dict) or key not in obj:
        fail(f"{label} is missing required property '{key}'.")
    return obj[key]

def read_built_manifest(path):
    full_path = os.path.abspath(path)
    manifest = read_json(full_path)
    if require(manifest, "status", "Artifact manifest") != "built":
        fail(f"Artifact manifest status must be 'built': {full_path}")
    revision = str(require(manifest, "source_revision", "Artifact manifest"))
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        fail(f"Artifact manifest source_revision must be a 40-character SHA: {full_path}")
    platform = normalize_platform(require(manifest, "platform", "Artifact manifest"))
    artifact = require(manifest, "artifact", "Artifact manifest")
    artifact_file = str(require(artifact, "file", "Artifact manifest artifact"))
    expected_sha = str(require(artifact, "sha256", "Artifact manifest artifact")).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        fail(f"Artifact manifest artifact.sha256 must be a SHA256 hex digest: {full_path}")
    artifact_path = os.path.join(os.path.dirname(full_path), artifact_file)
    if not os.path.isfile(artifact_path):
        fail(f"Artifact package referenced by manifest is missing: {artifact_path}")
    actual_sha = sha256(artifact_path)
    if actual_sha != expected_sha:
        fail(f"Artifact package SHA256 mismatch for {artifact_path}. Expected {expected_sha}, got {actual_sha}.")
    dashboard = require(manifest, "dashboard", "Artifact manifest")
    dashboard_fingerprint = str(require(dashboard, "fingerprint", "Artifact manifest dashboard"))
    if not re.fullmatch(r"[0-9a-f]{64}", dashboard_fingerprint):
        fail(f"Artifact manifest dashboard.fingerprint must be a SHA256 hex digest: {full_path}")
    contract_fingerprint = resolve_mcp_contract_fingerprint(manifest)
    if not contract_fingerprint:
        fail(f"Artifact manifest must declare mcp_contract_fingerprint or contract_fingerprint: {full_path}")
    plugin_identity = resolve_plugin_identity(manifest, revision)
    return {
        "path": full_path,
        "manifest": manifest,
        "manifest_sha256": sha256(full_path),
        "revision": revision,
        "platform": platform,
        "artifact_path": os.path.abspath(artifact_path),
        "artifact_file": os.path.basename(artifact_path),
        "artifact_sha256": expected_sha,
        "artifact_size": os.path.getsize(artifact_path),
        "contract_fingerprint": contract_fingerprint,
        "launcher_contract": launcher_contract_with_fingerprint(manifest, contract_fingerprint),
        "plugin": plugin_identity,
        "plugin_key": plugin_identity_key(plugin_identity),
    }

def asset_url(base_url, filename):
    return base_url.rstrip("/") + "/" + quote(filename, safe="._-")

if not manifest_paths:
    fail("At least one artifact manifest is required.")

records = [read_built_manifest(path) for path in dict.fromkeys(manifest_paths)]

if len(records) == 1 and not published_base_url.strip():
    record = records[0]
    if dry_run:
        print(f"Dry run: validated {record['path']} and {record['artifact_path']} for channel '{channel}'.")
        raise SystemExit(0)
    require_url(published_artifact_url, "published-artifact-url")
    require_url(published_manifest_url, "published-manifest-url")
    channel_doc = {
        "schema_version": 1,
        "channel": channel,
        "advanced_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_revision": record["revision"],
        "plugin": record["plugin"],
        "mcp_contract_fingerprint": record["contract_fingerprint"],
        "contract_fingerprint": record["contract_fingerprint"],
        "platform": record["platform"]["key"],
        "artifact": {
            "url": published_artifact_url,
            "sha256": record["artifact_sha256"],
            "size_bytes": record["artifact_size"],
            "mcp_contract_fingerprint": record["contract_fingerprint"],
            "contract_fingerprint": record["contract_fingerprint"],
        },
        "manifest": {
            "url": published_manifest_url,
            "sha256": record["manifest_sha256"],
        },
        "launcher_contract": record["launcher_contract"],
    }
    output_path = channel_output_path if os.path.isabs(channel_output_path) else os.path.join(repo_root, channel_output_path)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(channel_doc, handle, indent=2)
        handle.write("\n")
    print(f"Wrote release channel manifest {output_path}")
    raise SystemExit(0)

require_url(published_base_url, "published-base-url")
revisions = sorted({record["revision"] for record in records})
if len(revisions) != 1:
    fail(f"Release-channel artifacts must share one source revision; found {', '.join(revisions)}.")
source_revision = revisions[0]

records_by_platform = {}
for record in records:
    key = record["platform"]["key"]
    if key in records_by_platform:
        fail(f"Release-channel artifacts contain duplicate platform '{key}'.")
    records_by_platform[key] = record

required = [normalize_platform(platform)["key"] for platform in required_platforms if platform.strip()]
for platform in required:
    if platform not in records_by_platform:
        fail(f"Release-channel artifact is missing required platform '{platform}'.")

contract_fingerprints = sorted({record["contract_fingerprint"] for record in records})
if len(contract_fingerprints) != 1:
    fail(f"Release-channel artifacts must share one MCP contract fingerprint; found {', '.join(contract_fingerprints)}.")
contract_fingerprint = contract_fingerprints[0]
plugin_keys = sorted({record["plugin_key"] for record in records})
if len(plugin_keys) != 1:
    fail("Release-channel artifacts must share one plugin identity.")
plugin = dict(records[0]["plugin"])
plugin["source_revision"] = source_revision
manifest_version_value = manifest_version or release_tag or source_revision[:12]
artifacts = []
for record in sorted(records, key=lambda item: item["platform"]["key"]):
    platform = record["platform"]
    entrypoint = "start-runtime.ps1" if platform["os"] == "windows" else "start-runtime.sh"
    artifacts.append({
        "platform": {"os": platform["os"], "arch": platform["arch"], "abi": platform["abi"]},
        "source_revision": source_revision,
        "mcp_contract_fingerprint": contract_fingerprint,
        "contract_fingerprint": contract_fingerprint,
        "archive": {
            "url": asset_url(published_base_url, record["artifact_file"]),
            "sha256": record["artifact_sha256"],
            "size_bytes": record["artifact_size"],
        },
        "build_manifest": {
            "url": asset_url(published_base_url, os.path.basename(record["path"])),
            "sha256": record["manifest_sha256"],
        },
        "runtime": {
            "command": entrypoint,
            "args": [],
            "mcp_path": "/mcp",
            "health_path": "/health",
        },
        "backend": record["manifest"].get("backend"),
        "dashboard": {
            "asset_root": "dashboard-static",
            "entrypoint": "index.html",
            "fingerprint": record["manifest"]["dashboard"]["fingerprint"],
            "index": record["manifest"]["dashboard"].get("index"),
            "vite_manifest": record["manifest"]["dashboard"].get("vite_manifest"),
        },
        "fallback": {
            "developer_source_compile": "allowed_with_explicit_source_checkout",
            "installed_user_source_compile": "disabled_by_default",
        },
    })

aggregate = {
    "schema_version": 1,
    "plugin": plugin,
    "release": {
        "channel": channel,
        "manifest_version": manifest_version_value,
        "source_revision": source_revision,
        "repository": repository,
        "tag": release_tag,
        "published_base_url": published_base_url.rstrip("/"),
        "required_platforms": [
            {"os": normalize_platform(platform)["os"], "arch": normalize_platform(platform)["arch"], "abi": normalize_platform(platform)["abi"]}
            for platform in required
        ],
    },
    "source_revision": source_revision,
    "mcp_contract_fingerprint": contract_fingerprint,
    "contract_fingerprint": contract_fingerprint,
    "launcher_contract": {
        "manifest": "sympp-runtime-artifact",
        "version": 1,
        "mcp_contract_fingerprint": contract_fingerprint,
        "contract_fingerprint": contract_fingerprint,
    },
    "artifacts": artifacts,
}

output_path = channel_output_path if os.path.isabs(channel_output_path) else os.path.join(repo_root, channel_output_path)
os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(aggregate, handle, indent=2)
    handle.write("\n")
print(f"Wrote aggregate release channel manifest {output_path}")
PY
