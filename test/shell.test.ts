import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/tools/shell.ts";
import { resultText, tempDir } from "./helpers.ts";

test("commands do not inherit the server's Owner password variable", async () => {
  const root = await tempDir();
  const previous = process.env.CLOUDDEV_BASE_PASSWORD;
  process.env.CLOUDDEV_BASE_PASSWORD = "not-for-commands-0123456789";
  process.env.CLOUDDEV_BASE_TEST_VISIBLE = "visible";

  try {
    const result = await runCommand("printenv CLOUDDEV_BASE_PASSWORD || echo absent; printenv CLOUDDEV_BASE_TEST_VISIBLE", root);

    assert.equal(resultText(result), "absent\nvisible");
    assert.equal(process.env.CLOUDDEV_BASE_PASSWORD, "not-for-commands-0123456789", "the server's own environment is unchanged");
  } finally {
    if (previous === undefined) delete process.env.CLOUDDEV_BASE_PASSWORD;
    else process.env.CLOUDDEV_BASE_PASSWORD = previous;
    delete process.env.CLOUDDEV_BASE_TEST_VISIBLE;
  }
});
