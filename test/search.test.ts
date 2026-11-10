import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { MAX_BYTES, MAX_RESULT_CHARS } from "../src/tools/common.ts";
import { listFiles } from "../src/tools/file-list.ts";
import { readIndexPaths } from "../src/tools/git-index.ts";
import { configValue, isIgnored, parseIgnoreFile } from "../src/tools/gitignore.ts";
import { compileWildmatch } from "../src/tools/glob-match.ts";
import { activeSearchWorkers, compileGlob, glob, grep } from "../src/tools/search.ts";
import { MAX_SEARCHED_FILE_BYTES, runGlob, runGrep } from "../src/tools/search-worker.ts";
import { resultText, tempDir, writeTree } from "./helpers.ts";

// Keep the developer's own global Git ignore file out of these tests. Search
// workers copy process.env when they start, so this reaches them too.
const gitHome = await tempDir();
process.env.XDG_CONFIG_HOME = join(gitHome, "xdg");
process.env.GIT_CONFIG_GLOBAL = join(gitHome, "gitconfig");

/** A folder Git would treat as a repository, made without running git. */
async function makeRepo(root: string, files: Record<string, string | Buffer> = {}): Promise<void> {
  await writeTree(root, { ".git/HEAD": "ref: refs/heads/main\n", ...files });
}

async function globPaths(dir: string, root: string, pattern = "*"): Promise<string[]> {
  const text = resultText(await glob(dir, root, pattern, 2000));

  return text === "No files found." ? [] : text.split("\n");
}

/** A version 2 Git index (SHA-1) listing `entries`, as `git add` would write it. */
function gitIndex(entries: Array<{ path: string; mode: number }>): Buffer {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);

  const records = entries.map(({ path, mode }) => {
    const name = Buffer.from(path);
    const record = Buffer.alloc((62 + name.length + 8) & ~7); // stat data, hash, flags, name, NUL padding
    record.writeUInt32BE(mode, 24);
    record.writeUInt16BE(Math.min(name.length, 0xfff), 60);
    name.copy(record, 62);

    return record;
  });

  return Buffer.concat([header, ...records, Buffer.alloc(20)]);
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Whether bash can run what grep advises for a big UTF-16 file. (`iconv --version` fails on macOS; `-l` works.) */
function hasIconv(): boolean {
  if (process.platform === "win32") return false;

  try {
    execFileSync("iconv", ["-l"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("compileGlob follows gitignore-style matching", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*.ts", "a.ts", true],
    ["*.ts", "src/deep/a.ts", true],
    ["*.ts", "a.tsx", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["**/*.test.ts", "a.test.ts", true],
    ["**/*.test.ts", "x/y/a.test.ts", true],
    ["src/**/*.{js,jsx}", "src/a/b.jsx", true],
    ["src/**/*.{js,jsx}", "src/b.js", true],
    ["src/**/*.{js,jsx}", "lib/b.js", false],
    ["file?.md", "file1.md", true],
    ["[!a]*.md", "b.md", true],
    ["[!a]*.md", "a.md", false],
    ["./docs/*.md", "docs/x.md", true],
    ["a+b(1).txt", "a+b(1).txt", true],
    ["{src,lib}/**", "lib/x/y.ts", true],
    ["{src,lib}/**", "test/x.ts", false],
    ["src/**.ts", "src/a/b.ts", true],
    ["[a-c]?.txt", "b1.txt", true],
    ["[a-c]?.txt", "d1.txt", false],
    ["*", "a/b", true],
    ["a*/b", "a/x/b", false],
  ];

  for (const [pattern, path, expected] of cases) {
    assert.equal(compileGlob(pattern)(path), expected, `${pattern} vs ${path}`);
  }
});

test("glob and .gitignore patterns cannot backtrack catastrophically", () => {
  const name = "a".repeat(200);
  const startedAt = performance.now();

  for (let i = 0; i < 200; i++) {
    assert.equal(compileGlob("*a*a*a*a*a*a*a*a*a*a*b")(name), false);
    assert.equal(compileGlob("**a**a**a**a**a**a**a**b")(`${name}/${name}`), false);
    assert.equal(compileWildmatch("*a*a*a*a*a*a*a*a*a*a*b")(name), false);
    assert.equal(compileWildmatch("**/a*a*a*a*a*a*a*b/**")(`${name}/${name}/x`), false);
  }

  assert.ok(performance.now() - startedAt < 2000, "matching should take linear time");
});

test("gitignore patterns follow Git's rules", () => {
  const rules = parseIgnoreFile([
    "# a comment",
    "*.log",
    "!keep.log",
    "/root-only",
    "build/",
    "doc/*.md",
    "**/temp",
    "logs/**",
    "a/**/b",
    "\\#hash",
    "\\!bang",
    "trailing   ",
    "space\\ ",
    "*.py[cod]",
    "[[:digit:]]*.tmp",
    "",
  ].join("\n"), "", false);

  const cases: Array<[string, boolean, boolean]> = [
    ["a.log", false, true],
    ["x/y/b.log", false, true],
    ["keep.log", false, false],
    ["x/keep.log", false, false],
    ["a.log.txt", false, false],
    ["root-only", false, true],
    ["src/root-only", false, false],
    ["build", true, true],
    ["src/build", true, true],
    ["build", false, false], // a file named build: "build/" is for folders only
    ["doc/a.md", false, true],
    ["doc/sub/a.md", false, false],
    ["x/doc/a.md", false, false],
    ["temp", true, true],
    ["a/b/temp", false, true],
    ["logs", true, false],
    ["logs/x/y", false, true],
    ["a/b", false, true],
    ["a/x/y/b", false, true],
    ["#hash", false, true],
    ["!bang", false, true],
    ["trailing", false, true],
    ["space ", false, true],
    ["space", false, false],
    ["x.pyc", false, true],
    ["x.py", false, false],
    ["7.tmp", false, true],
    ["x.tmp", false, false],
  ];

  for (const [path, isDir, expected] of cases) {
    assert.equal(isIgnored([rules], path, path.slice(path.lastIndexOf("/") + 1), isDir), expected, path);
  }

  // A deeper file wins over a shallower one, and is anchored to its own folder.
  const sub = parseIgnoreFile("!keep.txt\n/only-here\n", "sub", false);
  const top = parseIgnoreFile("*.txt\n", "", false);
  assert.equal(isIgnored([top, sub], "sub/keep.txt", "keep.txt", false), false);
  assert.equal(isIgnored([top, sub], "sub/other.txt", "other.txt", false), true);
  assert.equal(isIgnored([top], "keep.txt", "keep.txt", false), true);
  assert.equal(isIgnored([top, sub], "sub/only-here", "only-here", false), true);
  assert.equal(isIgnored([top, sub], "sub/x/only-here", "only-here", false), false);

  // Case-insensitive file systems compare lower-cased text.
  assert.equal(isIgnored([parseIgnoreFile("*.LOG\n", "", true)], "a.log", "a.log", false), true);
  assert.equal(isIgnored([parseIgnoreFile("*.LOG\n", "", false)], "a.log", "a.log", false), false);
});

test("configValue reads core.excludesFile from Git config text", () => {
  const config = [
    "[user]",
    "  excludesfile = /not/this",
    "[core]",
    "\tautocrlf = input",
    "\texcludesFile = \"~/my ignore\" # comment",
    "[core \"sub\"]",
    "  excludesfile = /nor/this",
  ].join("\n");

  assert.equal(configValue(config, "core", "excludesfile"), "~/my ignore");
  assert.equal(configValue("[core]\nexcludesfile = /a/b ; note\n", "core", "excludesfile"), "/a/b");
  assert.equal(configValue("[core]\nautocrlf = true\n", "core", "excludesfile"), undefined);
});

test("grep and glob search a plain folder and skip dependency folders", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, {
    "src/app.ts": "import x from 'y';\nexport function main() {}\n// TODO: tidy\n",
    "src/util.js": "export const todo = 1;\n",
    "README.md": "Run main() to start\n",
    "node_modules/dep/index.js": "function main() {}\n",
    "logo.bin": Buffer.from([0, 1, 2, 109, 97, 105, 110]),
  });

  // logo.bin holds "main" too, but binary files are not searched, only counted.
  const all = resultText(await grep(root, root, { pattern: "main", maxResults: 100 }));
  assert.equal(all, "[Not searched: 1 binary file.]\n\nREADME.md:1:Run main() to start\nsrc/app.ts:2:export function main() {}");

  const ts = resultText(await grep(root, root, { pattern: "todo", ignoreCase: true, glob: "*.ts", maxResults: 100 }));
  assert.equal(ts, "src/app.ts:3:// TODO: tidy");

  const files = resultText(await grep(join(root, "src"), root, { pattern: "todo", ignoreCase: true, filesOnly: true, maxResults: 100 }));
  assert.equal(files, "src/app.ts\nsrc/util.js");

  const limited = resultText(await grep(root, root, { pattern: ".", maxResults: 2 }));
  assert.match(limited, /\[Stopped after 2 results/);

  assert.equal(resultText(await grep(root, root, { pattern: "nothing-here", maxResults: 10 })), "No matches found. Not searched: 1 binary file.");
  assert.equal(resultText(await grep(join(root, "src"), root, { pattern: "nothing-here", maxResults: 10 })), "No matches found.");
  await assert.rejects(grep(root, root, { pattern: "(", maxResults: 10 }), /Invalid regular expression/);
  await assert.rejects(grep(join(root, "nope"), root, { pattern: "x", maxResults: 10 }), /^Error: Path not found: nope$/);
  await assert.rejects(glob(join(root, "nope"), root, "*", 10), /^Error: Path not found: nope$/);
  await assert.rejects(glob(join(root, "README.md"), root, "*", 10), /glob path must be a folder/);

  assert.equal(resultText(await glob(root, root, "*.{ts,js}", 200)), "src/app.ts\nsrc/util.js");
  assert.equal(resultText(await glob(join(root, "src"), root, "*.ts", 200)), "src/app.ts");
  assert.equal(resultText(await glob(root, root, "*.py", 200)), "No files found.");
  assert.equal(resultText(await glob(root, root, "*", 2)), "[Showing 2 of 4 files. Use a more specific pattern or path.]\n\nREADME.md\nlogo.bin");

  // A single file can be searched directly.
  assert.equal(resultText(await grep(join(root, "src/app.ts"), root, { pattern: "TODO", maxResults: 10 })), "src/app.ts:3:// TODO: tidy");
});

test("grep and glob honour .gitignore files, info/exclude and the global excludes file", async () => {
  const root = await realpath(await tempDir());
  await makeRepo(root, {
    ".git/info/exclude": "secret-notes.txt\n",
    ".git/config": "[core]\n\tbare = false\n",
    ".gitignore": "generated/\n*.log\n!important.log\n",
    "src/.gitignore": "/local.txt\n",
    "tracked.txt": "needle tracked\n",
    "untracked.txt": "needle untracked\n",
    "generated/out.txt": "needle generated\n",
    "debug.log": "needle log\n",
    "important.log": "needle important\n",
    "secret-notes.txt": "needle secret\n",
    "src/local.txt": "needle src-local\n",
    "local.txt": "needle root-local\n",
    "src/.DS_Store": "needle global\n",
  });
  await writeTree(gitHome, { "xdg/git/ignore": ".DS_Store\n" });

  assert.deepEqual(await globPaths(root, root), [
    ".gitignore", "important.log", "local.txt", "src/.gitignore", "tracked.txt", "untracked.txt",
  ]);
  assert.equal(
    resultText(await grep(root, root, { pattern: "needle", maxResults: 100 })),
    "important.log:1:needle important\nlocal.txt:1:needle root-local\ntracked.txt:1:needle tracked\nuntracked.txt:1:needle untracked",
  );

  // Searching a subfolder still applies the .gitignore files above it.
  await writeTree(root, { "generated/deep/x.log": "x", "src/a.log": "needle a\n", "src/b.txt": "needle b\n" });
  assert.deepEqual(await globPaths(join(root, "src"), root), ["src/.gitignore", "src/b.txt"]);

  // core.excludesFile in the user's own Git config replaces the default global file.
  await writeTree(gitHome, { gitconfig: "[core]\n\texcludesFile = ~/custom-ignore\n", "custom-ignore": "*.out\n" });
  await writeTree(root, { "custom.out": "x" });
  const savedHome = process.env.HOME;
  process.env.HOME = gitHome;

  try {
    const paths = await globPaths(root, root);
    assert.ok(!paths.includes("custom.out"), "the configured excludes file applies");
    assert.ok(paths.includes("src/.DS_Store"), "the default global file no longer does");
  } finally {
    process.env.HOME = savedHome;
    await writeFile(join(gitHome, "gitconfig"), "");
    await writeFile(join(gitHome, "xdg/git/ignore"), "");
  }
});

test("the Git index is read without git, and only for regular files", () => {
  const index = gitIndex([
    { path: "a.txt", mode: 0o100644 },
    { path: "bin/run", mode: 0o100755 },
    { path: "link", mode: 0o120000 },
    { path: "sub", mode: 0o160000 },
    { path: `deep/${"x".repeat(5000)}.txt`, mode: 0o100644 },
  ]);

  assert.deepEqual(readIndexPaths(index), ["a.txt", "bin/run", `deep/${"x".repeat(5000)}.txt`]);
  assert.equal(readIndexPaths(Buffer.from("not an index at all")), undefined);
  assert.equal(readIndexPaths(index.subarray(0, 100)), undefined);
});

test("files Git tracks are listed even when they match an ignore pattern", async () => {
  const root = await realpath(await tempDir());
  await makeRepo(root, {
    ".gitignore": "dist/\n*.log\n",
    "src/app.js": "needle app\n",
    "dist/action.js": "needle tracked bundle\n",
    "dist/tmp.js": "needle untracked bundle\n",
    "dist/sub/kept.js": "needle tracked deep\n",
    "release.log": "needle tracked log\n",
    "debug.log": "needle untracked log\n",
  });
  await writeFile(join(root, ".git/index"), gitIndex([
    { path: "dist/action.js", mode: 0o100644 },
    { path: "dist/gone.js", mode: 0o100644 }, // deleted from disk: never listed
    { path: "dist/sub/kept.js", mode: 0o100644 },
    { path: "release.log", mode: 0o100644 },
    { path: "src/app.js", mode: 0o100644 },
  ]));

  assert.deepEqual(await globPaths(root, root), [".gitignore", "dist/action.js", "dist/sub/kept.js", "release.log", "src/app.js"]);
  assert.equal(
    resultText(await grep(root, root, { pattern: "needle", filesOnly: true, maxResults: 100 })),
    "dist/action.js\ndist/sub/kept.js\nrelease.log\nsrc/app.js",
  );
});

test("tracked files are found in real repositories, including index v4 and SHA-256 ones", { skip: !hasGit() && "git is not installed" }, async (t) => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

  for (const variant of [[], ["--object-format=sha256"]]) {
    const root = await realpath(await tempDir());

    try {
      git(root, "init", "-q", ...variant);
    } catch {
      t.diagnostic(`git init ${variant.join(" ")} is not supported here`);
      continue;
    }

    await writeTree(root, { ".gitignore": "out/\n", "out/keep.js": "x", "out/skip.js": "x", "src/a.js": "x" });
    git(root, "add", "-f", "out/keep.js", "src/a.js");
    assert.deepEqual(await globPaths(root, root), [".gitignore", "out/keep.js", "src/a.js"], `git init ${variant.join(" ")}`);

    git(root, "update-index", "--index-version", "4");
    assert.deepEqual(await globPaths(root, root), [".gitignore", "out/keep.js", "src/a.js"], `index v4 ${variant.join(" ")}`);
  }
});

test("nested repositories and submodules are searched with their own rules", async () => {
  const root = await realpath(await tempDir());
  await makeRepo(root, {
    ".gitignore": "*.log\nvendor/\n",
    "main.txt": "needle main\n",
    "skipped.log": "needle skipped\n",
    // A nested repository: the outer *.log rule does not reach inside, its own *.tmp rule does.
    "libs/inner/.git/HEAD": "ref: refs/heads/main\n",
    "libs/inner/.gitignore": "*.tmp\n",
    "libs/inner/kept.log": "needle inner-log\n",
    "libs/inner/scratch.tmp": "needle inner-tmp\n",
    // A submodule: .git is a file pointing into the outer repository.
    "mods/sub/.git": "gitdir: ../../.git/modules/sub\n",
    ".git/modules/sub/HEAD": "ref: refs/heads/main\n",
    "mods/sub/.gitignore": "out/\n",
    "mods/sub/src/code.ts": "needle submodule\n",
    "mods/sub/out/bundle.js": "needle bundle\n",
    // A repository inside an ignored folder stays ignored.
    "vendor/dep/.git/HEAD": "ref: refs/heads/main\n",
    "vendor/dep/lib.txt": "needle vendor\n",
  });

  assert.deepEqual(await globPaths(root, root), [
    ".gitignore",
    "libs/inner/.gitignore",
    "libs/inner/kept.log",
    "main.txt",
    "mods/sub/.gitignore",
    "mods/sub/src/code.ts",
  ]);
  assert.equal(
    resultText(await grep(root, root, { pattern: "needle", filesOnly: true, maxResults: 100 })),
    "libs/inner/kept.log\nmain.txt\nmods/sub/src/code.ts",
  );

  // Starting inside the submodule uses the submodule's rules.
  assert.deepEqual(await globPaths(join(root, "mods/sub"), root), ["mods/sub/.gitignore", "mods/sub/src/code.ts"]);
});

test("only regular files inside the search root are returned; symlinks are never followed", { skip: process.platform === "win32" }, async () => {
  const root = await realpath(await tempDir());
  const outside = await realpath(await tempDir());
  await writeTree(outside, { "secret.txt": "needle outside\n" });
  await makeRepo(root, {
    "real.txt": "needle real\n",
    "sub/inner.txt": "needle inner\n",
    "folder.txt/file.md": "needle folder\n",
  });
  await symlink(join(root, "real.txt"), join(root, "link.txt"));
  await symlink(join(root, "sub"), join(root, "linkdir"));
  await symlink(outside, join(root, "out"));
  await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
  await symlink(join(root, "missing.txt"), join(root, "dangling.txt"));
  execFileSync("mkfifo", [join(root, "pipe.txt")]);
  // FIFOs where ignore files are read must not hang the search.
  execFileSync("mkfifo", [join(root, ".gitignore")]);
  execFileSync("mkfifo", [join(root, "sub", ".gitignore")]);

  assert.deepEqual(await globPaths(root, root), ["folder.txt/file.md", "real.txt", "sub/inner.txt"]);
  assert.deepEqual(await globPaths(join(root, "sub"), root), ["sub/inner.txt"]);
  assert.deepEqual(await globPaths(root, root, "*.txt"), ["real.txt", "sub/inner.txt"]);
  assert.equal(
    resultText(await grep(root, root, { pattern: "needle", maxResults: 100 })),
    "folder.txt/file.md:1:needle folder\nreal.txt:1:needle real\nsub/inner.txt:1:needle inner",
  );

  // The same holds outside repositories.
  const plain = await realpath(await tempDir());
  await writeTree(plain, { "a.txt": "needle a\n" });
  await symlink(outside, join(plain, "out"));
  await symlink(join(outside, "secret.txt"), join(plain, "b.txt"));
  execFileSync("mkfifo", [join(plain, "c.txt")]);
  assert.equal(resultText(await grep(plain, plain, { pattern: "needle", maxResults: 100 })), "a.txt:1:needle a");
  assert.deepEqual(await globPaths(plain, plain), ["a.txt"]);
});

test("a folder named in path is searched even when it is ignored", async () => {
  const root = await realpath(await tempDir());
  await makeRepo(root, {
    ".gitignore": "node_modules/\n**/cache/**\n",
    "app.js": "needle app\n",
    "node_modules/pkg/index.js": "needle index\n",
    "node_modules/pkg/dist/main.js": "needle dist\n",
    "node_modules/pkg/.gitignore": "*.map\n",
    "node_modules/pkg/dist/main.js.map": "needle map\n",
    "cache/data/x.txt": "needle cache\n",
  });

  assert.deepEqual(await globPaths(root, root), [".gitignore", "app.js"]);
  assert.deepEqual(await globPaths(join(root, "node_modules/pkg"), root), [
    "node_modules/pkg/.gitignore", "node_modules/pkg/dist/main.js", "node_modules/pkg/index.js",
  ]);
  assert.equal(
    resultText(await grep(join(root, "node_modules/pkg"), root, { pattern: "needle", filesOnly: true, maxResults: 100 })),
    "node_modules/pkg/dist/main.js\nnode_modules/pkg/index.js",
  );
  // "**/cache/**" ignores everything inside cache, but asking for cache/data searches it.
  assert.deepEqual(await globPaths(join(root, "cache/data"), root), ["cache/data/x.txt"]);

  // Outside repositories the default skip list gives way the same way.
  const plain = await realpath(await tempDir());
  await writeTree(plain, {
    "src/a.js": "x",
    "dist/out.js": "x",
    "node_modules/pkg/index.js": "x",
    "node_modules/pkg/dist/main.js": "x",
  });
  assert.deepEqual(await globPaths(plain, plain), ["src/a.js"]);
  assert.deepEqual(await globPaths(join(plain, "dist"), plain), ["dist/out.js"]);
  assert.deepEqual(await globPaths(join(plain, "node_modules/pkg"), plain), ["node_modules/pkg/dist/main.js", "node_modules/pkg/index.js"]);
});

test("search needs no git executable", async () => {
  const root = await realpath(await tempDir());
  const emptyBin = await tempDir();
  await makeRepo(root, { ".gitignore": "*.log\n", "a.txt": "needle\n", "b.log": "needle\n" });
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBin;

  try {
    assert.deepEqual(await globPaths(root, root), [".gitignore", "a.txt"]);
    assert.equal(resultText(await grep(root, root, { pattern: "needle", maxResults: 10 })), "a.txt:1:needle");
  } finally {
    process.env.PATH = savedPath;
  }
});

test("a runaway search is stopped at the time limit while the main thread stays responsive", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, { "a.txt": `${"a".repeat(40)}!\n` });

  let maxGap = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);

  const startedAt = performance.now();
  let result;

  try {
    result = await grep(root, root, { pattern: "^(a+)+$", maxResults: 10, timeoutMs: 500 });
  } finally {
    clearInterval(ticker);
  }

  const elapsed = performance.now() - startedAt;
  assert.equal(result.isError, true);
  assert.match(resultText(result), /^Search stopped after 0\.5 seconds: the pattern is too complex/);
  assert.ok(elapsed >= 450 && elapsed < 5000, `stopped after ${elapsed}ms`);
  assert.ok(maxGap < 250, `main thread stalled for ${maxGap}ms`);

  // The next search runs normally.
  assert.equal(resultText(await grep(root, root, { pattern: "a!", maxResults: 10 })), `a.txt:1:${"a".repeat(40)}!`);

  const slowGlob = await glob(root, root, "*", 10, 0);
  assert.equal(slowGlob.isError, true);
  assert.match(resultText(slowGlob), /^File search stopped after 0 seconds/);
});

test("parallel searches all complete", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, `line ${i}\n`])));

  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => grep(root, root, { pattern: `line ${i}$`, maxResults: 10 })));

  results.forEach((result, i) => assert.equal(resultText(result), `f${i}.txt:1:line ${i}`));
});

test("listFiles stops at the limit and reports it", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`d${i % 3}/f${i}.txt`, "x"])));

  const listing = listFiles(root, root, 5);
  assert.equal(listing.files.length, 5);
  assert.equal(listing.capped, true);
  assert.equal(listFiles(root).files.length, 12);
});

test("the compiled build starts its own worker file", async () => {
  // tsc rewrites import specifiers but not the worker's URL string; build the
  // search modules the way `npm run build` does and run a search with them.
  const outDir = await tempDir();
  const projectRoot = join(import.meta.dirname, "..");
  const configPath = join(projectRoot, "tsconfig.build.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, projectRoot);
  const program = ts.createProgram(
    [join(projectRoot, "src/tools/search.ts"), join(projectRoot, "src/tools/search-worker.ts")],
    { ...parsed.options, outDir },
  );
  const emitted = program.emit();
  assert.deepEqual(emitted.diagnostics, []);
  await writeFile(join(outDir, "package.json"), "{\"type\":\"module\"}\n");
  assert.match(await readFile(join(outDir, "tools/search-worker.js"), "utf8"), /from "\.\/file-list\.js"/);

  const built = await import(pathToFileURL(join(outDir, "tools/search.js")).href) as typeof import("../src/tools/search.ts");
  const root = await realpath(await tempDir());
  await makeRepo(root, { ".gitignore": "*.log\n", "a.ts": "needle\n", "b.log": "needle\n" });
  await mkdir(join(root, "empty"));

  assert.equal(resultText(await built.glob(root, root, "*", 10)), ".gitignore\na.ts");
  assert.equal(resultText(await built.grep(root, root, { pattern: "needle", maxResults: 10 })), "a.ts:1:needle");
});

/** Wait until `check` passes, failing after `timeoutMs`. */
async function eventually(what: string, check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const RUNAWAY = { pattern: "^(a+)+$", maxResults: 10 };

test("a search that hits the file limit says so even when nothing matched", async () => {
  const root = await realpath(await tempDir());
  // The walk is alphabetical, so with a limit of 3 the file holding the match is never reached.
  await writeTree(root, { "a1.txt": "x\n", "a2.txt": "x\n", "a3.txt": "x\n", "a4.txt": "x\n", "z-target.md": "needle\n" });

  assert.match(
    resultText(await grep(root, root, { pattern: "needle", maxResults: 10, fileLimit: 3 })),
    /^No matches in the first 3 files\. The search stops after 3 files, so the rest were not searched/,
  );
  assert.match(resultText(await glob(root, root, "*.md", 10, undefined, { fileLimit: 3 })), /^No files found in the first 3 files\./);

  // Without the limit both find it.
  assert.equal(resultText(await grep(root, root, { pattern: "needle", maxResults: 10 })), "z-target.md:1:needle");
  assert.equal(resultText(await glob(root, root, "*.md", 10)), "z-target.md");
});

test("a search stopped by its time limit really ends its worker thread", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, { "a.txt": `${"a".repeat(40)}!\n` });

  const result = await grep(root, root, { ...RUNAWAY, timeoutMs: 300 });

  assert.equal(result.isError, true);
  await eventually("the timed-out worker to exit", () => activeSearchWorkers() === 0);
});

test("cancelling a search stops it, whether it is running or still waiting for a slot", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, { "a.txt": `${"a".repeat(40)}!\n` });

  // Running: aborted long before its 10-second limit, and its worker ends.
  const running = new AbortController();
  setTimeout(() => running.abort(), 100);
  let startedAt = performance.now();
  const cancelled = await grep(root, root, { ...RUNAWAY, timeoutMs: 10_000, signal: running.signal });

  assert.match(resultText(cancelled), /^Search was cancelled\./);
  assert.ok(performance.now() - startedAt < 3000, "a cancelled search must stop at once");
  await eventually("the cancelled worker to exit", () => activeSearchWorkers() === 0);

  // Waiting: four runaway searches hold every slot; a fifth is cancelled while it waits for one.
  const blockers = Array.from({ length: 4 }, () => grep(root, root, { ...RUNAWAY, timeoutMs: 1500 }));
  await eventually("the four searches to start", () => activeSearchWorkers() === 4);
  const waiting = new AbortController();
  setTimeout(() => waiting.abort(), 100);
  startedAt = performance.now();
  const queued = await glob(root, root, "*", 10, undefined, { signal: waiting.signal });

  assert.match(resultText(queued), /^Search was cancelled\./);
  assert.ok(performance.now() - startedAt < 1000, "a cancelled search must not wait for a slot");

  for (const blocked of await Promise.all(blockers)) assert.equal(blocked.isError, true);
  await eventually("all workers to exit", () => activeSearchWorkers() === 0);

  // The slots were all given back.
  assert.equal(resultText(await grep(root, root, { pattern: "a!", maxResults: 10 })), `a.txt:1:${"a".repeat(40)}!`);
});

/** A version 4 Git index: each path is stored as "drop N bytes of the previous path, then append a suffix". */
function gitIndexV4(paths: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(4, 4);
  header.writeUInt32BE(paths.length, 8);
  let previous = "";

  const records = paths.map((path) => {
    let common = 0;

    while (common < previous.length && common < path.length && previous[common] === path[common]) common++;

    const strip = previous.length - common;
    assert.ok(strip < 128, "this helper writes single-byte varints only");
    const fixed = Buffer.alloc(62); // stat data, SHA-1, flags
    fixed.writeUInt32BE(0o100644, 24);
    fixed.writeUInt16BE(Math.min(path.length, 0xfff), 60);
    previous = path;

    return Buffer.concat([fixed, Buffer.from([strip]), Buffer.from(path.slice(common)), Buffer.from([0])]);
  });

  return Buffer.concat([header, ...records, Buffer.alloc(20)]);
}

test("index v4 paths that share a prefix with the previous entry are decoded", () => {
  const paths = ["src/a.ts", "src/ab.ts", "src/b/c.ts", "src/b/d.ts", "zz.txt"];

  assert.deepEqual(readIndexPaths(gitIndexV4(paths)), paths);
});

test("a search path swapped for a symlink is refused, and results never leave the workspace", { skip: process.platform === "win32" }, async () => {
  const workspace = await realpath(await tempDir());
  const outside = await realpath(await tempDir());
  await writeTree(workspace, { "sub/inside.txt": "marker\n" });
  await writeTree(outside, { "elsewhere.txt": "marker\n" });
  const sub = join(workspace, "sub");

  // The main thread resolved `sub` to itself; before the worker starts, it becomes a link to a folder outside.
  await rm(sub, { recursive: true });
  await symlink(outside, sub);

  const grepRequest = { op: "grep" as const, target: sub, isFile: false, displayRoot: workspace, pattern: "marker", ignoreCase: false, filesOnly: false, maxResults: 10, fileLimit: 1000 };
  const globRequest = { op: "glob" as const, dir: sub, displayRoot: workspace, pattern: "*", maxResults: 10, fileLimit: 1000 };

  assert.throws(() => runGrep({ ...grepRequest, expectedRealTarget: sub }), /changed while the search was starting/);
  assert.throws(() => runGlob({ ...globRequest, expectedRealDir: sub }), /changed while the search was starting/);

  // Even if the swap happened before the main thread looked, the workspace root bounds every result.
  assert.deepEqual(runGrep({ ...grepRequest, expectedRealTarget: outside }).lines, []);
  assert.deepEqual(runGlob({ ...globRequest, expectedRealDir: outside }).paths, []);
});

// Root reads files whatever their permissions, and Windows has no chmod: tests of unreadable files need neither.
const permissionsBind = process.platform !== "win32" && process.getuid?.() !== 0;

/** A file of about 2.2MB, over grep's 2MB limit, whose last line is `last`. */
function overTwoMegabytes(last: string): string {
  return `${"filler line\n".repeat(190_000)}${last}\n`;
}

const MB = 1024 * 1024;

/**
 * A file of `size` bytes that starts with `start`; the rest reads as NUL bytes and takes no disk space on most file
 * systems. Over grep's limit only the start is looked at, to tell binary files from text.
 */
async function sparseFile(path: string, start: string | Buffer, size: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, start);
  await truncate(path, size);
}

/** Text longer than the part of a big file that is looked at, so its sparse rest does not count. */
const TEXT_START = "GET /api/items 200 12ms\n".repeat(400);

test("a file named on its own that is not searched gets an error saying why", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, {
    "server.log": overTwoMegabytes("ERROR: disk full"),
    "edge.log": `${"x".repeat(2 * MB)}\n`,
    // As Windows tools write logs: UTF-16 with a byte-order mark.
    "win16.log": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(overTwoMegabytes("ERROR: disk full"), "utf16le")]),
    "logo.bin": Buffer.from([0, 1, 2, ...Buffer.from("ERROR")]),
    // UTF-32's byte-order mark starts like UTF-16LE's; it is not taken for one.
    "wide.txt": Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from("E\0\0\0R\0\0\0")]),
    "secret.txt": "ERROR\n",
  });
  await sparseFile(join(root, "big dump.log"), TEXT_START, 12 * MB);
  await sparseFile(join(root, "dump 16.log"), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(TEXT_START, "utf16le").swap16()]), 12 * MB);
  const search = (path: string) => grep(join(root, path), root, { pattern: "ERROR", maxResults: 10 });

  // bash comes first: it can search the file. read can page through it, but only up to its own 10MB limit.
  const big = await search("server.log");
  assert.equal(big.isError, true);
  assert.equal(
    resultText(big),
    "server.log is 2.2MB, over grep's 2MB limit, so it was not searched. " +
      "Search it in bash: grep -n 'PATTERN' server.log | head -50, or rg. read with offset/limit can show parts of it.",
  );
  assert.equal(
    resultText(await search("big dump.log")),
    "big dump.log is 12.0MB, over grep's 2MB limit, so it was not searched. " +
      "Search it in bash: grep -n 'PATTERN' 'big dump.log' | head -50, or rg. It is over read's 10MB limit as well: tail or sed -n in bash can show parts of it.",
  );
  // A size that rounds to the limit comes with its byte count.
  assert.match(resultText(await search("edge.log")), /^edge\.log is 2\.0MB \(2,097,153 bytes\), over grep's 2MB limit,/);

  // grep in bash matches bytes and finds nothing in UTF-16 text: for such a file the advice decodes it first. read
  // shows UTF-16 decoded, so it is still offered up to its limit; past it, tail and sed -n get iconv's output too.
  const win16 = resultText(await search("win16.log"));
  assert.equal(
    win16,
    "win16.log is 4.3MB, over grep's 2MB limit, so it was not searched. " +
      "It is UTF-16: search it in bash with iconv -f UTF-16LE -t UTF-8 win16.log | grep -n 'PATTERN' | head -50. read with offset/limit can show parts of it.",
  );
  assert.equal(
    resultText(await search("dump 16.log")),
    "dump 16.log is 12.0MB, over grep's 2MB limit, so it was not searched. " +
      "It is UTF-16: search it in bash with iconv -f UTF-16BE -t UTF-8 'dump 16.log' | grep -n 'PATTERN' | head -50. " +
      "It is over read's 10MB limit as well: iconv piped to tail or sed -n in bash can show parts of it.",
  );

  // The command advised finds the line, with the file's own line number.
  if (hasIconv()) {
    const advised = /search it in bash with (.+ \| head -50)\./.exec(win16)![1]!.replace("PATTERN", "ERROR: disk");
    assert.equal(execFileSync("/bin/sh", ["-c", advised], { cwd: root, encoding: "utf8" }), "190001:ERROR: disk full\n");
  }

  const binary = await search("logo.bin");
  assert.equal(binary.isError, true);
  assert.match(resultText(binary), /^logo\.bin looks like a binary file \(it has a NUL byte near the start\), so it was not searched\./);
  assert.match(resultText(await search("wide.txt")), /^wide\.txt looks like a binary file/);

  if (process.platform !== "win32") {
    execFileSync("mkfifo", [join(root, "pipe")]);
    const pipe = await search("pipe");
    assert.equal(pipe.isError, true);
    assert.equal(resultText(pipe), "pipe is not a regular file, so it was not searched.");
  }

  if (permissionsBind) {
    try {
      await chmod(join(root, "secret.txt"), 0o000);
      const unreadable = await search("secret.txt");
      assert.equal(unreadable.isError, true);
      assert.equal(resultText(unreadable), "secret.txt could not be read (permission denied), so it was not searched.");
    } finally {
      await chmod(join(root, "secret.txt"), 0o644);
    }
  }
});

test("a folder search names what it could not search, also when nothing matched", { skip: !permissionsBind && "file permissions do not bind here" }, async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, {
    "a.txt": "needle here\n",
    "logs/1.log": overTwoMegabytes("needle"),
    "logs/2.log": overTwoMegabytes("needle"),
    "logs/3.log": overTwoMegabytes("needle"),
    "logs/4.log": overTwoMegabytes("needle"),
    "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, ...Buffer.from("needle")]),
    "locked/inside.txt": "needle\n",
    "noexec/inside.txt": "needle\n",
    "secret.txt": "needle\n",
  });

  try {
    await chmod(join(root, "locked"), 0o000);
    await chmod(join(root, "noexec"), 0o444); // its names can be listed, but its files cannot be opened
    await chmod(join(root, "secret.txt"), 0o000);

    const skipped ="Not searched: 4 files over 2MB (logs/1.log, logs/2.log, logs/3.log and 1 more), 1 binary file, " +
      "2 unreadable files (noexec/inside.txt, secret.txt), 1 unreadable folder (locked/).";

    assert.equal(resultText(await grep(root, root, { pattern: "needle", maxResults: 10 })), `[${skipped}]\n\na.txt:1:needle here`);
    assert.equal(resultText(await grep(root, root, { pattern: "absent", maxResults: 10 })), `No matches found. ${skipped}`);

    // Only files the glob selects count; an unreadable folder may hold some.
    assert.equal(
      resultText(await grep(root, root, { pattern: "absent", glob: "*.log", maxResults: 10 })),
      "No matches found. Not searched: 4 files over 2MB (logs/1.log, logs/2.log, logs/3.log and 1 more), 1 unreadable folder (locked/).",
    );

    // An unreadable folder named on its own.
    assert.equal(
      resultText(await grep(join(root, "locked"), root, { pattern: "needle", maxResults: 10 })),
      "No matches found. Not searched: 1 unreadable folder (locked/).",
    );

    // glob cannot see into an unreadable folder either.
    assert.equal(resultText(await glob(root, root, "a.*", 100)), "[Not searched: 1 unreadable folder (locked/).]\n\na.txt");
    assert.equal(resultText(await glob(root, root, "*.md", 100)), "No files found. Not searched: 1 unreadable folder (locked/).");

    // The listing goes on past the unreadable folder.
    const listing = listFiles(root);
    assert.deepEqual(listing.unreadable, ["locked"]);
    assert.ok(listing.files.includes("secret.txt") && listing.files.includes("logs/4.log"));
  } finally {
    await chmod(join(root, "locked"), 0o755);
    await chmod(join(root, "noexec"), 0o755);
    await chmod(join(root, "secret.txt"), 0o644);
  }

  // Readable again: nothing is reported.
  assert.equal(
    resultText(await grep(root, root, { pattern: "needle", glob: "*.txt", maxResults: 10 })),
    "a.txt:1:needle here\nlocked/inside.txt:1:needle\nnoexec/inside.txt:1:needle\nsecret.txt:1:needle",
  );
});

test("skipped files and folders outside the workspace are not reported", { skip: !permissionsBind && "file permissions do not bind here" }, async () => {
  const workspace = await realpath(await tempDir());
  const outside = await realpath(await tempDir());
  await writeTree(workspace, { "sub/inside.txt": "marker\n" });
  await writeTree(outside, { "big.log": overTwoMegabytes("marker"), "locked/x.txt": "marker\n", "secret.txt": "marker\n" });
  const sub = join(workspace, "sub");

  // As above: `sub` becomes a link to a folder outside before the worker starts.
  await rm(sub, { recursive: true });
  await symlink(outside, sub);

  try {
    await chmod(join(outside, "locked"), 0o000);
    await chmod(join(outside, "secret.txt"), 0o000);

    const grepped = runGrep({
      op: "grep", target: sub, expectedRealTarget: outside, isFile: false, displayRoot: workspace,
      pattern: "marker", ignoreCase: false, filesOnly: false, maxResults: 10, fileLimit: 1000,
    });
    const globbed = runGlob({ op: "glob", dir: sub, expectedRealDir: outside, displayRoot: workspace, pattern: "*", maxResults: 10, fileLimit: 1000 });

    assert.deepEqual(grepped.lines, []);
    assert.equal(grepped.skipped.tooLarge.count, 0);
    assert.equal(grepped.skipped.unreadableFiles.count, 0);
    assert.equal(grepped.skipped.unreadableFolders.count, 0);
    assert.equal(globbed.unreadableFolders.count, 0);
  } finally {
    await chmod(join(outside, "locked"), 0o755);
    await chmod(join(outside, "secret.txt"), 0o644);
  }
});

test("big binary files are counted with the binary files, so the big files named are those that may hold text", async () => {
  const root = await realpath(await tempDir());
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

  // Media sorts before the logs. Named among the big files, it would push the log into "and 3 more".
  for (const name of ["assets/a.png", "assets/b.mp4", "assets/c.woff2", "assets/d.zip"]) await sparseFile(join(root, name), png, 3 * MB);
  await sparseFile(join(root, "logs/dev.log"), TEXT_START, 3 * MB);
  // A UTF-16 log has NUL bytes as well, but it is text.
  await sparseFile(join(root, "logs/win.log"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT_START, "utf16le")]), 3 * MB);
  await writeTree(root, { "small.png": png });

  assert.equal(
    resultText(await grep(root, root, { pattern: "needle", maxResults: 10 })),
    "No matches found. Not searched: 2 files over 2MB (logs/dev.log, logs/win.log), 5 binary files.",
  );

  // Named on its own, a big binary file gets the answer for binary files.
  const named = await grep(join(root, "assets/b.mp4"), root, { pattern: "needle", maxResults: 10 });
  assert.equal(named.isError, true);
  assert.equal(
    resultText(named),
    "assets/b.mp4 looks like a binary file (it has a NUL byte near the start), so it was not searched. To search it anyway, use grep -a in bash.",
  );

  // Of a big file, its size reaches the main thread, not the bytes read to classify it; of a UTF-16 one, also its
  // encoding, which the advice on searching it depends on.
  const notSearched = (path: string) => runGrep({
    op: "grep", target: join(root, path), expectedRealTarget: join(root, path), isFile: true, displayRoot: root,
    pattern: "needle", ignoreCase: false, filesOnly: false, maxResults: 10, fileLimit: 1000,
  }).notSearched;
  assert.deepEqual(notSearched("logs/dev.log"), { reason: "too-large", size: 3 * MB });
  assert.deepEqual(notSearched("logs/win.log"), { reason: "too-large", size: 3 * MB, utf16: "utf-16le" });
});

test("a folder that can be listed but not entered is reported, with the files and folders listed in it", { skip: !permissionsBind && "file permissions do not bind here" }, async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, {
    "a.txt": "needle\n",
    "docs/readme.md": "needle\n",
    "docs/private/notes.txt": "needle\n",
    "docs/private/drafts/x.txt": "needle\n",
    "shared/notes.txt": "needle\n",
    "shared/sub/deep.txt": "needle\n",
  });

  try {
    // As chmod -R 644 leaves them: their names can be listed (r), but nothing in them opened or entered (no x).
    await chmod(join(root, "shared"), 0o644);
    await chmod(join(root, "docs/private"), 0o644); // inside a normal folder

    const skipped = "Not searched: 2 unreadable files (docs/private/notes.txt, shared/notes.txt), " +
      "2 unreadable folders (docs/private/drafts/, shared/sub/).";

    assert.equal(resultText(await grep(root, root, { pattern: "needle", maxResults: 10 })), `[${skipped}]\n\na.txt:1:needle\ndocs/readme.md:1:needle`);
    assert.equal(resultText(await grep(root, root, { pattern: "absent", maxResults: 10 })), `No matches found. ${skipped}`);
    assert.equal(
      resultText(await grep(join(root, "shared"), root, { pattern: "needle", maxResults: 10 })),
      "No matches found. Not searched: 1 unreadable file (shared/notes.txt), 1 unreadable folder (shared/sub/).",
    );

    // glob names the files it found but could not check, and does not count them among the results.
    assert.equal(resultText(await glob(root, root, "*.txt", 100)), `[${skipped}]\n\na.txt`);
    assert.equal(resultText(await glob(root, root, "notes.*", 100)), `No files found. ${skipped}`);
    assert.equal(
      resultText(await glob(root, root, "*.md", 100)),
      "[Not searched: 2 unreadable folders (docs/private/drafts/, shared/sub/).]\n\ndocs/readme.md",
    );
  } finally {
    await chmod(join(root, "shared"), 0o755);
    await chmod(join(root, "docs/private"), 0o755);
  }
});

test("a folder full of skipped files is resolved once, not once per file", async (t) => {
  const root = await realpath(await tempDir());
  const count = 12;

  for (let i = 0; i < count; i++) {
    await sparseFile(join(root, `logs/${String(i).padStart(2, "0")}.log`), TEXT_START, MAX_SEARCHED_FILE_BYTES + 1);
  }
  await writeTree(root, { "a.txt": "needle\n" });

  const realpaths = t.mock.method(fs.realpathSync, "native");
  const reply = runGrep({
    op: "grep", target: root, expectedRealTarget: root, isFile: false, displayRoot: root,
    pattern: "needle", ignoreCase: false, filesOnly: false, maxResults: 10, fileLimit: 1000,
  });
  const calls = realpaths.mock.callCount();
  realpaths.mock.restore();

  assert.deepEqual(reply.lines, ["a.txt:1:needle"]);
  assert.equal(reply.skipped.tooLarge.count, count);
  assert.ok(calls < count, `${calls} realpath calls for ${count} skipped files in one folder`);
});

test("files with a byte-order mark are searched without it: UTF-16, with line numbers as for UTF-8, and UTF-8", async () => {
  const root = await realpath(await tempDir());
  const text = "first line\r\npassword = hunter2\r\nlast line\r\n";
  await writeTree(root, {
    "le.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
    "be.txt": Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]),
    // As Visual Studio saves C# files, and Excel CSV exports.
    "utf8.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    // NUL bytes and no byte-order mark: binary.
    "no-mark.txt": Buffer.from(text, "utf16le"),
  });

  assert.equal(resultText(await grep(join(root, "le.txt"), root, { pattern: "password", maxResults: 10 })), "le.txt:2:password = hunter2");
  assert.equal(resultText(await grep(join(root, "be.txt"), root, { pattern: "password", maxResults: 10 })), "be.txt:2:password = hunter2");
  assert.equal(
    resultText(await grep(root, root, { pattern: "hunter2$", maxResults: 10 })),
    "[Not searched: 1 binary file.]\n\nbe.txt:2:password = hunter2\nle.txt:2:password = hunter2\nutf8.txt:2:password = hunter2",
  );
  // The mark is not part of the first line: ^ matches there, and the line is shown without it.
  assert.equal(
    resultText(await grep(root, root, { pattern: "^first", filesOnly: true, maxResults: 10 })),
    "[Not searched: 1 binary file.]\n\nbe.txt\nle.txt\nutf8.txt",
  );
  assert.equal(resultText(await grep(join(root, "utf8.txt"), root, { pattern: "^first", maxResults: 10 })), "utf8.txt:1:first line");
});

test("a final newline adds no empty line past the end of the file", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, { "blank.txt": "a\n\nb\n", "crlf.txt": "a\r\n\r\nb\r\n", "open.txt": "a\n\nb", "empty.txt": "" });

  assert.equal(resultText(await grep(join(root, "blank.txt"), root, { pattern: "^$", maxResults: 10 })), "blank.txt:2:");
  assert.equal(resultText(await grep(join(root, "blank.txt"), root, { pattern: "^\\s*$", maxResults: 10 })), "blank.txt:2:");
  assert.equal(resultText(await grep(root, root, { pattern: "^$", maxResults: 10 })), "blank.txt:2:\ncrlf.txt:2:\nopen.txt:2:");
});

test("a long matching line is shown as its first 500 characters, never half a character", async () => {
  const root = await realpath(await tempDir());
  await writeTree(root, { "min.js": `${"a".repeat(499)}😀needle\n` });

  assert.equal(resultText(await grep(root, root, { pattern: "needle", maxResults: 10 })), `min.js:1:${"a".repeat(499)}…`);
});

test("grep and glob results fit in one client result, with the notes first", async () => {
  const root = await realpath(await tempDir());
  // 1001 matching lines of 600 characters, each shown as a 500-character preview: about 515,000 characters in all.
  const wide = "match ".repeat(100);
  await writeTree(root, { "wide.txt": `${wide}\n`.repeat(1001), "zh.txt": `${"中文".repeat(250)}\n`.repeat(500) });

  const lines = resultText(await grep(join(root, "wide.txt"), root, { pattern: "match", maxResults: 1000 }));
  const [stopped, cut, gap, ...shown] = lines.split("\n");

  assert.ok(lines.length <= MAX_RESULT_CHARS && Buffer.byteLength(lines) <= MAX_BYTES, `${lines.length} characters`);
  assert.equal(stopped, "[Stopped after 1000 results. Narrow the search with path, glob or a more specific pattern.]");
  assert.equal(
    cut,
    `[Output cut to fit the size limit (45,000 characters or 50KB): showing ${shown.length} of 1000 matching lines. Narrow the search to see the rest.]`,
  );
  assert.equal(gap, "");
  assert.ok(shown.length > 50, `only ${shown.length} lines shown`);
  shown.forEach((line, i) => assert.equal(line, `wide.txt:${i + 1}:${wide.slice(0, 500)}…`));

  // Text of three bytes a character reaches the byte limit first.
  const chinese = resultText(await grep(join(root, "zh.txt"), root, { pattern: "中", maxResults: 1000 }));
  const [chineseCut, , ...chineseShown] = chinese.split("\n");

  assert.ok(Buffer.byteLength(chinese) <= MAX_BYTES, `${Buffer.byteLength(chinese)} bytes`);
  assert.match(chineseCut!, new RegExp(`^\\[Output cut to fit the size limit .*: showing ${chineseShown.length} of 500 matching lines\\.`));
  assert.ok(chinese.length < MAX_RESULT_CHARS / 2, `${chinese.length} characters`);

  // Results that fit are left whole.
  assert.equal(resultText(await grep(join(root, "wide.txt"), root, { pattern: "match", filesOnly: true, maxResults: 1000 })), "wide.txt");

  // 2000 paths of 130 characters: about 262,000 characters.
  const many = await realpath(await tempDir());
  const folder = "d".repeat(60);
  const name = (i: number) => `${folder}/${String(i).padStart(4, "0")}-${"f".repeat(60)}.txt`;
  await writeTree(many, Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [name(i), ""])));

  const paths = resultText(await glob(many, many, "*.txt", 2000));
  const [showing, blank, ...listed] = paths.split("\n");

  assert.ok(paths.length <= MAX_RESULT_CHARS && Buffer.byteLength(paths) <= MAX_BYTES, `${paths.length} characters`);
  assert.equal(
    showing,
    `[Showing ${listed.length} of 2000 files, cut to fit the size limit (45,000 characters or 50KB). Use a more specific pattern or path.]`,
  );
  assert.equal(blank, "");
  assert.ok(listed.length > 50, `only ${listed.length} paths shown`);
  listed.forEach((path, i) => assert.equal(path, name(i)));
});
