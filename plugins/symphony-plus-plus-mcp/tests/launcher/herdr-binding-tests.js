"use strict";

const assert = require("assert/strict");
const path = require("path");
const { decodeHerdrBinding, herdrMetadataArgs } = require(path.resolve(__dirname, "../../scripts/start-sympp-mcp-bridge.js"));
const { locationFromEnvironment, withLocation, withSnapshot } = require(path.resolve(__dirname, "../../scripts/sympp-session-location.js"));

const encoded = Buffer.from(JSON.stringify({ role: "worker", work_package_id: "wp-test", show_inspector: false })).toString("base64url");
const binding = decodeHerdrBinding(encoded);
const args = herdrMetadataArgs(binding, "http://127.0.0.1:19998/");

assert.equal(decodeHerdrBinding("clear"), null);
assert.ok(args.includes("sympp_role=worker"));
assert.ok(args.includes("sympp_work_package_id=wp-test"));
assert.ok(args.includes("sympp_show_inspector=false"));
assert.ok(args.includes("sympp_endpoint=http://127.0.0.1:19998"));
assert.ok(args.includes("sympp_work_request_id"));

const first = locationFromEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t2", HERDR_PANE_ID: "w1:p3", HERDR_SOCKET_PATH: "private-selector" }, "Build-Desk", "client-a");
const second = locationFromEnvironment({ HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1" }, "Other-Desk", "client-b");
assert.equal(first.machine_id, "build-desk");
assert.equal(second.herdr.pane_id, "w2:p1");
assert.equal(first.herdr.pane_id, "w1:p3");
assert.equal(locationFromEnvironment({}, "Build-Desk", "client-c").herdr, undefined);
const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_context", arguments: {}, _meta: { another: true } } };
const forwarded = JSON.parse(withLocation(JSON.stringify(request), first));
assert.equal(forwarded.params._meta.another, true);
assert.deepEqual(forwarded.params.arguments, {});
assert.equal(forwarded.params._meta.sympp_session_location.client_id, "client-a");
const labeled = withSnapshot(first, { result: { snapshot: {
  panes: [{ pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", agent_session: { agent: "claude", kind: "id", value: "native-a" } }],
  workspaces: [{ workspace_id: "w1", label: "Widget Service" }], tabs: [{ tab_id: "w1:t2", label: "Implementation" }],
} } });
assert.equal(labeled.herdr.workspace_label, "Widget Service");
assert.equal(labeled.herdr.tab_label, "Implementation");
assert.equal(labeled.herdr.native_session_id, "native-a");
const reused = withSnapshot(labeled, { result: { snapshot: {
  panes: [{ pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", agent_session: { agent: "codex", kind: "id", value: "unrelated-session" } }],
} } });
assert.equal(reused.herdr.native_session_id, "native-a");

process.stdout.write("Herdr binding adapter tests passed.\n");
