import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

const created: string[] = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temporary directory, removed when the test file finishes. */
export async function tempDir(prefix = "clouddev-base-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);

  return dir;
}

/** Create files from a { "relative/path": "content" } map. */
export async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}
