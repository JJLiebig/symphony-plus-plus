"""Exercise the workflow's retry decisions with a fake GitHub CLI (bash + jq)."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).resolve().parents[2] / '.github/workflows/sympp-runtime-artifact.yml'
PLAN = textwrap.dedent(WORKFLOW.read_text().split('      - name: Select required builds or missing macOS\n', 1)[1]
                       .split('        run: |\n', 1)[1].split('\n  build-runtime-artifact:', 1)[0])
SHA = 'a' * 40


class RetryPlanTest(unittest.TestCase):
    def plan(self, *, retry=True, branch='main', current=SHA, published=SHA, mac=False, available=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'gh').write_text('''#!/bin/bash
set -eu
if [ "$1" = api ]; then
  echo "$FAKE_CURRENT"
else
  [ "$FAKE_AVAILABLE" = True ] || exit 1
  mkdir -p channel
  cp "$FAKE_MANIFEST" "channel/sympp-runtime-artifacts-${FAKE_CHANNEL}.json"
fi
''')
            (root / 'gh').chmod(0o755)
            (root / 'manifest.json').write_text(json.dumps({
                'source_revision': published,
                'artifacts': [{'platform': {'os': 'macos', 'arch': 'aarch64'}}] if mac else [],
            }))
            output = root / 'output'
            output.touch()
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}',
                       GITHUB_OUTPUT=str(output), GITHUB_SHA=SHA, GITHUB_REF_NAME=branch,
                       GITHUB_REPOSITORY='example/repo', RETRY_MACOS=str(retry).lower(),
                       FAKE_CURRENT=current, FAKE_AVAILABLE=str(available),
                       FAKE_MANIFEST=str(root / 'manifest.json'),
                       FAKE_CHANNEL='stable')
            result = subprocess.run(['bash', '-eu', '-o', 'pipefail', '-c', PLAN],
                                    cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return dict(line.split('=', 1) for line in output.read_text().splitlines())

    def test_required_builds_never_wait_for_macos(self):
        result = self.plan(retry=False)
        self.assertEqual(result['build'], 'true')
        self.assertEqual([item['platform'] for item in json.loads(result['matrix'])['include']],
                         ['linux-x64', 'windows-x64'])

    def test_only_missing_current_macos_is_built_for_stable(self):
        for branch in ['main']:
            with self.subTest(branch=branch):
                result = self.plan(branch=branch)
                self.assertEqual(result['build'], 'true')
                self.assertEqual([item['platform'] for item in json.loads(result['matrix'])['include']],
                                 ['macos-arm64'])

    def test_no_build_when_current_or_not_ready(self):
        for args in [dict(mac=True), dict(current='b' * 40),
                     dict(published='b' * 40), dict(available=False)]:
            with self.subTest(args=args):
                self.assertEqual(self.plan(**args), {})

    def test_publication_uploads_only_rebuilt_platforms(self):
        upload = textwrap.dedent(WORKFLOW.read_text().split('      - name: Upload platform release assets\n', 1)[1]
                                .split('        run: |\n', 1)[1].split('      - name:', 1)[0])
        for retry, platforms in [(True, ['macos-arm64']), (False, ['linux-x64', 'windows-x64'])]:
            with self.subTest(retry=retry), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                assets = root / 'artifacts/sympp-runtime-release'
                assets.mkdir(parents=True)
                for platform in ['linux-x64', 'windows-x64', 'macos-arm64']:
                    for suffix in ['zip', 'manifest.json']:
                        (assets / f'sympp-runtime-{SHA}-{platform}.{suffix}').touch()
                (root / 'gh').write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$UPLOAD_ARGS"\n')
                (root / 'gh').chmod(0o755)
                env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}',
                           RELEASE_TAG='test-runtime', RETRY_MACOS=str(retry).lower(),
                           UPLOAD_ARGS=str(root / 'args'))
                subprocess.run(['bash', '-eu', '-o', 'pipefail', '-c', upload],
                               cwd=root, env=env, check=True)
                uploaded = (root / 'args').read_text().splitlines()[3:-1]
                expected = {f'artifacts/sympp-runtime-release/sympp-runtime-{SHA}-{platform}.{suffix}'
                            for platform in platforms for suffix in ['zip', 'manifest.json']}
                self.assertEqual(set(uploaded), expected)


if __name__ == '__main__':
    unittest.main()
