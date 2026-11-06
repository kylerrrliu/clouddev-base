import {
  closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Dirent, type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isInside } from "../paths.ts";
import { readIndexPaths } from "./git-index.ts";
import { configValue, IGNORE_CASE, isIgnored, parseIgnoreFile, type IgnoreFile } from "./gitignore.ts";

// Everything here is synchronous: it runs on the search worker thread, where
// blocking calls stall nothing else and a stuck call cannot hold a slot of
// libuv's thread pool, which the main thread shares.

/** Folders skipped outside Git repositories, where no .gitignore says what to skip. */
export const DEFAULT_IGNORED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
  ".next", ".nuxt", ".turbo", ".cache", "dist", "build", "target", "coverage",
]);

export const MAX_LISTED_FILES = 100_000;

const MAX_IGNORE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 128 * 1024 * 1024;

// O_NONBLOCK keeps a FIFO from stalling the open. Files from the searched tree
// are also opened with O_NOFOLLOW, so a symlink is never read through.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const OPEN_FLAGS_NOFOLLOW = OPEN_FLAGS | (constants.O_NOFOLLOW ?? 0);

export interface FileList {
  /** Paths relative to the listed folder, always with forward slashes. */
  files: string[];
  capped: boolean;
}

interface Folder {
  path: string;
  /** Relative to the listed folder, "/"-separated ("" for the folder itself). */
  rel: string;
  /** Set inside a Git repository. */
  repo: RepoState | undefined;
  /** Outside repositories: whether DEFAULT_IGNORED_DIRS are skipped. */
  skipDefaults: boolean;
}

interface Repo {
  /** Ignore files every folder of the repository starts with: global excludes, then info/exclude. */
  rules: IgnoreFile[];
  /** Files tracked in the index, read on first use. */
  tracked(): Tracked;
}

interface Tracked {
  /** Tracked regular files, as trackedKey()s of their paths from the repository root. */
  files: Set<string>;
  /** Every folder holding a tracked file, in the same form. */
  dirs: Set<string>;
}

interface RepoState {
  repo: Repo;
  /** The folder relative to the repository root; lower-cased when IGNORE_CASE. */
  rel: string;
  /** Ignore files in force, lowest precedence first. */
  rules: IgnoreFile[];
  /** Inside an ignored folder, where only tracked files are listed. */
  trackedOnly: boolean;
}

/**
 * List the regular files below `root` without running Git or any other program.
 *
 * Inside a Git repository the files Git would show are listed: tracked files
 * (read from .git/index), and untracked ones unless .gitignore files (also
 * those above `root`), .git/info/exclude or the user's global excludes file
 * ignore them. Nested repositories and submodules are entered and follow their
 * own rules. Outside repositories, DEFAULT_IGNORED_DIRS are skipped. Symlinks
 * are neither followed nor listed, and neither are folders, sockets, FIFOs or
 * devices.
 *
 * `root` itself is always listed, even when ignored: a search of
 * "node_modules/pkg" covers all of it, minding only .gitignore files inside.
 * `workspaceRoot` bounds that check outside repositories.
 */
export function listFiles(root: string, workspaceRoot = root, limit = MAX_LISTED_FILES): FileList {
  let globalLoaded = false;
  let globalExcludes: IgnoreFile | undefined;

  const openRepo = (repoRoot: string): Repo => {
    if (!globalLoaded) {
      globalExcludes = readGlobalExcludes();
      globalLoaded = true;
    }

    let tracked: Tracked | undefined;

    return {
      rules: [globalExcludes, readInfoExclude(repoRoot)].filter((file) => file !== undefined),
      tracked: () => (tracked ??= readTracked(repoRoot)),
    };
  };

  const files: string[] = [];
  const pending: Folder[] = [startFolder(root, workspaceRoot, openRepo)];

  while (pending.length > 0) {
    const folder = pending.pop()!;
    const entries = readEntries(folder.path);
    let state = folder.repo;

    // A nested repository or submodule starts over with its own rules (unless
    // it sits in an ignored folder, where only the outer tracked files count).
    if (folder.rel !== "" && !state?.trackedOnly && entries.some((entry) => entry.name === ".git")) {
      const repo = openRepo(folder.path);
      state = { repo, rel: "", rules: repo.rules, trackedOnly: false };
    }

    if (state && !state.trackedOnly && entries.some((entry) => entry.name === ".gitignore" && entry.isFile())) {
      const gitignore = readIgnoreFile(join(folder.path, ".gitignore"), state.rel);
      if (gitignore) state = { ...state, rules: [...state.rules, gitignore] };
    }

    const subfolders: Folder[] = [];

    for (const entry of entries) {
      const name = entry.name;
      const isDir = entry.isDirectory();

      // .git is never listed; symlinks and special files are neither listed nor followed.
      if (name === ".git" || (!isDir && !entry.isFile())) continue;

      const rel = folder.rel === "" ? name : `${folder.rel}/${name}`;
      let childRepo: RepoState | undefined;

      if (state) {
        const key = IGNORE_CASE ? name.toLowerCase() : name;
        const repoRel = state.rel === "" ? key : `${state.rel}/${key}`;
        let trackedOnly = state.trackedOnly;

        if (trackedOnly || (state.rules.length > 0 && isIgnored(state.rules, repoRel, key, isDir))) {
          // Git still lists tracked files with ignored names or in ignored folders.
          const tracked = state.repo.tracked();
          if (!(isDir ? tracked.dirs : tracked.files).has(trackedKey(repoRel))) continue;
          trackedOnly = true;
        }

        if (isDir) childRepo = { repo: state.repo, rel: repoRel, rules: state.rules, trackedOnly };
      } else if (isDir && folder.skipDefaults && DEFAULT_IGNORED_DIRS.has(name)) {
        continue;
      }

      if (isDir) {
        subfolders.push({ path: join(folder.path, name), rel, repo: childRepo, skipDefaults: folder.skipDefaults });
      } else {
        files.push(rel);

        if (files.length >= limit) return { files, capped: true };
      }
    }

    // Depth first, in name order, so a capped listing is predictable.
    for (let i = subfolders.length - 1; i >= 0; i--) pending.push(subfolders[i]!);
  }

  return { files, capped: false };
}

function startFolder(root: string, workspaceRoot: string, openRepo: (repoRoot: string) => Repo): Folder {
  const repoRoot = findRepoRoot(root);

  if (repoRoot === undefined) {
    const insideSkipped = pathParts(workspaceRoot, root).some((part) => DEFAULT_IGNORED_DIRS.has(part));

    return { path: root, rel: "", repo: undefined, skipDefaults: !insideSkipped };
  }

  const repo = openRepo(repoRoot);
  const parts = pathParts(repoRoot, root);
  const keys = parts.map((part) => (IGNORE_CASE ? part.toLowerCase() : part));
  const rel = keys.join("/");
  let rules = repo.rules;
  let dir = repoRoot;

  // Apply the .gitignore files from the repository root down to `root`, and
  // check that no folder on the way is ignored.
  for (let i = 0; i < parts.length; i++) {
    const gitignore = readIgnoreFile(join(dir, ".gitignore"), keys.slice(0, i).join("/"));
    if (gitignore) rules = [...rules, gitignore];

    if (isIgnored(rules, keys.slice(0, i + 1).join("/"), keys[i]!, true)) {
      // Asked for by name though ignored: list all of it, minding only .gitignore files inside.
      return { path: root, rel: "", repo: { repo, rel, rules: [], trackedOnly: false }, skipDefaults: false };
    }

    dir = join(dir, parts[i]!);
  }

  return { path: root, rel: "", repo: { repo, rel, rules, trackedOnly: false }, skipDefaults: false };
}

/** The nearest folder at or above `start` that has a .git entry (folder, or file for submodules and worktrees). */
function findRepoRoot(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    try {
      if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false })) return dir;
    } catch {
      // Unreadable: treat as no repository here.
    }

    if (dirname(dir) === dir) return undefined;
  }
}

/** The path segments leading from `from` down to `to`, or none when `to` is not below `from`. */
function pathParts(from: string, to: string): string[] {
  const rel = relative(from, to);

  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return [];

  return rel.split(sep);
}

function readEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return []; // Deleted or unreadable: skipped.
  }
}

function readIgnoreFile(path: string, base: string, follow = false): IgnoreFile | undefined {
  const file = readRegularFile(path, MAX_IGNORE_FILE_BYTES, follow);
  if (!file) return undefined;

  const parsed = parseIgnoreFile(file.data.toString("utf8"), base);

  return parsed.rules.length > 0 ? parsed : undefined;
}

/**
 * Only from a real .git folder, never through a symlink: the repository's
 * contents are untrusted. Submodules and worktrees keep this file elsewhere
 * (their .git is a file pointing there); it is not followed.
 */
function readInfoExclude(repoRoot: string): IgnoreFile | undefined {
  const gitDir = join(repoRoot, ".git");

  try {
    if (!lstatSync(gitDir).isDirectory() || !lstatSync(join(gitDir, "info")).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  return readIgnoreFile(join(gitDir, "info", "exclude"), "");
}

/** Tracked files from a real .git folder's index; none for submodules and worktrees (see readInfoExclude). */
function readTracked(repoRoot: string): Tracked {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const gitDir = join(repoRoot, ".git");
  let paths: string[] | undefined;

  try {
    if (lstatSync(gitDir).isDirectory()) {
      const index = readRegularFile(join(gitDir, "index"), MAX_INDEX_BYTES);
      paths = index && readIndexPaths(index.data);
    }
  } catch {
    // No usable index: nothing counts as tracked.
  }

  for (const path of paths ?? []) {
    const key = trackedKey(IGNORE_CASE ? path.toLowerCase() : path);
    files.add(key);

    // Folders are added deepest first, so one already present has its parents too.
    for (let slash = key.lastIndexOf("/"); slash > 0; slash = key.lastIndexOf("/", slash - 1)) {
      const dir = key.slice(0, slash);
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
  }

  return { files, dirs };
}

const NON_ASCII = /[^\x00-\x7f]/;

/** Git stores paths precomposed (NFC) on macOS while the disk may not; compare them in one form. */
function trackedKey(path: string): string {
  return NON_ASCII.test(path) ? path.normalize("NFC") : path;
}

function readGlobalExcludes(): IgnoreFile | undefined {
  const path = globalExcludesPath();

  // The user's own file, so symlinks (common with dotfile managers) are followed.
  return path === undefined ? undefined : readIgnoreFile(path, "", true);
}

/**
 * The global ignore file Git reads: core.excludesFile from the user's own Git
 * config (~/.gitconfig or $XDG_CONFIG_HOME/git/config, or $GIT_CONFIG_GLOBAL),
 * else $XDG_CONFIG_HOME/git/ignore, which defaults to ~/.config/git/ignore.
 */
export function globalExcludesPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = homedir();
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const configs = env.GIT_CONFIG_GLOBAL ? [env.GIT_CONFIG_GLOBAL] : [join(configHome, "git", "config"), join(home, ".gitconfig")];
  let setting: string | undefined;

  for (const config of configs) {
    const file = readRegularFile(config, MAX_CONFIG_FILE_BYTES, true);
    const value = file && configValue(file.data.toString("utf8"), "core", "excludesfile");

    if (value !== undefined) setting = value;
  }

  if (setting === undefined) return join(configHome, "git", "ignore");
  if (setting.startsWith("~/")) return join(home, setting.slice(2));

  return isAbsolute(setting) ? setting : undefined;
}

/**
 * Read a regular file of at most `maxBytes`. Returns undefined for anything
 * else: missing, too large, a folder, FIFO or device, or (unless `follow`) a
 * symlink. Never blocks on a FIFO.
 */
export function readRegularFile(path: string, maxBytes: number, follow = false): { data: Buffer; stats: Stats } | undefined {
  let fd: number;

  try {
    fd = openSync(path, follow ? OPEN_FLAGS : OPEN_FLAGS_NOFOLLOW);
  } catch {
    return undefined;
  }

  try {
    const stats = fstatSync(fd);

    if (!stats.isFile() || stats.size > maxBytes) return undefined;

    const data = Buffer.allocUnsafe(stats.size);
    let length = 0;

    while (length < data.length) {
      const read = readSync(fd, data, length, data.length - length, null);
      if (read === 0) break;
      length += read;
    }

    return { data: data.subarray(0, length), stats };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Check a result just before it is reported: still a regular file whose real
 * path lies inside `realRoot`, and, when `opened` is given, the very file that
 * was read (so a folder swapped for a symlink in between is caught).
 */
export function confirmInside(path: string, realRoot: string, opened?: Stats): boolean {
  try {
    const real = realpathSync.native(path);

    if (!isInside(real, realRoot)) return false;

    const stats = lstatSync(real);

    return stats.isFile() && (!opened || (stats.dev === opened.dev && stats.ino === opened.ino));
  } catch {
    return false;
  }
}
