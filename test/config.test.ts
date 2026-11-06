import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureOwnerPassword, loadOwnerPassword } from "../src/config.ts";
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
