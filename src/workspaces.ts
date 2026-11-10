import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existingPart, fileId, isPlainObject, otherNames, readStateFile, realPathOf, writeJsonPrivate } from "./config.ts";
import { AccessDeniedError, canonicalize, expandHome, isInside, isMissing, resolveInside } from "./paths.ts";

export interface Workspace {
  id: string;
  /** The path as opened (may contain symlinks). Commands run here. */
  root: string;
  /** `root` with symlinks resolved; every file access must stay inside it. */
  canonicalRoot: string;
}

/**
 * Maps workspace ids to project folders inside the allowed roots.
 *
 * Ids are derived from the folder, so reopening a project returns the same id,
 * and they are saved to disk so they keep working after a server restart.
 *
 * No workspace may hold the server's state folder or lie inside it, whatever the allowed roots are: read, grep and
 * glob run without a prompt, and the folder holds the Owner password and the OAuth tokens.
 */
export class WorkspaceRegistry {
  readonly allowedRoots: string[];
  private readonly roots = new Map<string, string>();
  private readonly state: StateFolder | undefined;
  private readonly storeFile: string | undefined;

  constructor(allowedRoots: string[], stateDir?: string) {
    this.allowedRoots = allowedRoots.map((root) => resolve(expandHome(root)));
    this.state = stateDir ? new StateFolder(resolve(stateDir)) : undefined;
    this.storeFile = this.state ? join(this.state.path, "workspaces.json") : undefined;

    // A broken file must not keep the server from starting; it only knows ids it handed out before.
    const saved = this.storeFile
      ? readStateFile(this.storeFile, isWorkspaceMap, "之前打开过的项目要重新用 open_workspace 打开一次（workspace_id 不变）")
      : undefined;

    for (const [id, root] of Object.entries(saved ?? {})) this.roots.set(id, root);
  }

  async open(input: string, create = false): Promise<Workspace> {
    const [firstRoot] = this.allowedRoots;

    if (!firstRoot) throw new Error("No allowed roots are configured.");

    // Relative paths are taken relative to the first allowed root.
    const root = resolve(firstRoot, expandHome(input.trim()));
    const canonical = await this.assertAllowed(root, input);
    // Before anything is created: create=true must not make a folder inside the state folder either.
    await this.assertClearOfState(root, canonical, input);

    let stats = await stat(root).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });

    if (!stats) {
      if (!create) {
        throw new Error(
          `Directory does not exist: ${root}. Pass create=true to create it, or open one of the allowed roots to list existing projects: ${this.allowedRoots.join(", ")}`,
        );
      }

      await mkdir(root, { recursive: true });
      stats = await stat(root);
    }

    if (!stats.isDirectory()) throw new Error(`Not a directory: ${root}`);

    const canonicalRoot = await realpath(root);
    const id = `ws_${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 10)}`;

    if (this.roots.get(id) !== root) {
      this.roots.set(id, root);
      this.save();
    }

    return { id, root, canonicalRoot };
  }

  async get(id: string): Promise<Workspace> {
    const root = this.roots.get(id);

    if (!root) {
      throw new Error(`Unknown workspace_id "${id}". Call open_workspace again to get a valid workspace_id.`);
    }

    // Re-check on every call: allowed roots or the folder itself may have changed.
    const canonical = await this.assertAllowed(root, root);
    await this.assertClearOfState(root, canonical, root);
    const canonicalRoot = await realpath(root).catch(() => {
      throw new Error(`Workspace folder no longer exists: ${root}. Call open_workspace again.`);
    });

    return { id, root, canonicalRoot };
  }

  /** The folder a workspace id stands for, without any checks. Only for display. */
  rootOf(id: string): string | undefined {
    return this.roots.get(id);
  }

  /** Resolve a workspace-relative path, refusing anything that escapes the workspace. */
  async resolvePath(workspace: Workspace, path: string): Promise<string> {
    const resolved = await resolveInside(workspace.root, workspace.canonicalRoot, path);

    // A workspace never holds the state folder, but folders can be moved or swapped for symlinks after the check.
    if (this.state && (await this.state.contains(resolved))) {
      throw new AccessDeniedError(`Path is inside the clouddev-base state folder (${this.state.path}), which holds the Owner password and the OAuth tokens: ${path}`);
    }

    return resolved;
  }

  /** Refuse a path outside the allowed roots. Returns it with symlinks resolved. */
  private async assertAllowed(path: string, input: string): Promise<string> {
    const denied = new AccessDeniedError(
      `Path is outside the allowed roots (${this.allowedRoots.join(", ")}): ${input}`,
    );

    if (!this.allowedRoots.some((root) => isInside(path, root))) throw denied;

    const canonical = await canonicalize(path);

    for (const root of this.allowedRoots) {
      const canonicalRoot = await realpath(root).catch(() => undefined);

      if (canonicalRoot && isInside(canonical, canonicalRoot)) return canonical;
    }

    throw denied;
  }

  /** Refuse a workspace (`path` as opened, `canonical` with symlinks resolved) that holds the state folder or lies inside it. */
  private async assertClearOfState(path: string, canonical: string, input: string): Promise<void> {
    const relation = await this.state?.relationOf(path, canonical);

    if (!relation) return;

    throw new AccessDeniedError(
      `Refused: ${input} ${relation} the clouddev-base state folder (${this.state!.path}), which holds the Owner password and the OAuth tokens.${relation === "contains" ? " Open a project folder that does not contain it." : ""}`,
    );
  }

  private save(): void {
    if (this.storeFile) writeJsonPrivate(this.storeFile, Object.fromEntries(this.roots));
  }
}

/** What workspaces.json must hold: workspace ids mapped to absolute folder paths. */
function isWorkspaceMap(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((root) => typeof root === "string" && isAbsolute(root));
}

/** How a folder relates to the state folder. */
type Relation = "is" | "contains" | "is inside";

interface StateFolderIdentity {
  /** Device and inode of the state folder; undefined while it does not exist. */
  id: string | undefined;
  /** Its names: as given, with symlinks resolved and, on macOS, the one on the data volume. */
  names: string[];
  /** Device and inode of the state folder and of every folder above it, under each of its names. */
  holders: Set<string>;
  /**
   * The rest of the state folder's real path below each folder above it (".clouddev-base", "you/.clouddev-base",
   * "Users/you/.clouddev-base"), and the device and inode those names lead to. Until the state folder exists, the
   * longest part of its path that does stands in for it. Undefined when not even that can be found.
   */
  tails: { paths: string[]; id: string } | undefined;
}

/**
 * The state folder as the registry checks folders and paths against it: by name, which also works before it exists;
 * by device and inode, which catches the names realpath leaves alone (macOS's /System/Volumes/Data/…, a bind mount
 * of it or of a folder above it); and by following its names down from a folder, which catches a bind mount of a
 * folder above it under that folder's own name further down (/mnt holds /home/you/.clouddev-base when /mnt/home is a
 * bind mount of /home). Its names and the folders that hold it are worked out once, here; the checks made on every
 * tool call only stat and resolve names, asynchronously, so a slow disk never holds up the whole server.
 */
export class StateFolder {
  readonly path: string;
  private known: StateFolderIdentity;

  constructor(path: string) {
    this.path = path;
    this.known = identify(path);
  }

  /** How a folder (`path` as given, `canonical` with symlinks resolved; it need not exist) relates to the state folder. */
  async relationOf(path: string, canonical: string): Promise<Relation | undefined> {
    const known = await this.current();
    const [holds, inside] = await Promise.all([holdsState(known, path, canonical), insideState(known, path, canonical)]);

    return holds && inside ? "is" : holds ? "contains" : inside ? "is inside" : undefined;
  }

  /** Whether `path` (symlinks resolved; it need not exist) is the state folder or lies inside it. */
  async contains(path: string): Promise<boolean> {
    return insideState(await this.current(), path, path);
  }

  /** Worked out again only when the state folder itself changed: made after the server started, or replaced. */
  private async current(): Promise<StateFolderIdentity> {
    if ((await idOf(this.path)) !== this.known.id) this.known = identify(this.path);

    return this.known;
  }
}

function identify(path: string): StateFolderIdentity {
  const real = realPathOf(path);
  const names = [...new Set([path, real, ...otherNames(real)])];
  const holders = new Set<string>();

  for (const folder of names.flatMap(selfAndAbove)) {
    const id = fileId(folder);

    if (id !== undefined) holders.add(id);
  }

  // The device and inode of the state folder (or of what stands in for it) are among the holders already: only the
  // folders above it leave a rest of the path to follow.
  const existing = existingPart(real);
  const existingId = fileId(existing);
  const tails = existingId === undefined
    ? undefined
    : { paths: selfAndAbove(existing).slice(1).map((above) => relative(above, existing)), id: existingId };

  return { id: fileId(real), names, holders, tails };
}

async function holdsState(known: StateFolderIdentity, path: string, canonical: string): Promise<boolean> {
  if (known.names.some((name) => isInside(name, path) || isInside(name, canonical))) return true;

  const id = await idOf(canonical);

  if (id !== undefined && known.holders.has(id)) return true;

  return holdsFurtherDown(known, canonical);
}

/**
 * Whether the folder `canonical` holds the state folder further down under the names its real path ends with: one
 * of the folders above the state folder is there under another name, and the rest of the path leads from it to the
 * state folder itself (/mnt/home/you/.clouddev-base, when /mnt/home is a bind mount of /home). Only names that stay
 * inside `canonical` count: a symlink there that leads out holds nothing, as resolveInside refuses what lies behind
 * it. A bind mount under a name of its own (/mnt/host for /) is not seen here: resolvePath still refuses a state file
 * named through it, by its device and inode, but grep and glob check only the folder they start from.
 */
async function holdsFurtherDown(known: StateFolderIdentity, canonical: string): Promise<boolean> {
  if (!known.tails) return false;

  const { paths, id } = known.tails;
  const found = await Promise.all(paths.map(async (tail) => {
    const real = await realpath(join(canonical, tail)).catch(() => undefined);

    return real !== undefined && isInside(real, canonical) && (await idOf(real)) === id;
  }));

  return found.includes(true);
}

async function insideState(known: StateFolderIdentity, path: string, canonical: string): Promise<boolean> {
  if (known.names.some((name) => isInside(path, name) || isInside(canonical, name))) return true;

  if (known.id === undefined) return false;

  return (await Promise.all(selfAndAbove(canonical).map(idOf))).includes(known.id);
}

/** `path` and every folder above it. */
function selfAndAbove(path: string): string[] {
  const folders = [path];

  for (let folder = path; dirname(folder) !== folder; folder = dirname(folder)) folders.push(dirname(folder));

  return folders;
}

/** Device and inode, as config.ts's fileId gives them, or undefined when the file cannot be found. */
async function idOf(path: string): Promise<string | undefined> {
  try {
    const stats = await stat(path, { bigint: true });

    return `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
}
