import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureOwnerPassword, loadConfig, loadOwnerPassword, writeStoredConfig } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

test("a blank CLOUDDEV_BASE_PASSWORD counts as unset", async () => {
  const home = await tempDir();
  const stored = ensureOwnerPassword(home);

  assert.equal(loadOwnerPassword(home, {}), stored);
  assert.equal(loadOwnerPassword(home, { CLOUDDEV_BASE_PASSWORD: "" }), stored);
  assert.equal(loadOwnerPassword(home, { CLOUDDEV_BASE_PASSWORD: "   " }), stored);
  assert.equal(loadOwnerPassword(home, { CLOUDDEV_BASE_PASSWORD: "from-the-environment-123" }), "from-the-environment-123");
  assert.throws(() => loadOwnerPassword(home, { CLOUDDEV_BASE_PASSWORD: "too-short" }), /16/);
});

test("no extra OAuth redirect hosts are allowed by default", async () => {
  const home = await tempDir();
  const env = { CLOUDDEV_BASE_HOME: home };

  writeStoredConfig(home, { allowedRoots: [home] });
  assert.deepEqual(loadConfig({}, env).allowedRedirectHosts, []);

  writeStoredConfig(home, { allowedRoots: [home], allowedRedirectHosts: ["example.com"] });
  assert.deepEqual(loadConfig({}, env).allowedRedirectHosts, ["example.com"]);
});

test("the WebUI port defaults to 7677, can be turned off, and must differ from the MCP port", async () => {
  const home = await tempDir();
  const env = { CLOUDDEV_BASE_HOME: home };

  writeStoredConfig(home, { allowedRoots: [home] });
  assert.equal(loadConfig({}, env).uiPort, 7677);
  assert.equal(loadConfig({ uiPort: 0 }, env).uiPort, 0);
  assert.equal(loadConfig({ port: 7677, uiPort: 0 }, env).port, 7677);
  assert.throws(() => loadConfig({ port: 8000, uiPort: 8000 }, env), /WebUI 端口不能和 MCP 端口相同/);

  writeStoredConfig(home, { allowedRoots: [home], uiPort: 9000 });
  assert.equal(loadConfig({}, env).uiPort, 9000);
});
