"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { remoteArguments, remoteWorktreeResponse } = require("../../scripts/sympp-session-location.js");

test("remote path requests become origin identities and qualified responses preserve launch data", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/example/service.git"]);
  const env = { SYMPP_SERVER_URL: "http://100.123.207.19:19998", SYMPP_SERVER_NAME: "jjdev" };
  const call = args => JSON.stringify({ method: "tools/call", params: { name: "create_work_request", arguments: args } });
  const input = call({ repo: root, repo_scopes: [{ repo: root }, { repo: "other/repo" }] });
  const converted = JSON.parse(await remoteArguments(input, env)).params.arguments;
  assert.equal(converted.repo, "https://github.com/example/service.git");
  assert.deepEqual(converted.repo_scopes, [{ repo: converted.repo }, { repo: "other/repo" }]);
  assert.equal(await remoteArguments(input, {}), input);
  const response = JSON.stringify({ result: { isError: false, structuredContent: { worktree: { path: "/srv/Code/.worktrees/service/fix" }, worker_launch: { workspace_path: "/srv/Code/.worktrees/service/fix" } }, content: [] } });
  const output = JSON.parse(remoteWorktreeResponse(response, env)).result;
  assert.equal(output.content[0].text, "worktree: jjdev:/srv/Code/.worktrees/service/fix");
  assert.equal(output.structuredContent.worker_launch.workspace_path, "/srv/Code/.worktrees/service/fix");
  assert.equal(remoteWorktreeResponse(response, {}), response);
});
