import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { listFiles } from "../src/tools/file-list.ts";
import { readIndexPaths } from "../src/tools/git-index.ts";
import { configValue, isIgnored, parseIgnoreFile } from "../src/tools/gitignore.ts";
import { compileWildmatch } from "../src/tools/glob-match.ts";
import { activeSearchWorkers, compileGlob, glob, grep } from "../src/tools/search.ts";
import { runGlob, runGrep } from "../src/tools/search-worker.ts";
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

  const all = resultText(await grep(root, root, { pattern: "main", maxResults: 100 }));
  assert.equal(all, "README.md:1:Run main() to start\nsrc/app.ts:2:export function main() {}");

  const ts = resultText(await grep(root, root, { pattern: "todo", ignoreCase: true, glob: "*.ts", maxResults: 100 }));
  assert.equal(ts, "src/app.ts:3:// TODO: tidy");

  const files = resultText(await grep(join(root, "src"), root, { pattern: "todo", ignoreCase: true, filesOnly: true, maxResults: 100 }));
  assert.equal(files, "src/app.ts\nsrc/util.js");

  const limited = resultText(await grep(root, root, { pattern: ".", maxResults: 2 }));
  assert.match(limited, /\[Stopped after 2 results/);

  assert.equal(resultText(await grep(root, root, { pattern: "nothing-here", maxResults: 10 })), "No matches found.");
  await assert.rejects(grep(root, root, { pattern: "(", maxResults: 10 }), /Invalid regular expression/);
  await assert.rejects(grep(join(root, "nope"), root, { pattern: "x", maxResults: 10 }), /^Error: Path not found: nope$/);
  await assert.rejects(glob(join(root, "nope"), root, "*", 10), /^Error: Path not found: nope$/);
  await assert.rejects(glob(join(root, "README.md"), root, "*", 10), /glob path must be a folder/);

  assert.equal(resultText(await glob(root, root, "*.{ts,js}", 200)), "src/app.ts\nsrc/util.js");
  assert.equal(resultText(await glob(join(root, "src"), root, "*.ts", 200)), "src/app.ts");
  assert.equal(resultText(await glob(root, root, "*.py", 200)), "No files found.");
  assert.equal(resultText(await glob(root, root, "*", 2)), "README.md\nlogo.bin\n\n[Showing 2 of 4 files. Use a more specific pattern or path.]");

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
