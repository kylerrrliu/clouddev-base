import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, statfs, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { isMissing } from "../paths.ts";
import { clipStart, formatSize } from "./common.ts";

const execFileAsync = promisify(execFile);

/** Bounds of the space a write leaves free on its disk (see freeSpaceReserve). */
const MIN_FREE_SPACE_RESERVE = 1024 * 1024;
export const MAX_FREE_SPACE_RESERVE = 64 * 1024 * 1024;

/** Cloning is instant on APFS; on a disk that cannot clone, ditto copies the data, and a stuck copy is given up. */
const CLONE_TIMEOUT_MS = 15_000;

/**
 * How long a refused rename is retried on Windows, where a virus scanner or the search indexer often holds a file
 * for a moment after it was closed (graceful-fs retries renames there for the same reason).
 */
const WINDOWS_RENAME_RETRY_MS = 1_000;

/** How many folders that keep temporary files are remembered (see leftoverFolders). */
const MAX_LEFTOVER_FOLDERS = 100;

// O_NONBLOCK keeps a FIFO from stalling an open; O_NOFOLLOW refuses a symlink put in place of a file.
const NO_WAIT = (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

// On Windows a virus scanner may hold a file for a moment: rm retries EBUSY and EPERM there.
const REMOVE_OPTIONS = { recursive: true, force: true, ...(process.platform === "win32" ? { maxRetries: 5, retryDelay: 50 } : {}) };

/** What edit remembers of the file it read, to notice a change made by someone else before it saves. */
export interface FileVersion {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** Free space and size of a disk, in blocks of `bsize` bytes, as statfs reports them. */
export interface DiskSpace {
  bavail: number;
  blocks: number;
  bsize: number;
}

export interface ReplaceOptions {
  /** How messages name the file. */
  displayPath: string;
  /** The file as edit read it: nothing is written if it has changed since. */
  expected?: FileVersion;
  /** Start the temporary file as a clone of the old one. Defaults to true on macOS; tests turn it off. */
  clone?: boolean;
  /** Free space of the disk holding a folder. Tests replace it. */
  statfs?: (path: string) => Promise<DiskSpace>;
  /** Renames the temporary file over the old one. Tests replace it. */
  rename?: (from: string, to: string) => Promise<void>;
  /** How long a refused rename is retried: about a second on Windows, not at all elsewhere. Tests set it. */
  renameRetryMs?: number;
  /** The program that clones the old file (ditto) and how long it may take. Tests replace them. */
  ditto?: string;
  cloneTimeoutMs?: number;
}

export interface ReplaceResult {
  /** The file did not exist before. */
  created: boolean;
  /** What the model should be told, such as a hard link that is now broken. */
  notes: string[];
}

/** Keeping the group or renaming was refused (EACCES, EPERM, or EBUSY from a rename): write in place. */
class ReplaceDenied extends Error {}

/** A temporary file being written. */
interface TempFile {
  path: string;
  handle: FileHandle;
  closed?: boolean;
  /** The private folder the clone was made in, removed together with it. */
  folder?: TempFolder;
  /** Cloning the old file was tried and failed: this file lacks its extended attributes and ACL. */
  cloneFailed: boolean;
}

/**
 * The private folder a clone is made in, with its device and inode as made: removing it never touches anything put
 * in its place since (a symbolic link to another folder, by someone who can change the file's folder).
 */
interface TempFolder {
  path: string;
  dev: number;
  ino: number;
  /** The name of the clone in it. ditto's partial copy is named .BC.T_*. */
  clone: string;
}

/**
 * What became of writing through a temporary file: the file has the new content ("replaced"); no temporary file could
 * be created in the folder ("refused"); or one was written, but the folder would not let it take the file's place, or
 * keep the file's group ("denied").
 */
type TempOutcome = "replaced" | "refused" | "denied";

/**
 * Folders where a temporary file or folder of a write could not be removed (an ACL that forbids deleting entries),
 * each with the path of what stayed there. Writes there go in place, so they do not leave one more behind every
 * time, for as long as that one is still there, whatever else changes in the folder. Once it is gone (the user
 * removed it, which needs the ACL changed), writes there go through a temporary file again.
 */
const leftoverFolders = new Map<string, string>();

/**
 * Give the file at `path` (a canonical path) the content `data`, so that a failure part way through (a full disk,
 * a killed process, a power cut) leaves the old file whole: the new content goes into a temporary file in the same
 * folder, which is flushed to disk and then renamed over the old file. On macOS the temporary file starts as a clone
 * of the old one, so extended attributes and ACLs carry over.
 *
 * The path then names a new file: a process that holds the old one open (a server writing its log, tail -f, a Docker
 * bind mount of the single file) keeps using the old one until it opens the path again. Emptying a file is done in
 * place, so that a log can be cleared while its server keeps appending to it; a truncate cannot stop half way.
 *
 * The mode is kept, except setuid and setgid, which a plain write clears too; a new file gets the mode a plain write
 * gives it. Hard links to the old file are broken (said in the notes). A file owned by another user, or one whose
 * folder refuses the swap, is written in place instead, after the same checks. Read-only files stay refused, as
 * with a plain write, although a rename could replace them.
 */
export async function replaceFile(path: string, data: string | Buffer, options: ReplaceOptions): Promise<ReplaceResult> {
  const { displayPath } = options;
  const content = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const folder = dirname(path);
  const target = await lstatIfExists(path);

  if (target) {
    assertRegularFile(target, displayPath);
    await assertWritable(path, displayPath);
  }

  if (options.expected) assertUnchanged(target, options.expected, displayPath);

  if (target && content.length === 0) {
    // Truncating frees space rather than taking it, so the disk may be full.
    await writeInPlace(path, content, options, "it was being emptied");

    return { created: false, notes: [] };
  }

  await assertFreeSpace(folder, content.length, displayPath, target !== undefined, options.statfs ?? statfs);

  if (!target) {
    await createParents(path, displayPath);
  } else if (ownedByAnotherUser(target)) {
    // A file this process creates would be this user's: replacing it would take it away from its owner.
    await writeInPlace(path, content, options, "it belongs to another user");

    return { created: false, notes: [] };
  }

  if (await keepsLeftovers(folder)) {
    await writeInPlace(path, content, options, "its folder does not allow removing files", !target);

    return { created: !target, notes: [] };
  }

  const notes: string[] = [];
  const outcome = await writeThroughTemp(path, content, target, options, notes);

  if (outcome === "replaced") {
    if (target && target.nlink > 1) {
      notes.unshift(`Note: ${displayPath} had ${target.nlink} hard links; it is now a separate file, and its other names keep the old content.`);
    }

    return { created: !target, notes };
  }

  if (!target && outcome === "refused") throw new Error(`Could not create ${displayPath}: its folder is not writable. Nothing was written.`);

  // A new file can still be created where its temporary file could be.
  await writeInPlace(path, content, options, "its folder does not allow replacing it", !target);

  return { created: !target, notes };
}

/** Write a temporary file and rename it over `path`. Notes about what the attempt left behind go into `notes`. */
async function writeThroughTemp(
  path: string,
  content: Buffer,
  target: Stats | undefined,
  options: ReplaceOptions,
  notes: string[],
): Promise<TempOutcome> {
  let temp: TempFile | undefined;

  try {
    temp = await createTemp(path, target, options, notes);

    if (!temp) return "refused";

    if (target) await keepGroup(temp.handle, target);

    await temp.handle.writeFile(content);
    await temp.handle.sync();
    await temp.handle.close();
    temp.closed = true;

    await renameOver(temp.path, path, options);
  } catch (error) {
    if (temp) {
      if (!temp.closed) await temp.handle.close().catch(() => undefined);

      if (temp.folder) await discardFolder(temp.folder, options.displayPath, notes);
      else await discardFile(temp.path, options.displayPath, notes);
    }

    if (error instanceof ReplaceDenied) return "denied";

    // Our own messages (the file changed under edit) already say what happened.
    if (!(error as NodeJS.ErrnoException).code) throw error;

    throw new Error(
      `Could not write ${options.displayPath} (${describeError(error)}). ${target ? "The original file is unchanged." : "The file was not created."}`,
    );
  }

  // The clone's private folder is empty now.
  if (temp.folder) await discardFolder(temp.folder, options.displayPath, notes);

  if (temp.cloneFailed) {
    notes.push(
      `Note: the extended attributes and ACL of ${options.displayPath}, if it had any, could not be carried over to the new file (copying them failed); its mode and group were kept.`,
    );
  }

  return "replaced";
}

/** Create the temporary file, open for writing. Undefined when the folder does not allow it. */
async function createTemp(
  path: string,
  target: Stats | undefined,
  options: ReplaceOptions,
  notes: string[],
): Promise<TempFile | undefined> {
  const cloning = target !== undefined && (options.clone ?? process.platform === "darwin");

  if (cloning) {
    const cloned = await cloneTemp(path, target, options, notes);

    if (cloned) return cloned;

    // Its private folder could not be removed, so neither could a temporary file.
    if (await keepsLeftovers(dirname(path))) return undefined;
  }

  const temp = join(dirname(path), tempNameFor(path));
  let handle: FileHandle;

  try {
    // A new file gets 0o666 less the umask, as a plain write gives; one replacing a file starts private and gets
    // that file's mode below.
    handle = await open(temp, CREATE_FLAGS, target ? 0o600 : 0o666);
  } catch (error) {
    if (isDenied(error)) return undefined;
    throw error;
  }

  try {
    if (target) await handle.chmod(keptMode(target));
  } catch (error) {
    await handle.close().catch(() => undefined);
    await discardFile(temp, options.displayPath, notes);
    throw error;
  }

  return { path: temp, handle, cloneFailed: cloning };
}

/**
 * A clone of the old file to overwrite, so it keeps the old file's extended attributes and ACLs, which a new file
 * would lack. ditto --clone is used because cp -c drops ACLs. On a disk that cannot clone (HFS+, FAT, network
 * shares) ditto copies the data instead: slower, but the metadata still comes along. ditto works in a private folder
 * next to the file, which also holds its own partial copy (.BC.T_*) while it copies, so removing the folder removes
 * whatever a failed or timed-out copy left. Undefined when cloning fails for any reason; the caller then creates an
 * empty temporary file.
 */
async function cloneTemp(path: string, target: Stats, options: ReplaceOptions, notes: string[]): Promise<TempFile | undefined> {
  let folder: TempFolder;

  try {
    const made = await mkdtemp(join(dirname(path), ".clouddev-"));
    const stats = await lstat(made);

    // Whatever was put in place of the folder just made is not this write's to use, nor to remove.
    if (!stats.isDirectory()) return undefined;

    folder = { path: made, dev: stats.dev, ino: stats.ino, clone: tempNameFor(path) };
  } catch {
    return undefined;
  }

  const clone = join(folder.path, folder.clone);
  let handle: FileHandle | undefined;

  try {
    await execFileAsync(options.ditto ?? "/usr/bin/ditto", ["--clone", path, clone], {
      timeout: options.cloneTimeoutMs ?? CLONE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    handle = await open(clone, constants.O_WRONLY | constants.O_TRUNC | NO_WAIT);
    const stats = await handle.stat();

    // Only a plain file of our own, nothing that was swapped in under the temporary name.
    if (!stats.isFile() || stats.nlink !== 1) throw new Error("not a fresh regular file");

    if ((stats.mode & 0o7777) !== keptMode(target)) await handle.chmod(keptMode(target));

    return { path: clone, handle, folder, cloneFailed: false };
  } catch {
    await handle?.close().catch(() => undefined);
    await discardFolder(folder, options.displayPath, notes);

    return undefined;
  }
}

/** Files this process creates may get another group than the old file had (the folder's, or the user's own). */
async function keepGroup(handle: FileHandle, target: Stats): Promise<void> {
  if (process.platform === "win32") return;

  const stats = await handle.stat();

  if (stats.gid === target.gid) return;

  try {
    await handle.chown(-1, target.gid);
  } catch (error) {
    // Not a member of that group: only writing in place keeps it.
    throw isDenied(error) ? new ReplaceDenied() : error;
  }
}

/**
 * Rename the temporary file over the old one. A refusal becomes ReplaceDenied, so the caller writes in place: EACCES
 * or EPERM (the folder, or an ACL on the file, forbids it), or EBUSY (on Linux the file is a mount point, as a bind
 * mount of a single file is; on Windows another program holds it). On Windows such a refusal often lasts only a
 * moment, so it is retried for about a second first.
 */
async function renameOver(from: string, to: string, options: ReplaceOptions): Promise<void> {
  const renameFile = options.rename ?? rename;
  const retryMs = options.renameRetryMs ?? (process.platform === "win32" ? WINDOWS_RENAME_RETRY_MS : 0);
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    // The last moment to notice an edit made since the file was read; renaming would silently undo it.
    if (options.expected) assertUnchanged(await lstatIfExists(to), options.expected, options.displayPath);

    try {
      await renameFile(from, to);

      return;
    } catch (error) {
      if (!isDenied(error) && !isBusy(error)) throw error;

      const left = retryMs - (Date.now() - startedAt);

      if (left <= 0) throw new ReplaceDenied();

      await sleep(Math.min(50 * attempt, 100, left));
    }
  }
}

/**
 * Write in place, as a plain write does: when replacing the file is not possible, or `create`s a new file in a folder
 * where a temporary file could not take its place. A failure part way through then leaves the file incomplete, so
 * the message says so.
 */
async function writeInPlace(path: string, content: Buffer, options: ReplaceOptions, reason: string, create = false): Promise<void> {
  const { displayPath } = options;
  let handle: FileHandle;

  try {
    handle = await open(path, create ? CREATE_FLAGS : constants.O_WRONLY | NO_WAIT, 0o666);
  } catch (error) {
    throw new Error(
      create
        ? `Could not create ${displayPath} (${describeError(error)}). Nothing was written.`
        : `Could not write ${displayPath} (${describeError(error)}). It was not changed.`,
    );
  }

  try {
    const stats = await handle.stat();
    assertRegularFile(stats, displayPath);

    if (options.expected) assertUnchanged(stats, options.expected, displayPath);

    try {
      await handle.truncate(0);
    } catch (error) {
      throw new Error(`Could not write ${displayPath} (${describeError(error)}). It was not changed.`);
    }

    try {
      await handle.writeFile(content);
      await handle.sync();
    } catch (error) {
      throw new Error(
        `Writing ${displayPath} failed part way (${describeError(error)}), so it may now be incomplete or empty. It had to be written in place because ${reason}, not through a temporary file.`,
      );
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `.<name>.clouddev-<random>.tmp`, short enough for any file system however long the file's name is. */
function tempNameFor(path: string): string {
  return `.${clipStart(basename(path), 100, 100)}.clouddev-${randomBytes(6).toString("hex")}.tmp`;
}

/**
 * Remove a temporary file, also when a "deny delete" ACL it inherited from its folder forbids deleting it: the owner
 * may clear that. One that stays (its folder's ACL forbids deleting entries, whatever the file's owner does) is
 * reported in `notes`, and remembered.
 */
async function discardFile(temp: string, displayPath: string, notes: string[]): Promise<void> {
  let failure = await removeIfAllowed(temp);

  if (failure === undefined) return;

  if (failure.denied && (await clearProtection([temp]))) failure = await removeIfAllowed(temp);

  if (failure !== undefined) leftBehind(temp, "file", failure.message, displayPath, notes);
}

/**
 * Remove the private folder a clone was made in. rm removes a symbolic link put in its place, never what it leads to.
 * When rm is refused, it may have given up at once: on the folder itself, when its own folder's ACL forbids removing
 * it, and on an entry it could not remove (an ACL or flag the clone brought along, or a "deny delete_child" the
 * private folder inherited from its own folder). Then, only while the path is still the folder made for this write,
 * what forbids removing its entries is cleared, on the folder and on the entries this write and ditto make, which
 * are then removed one by one: what stays is at most an empty folder, never one holding the new content.
 */
async function discardFolder(folder: TempFolder, displayPath: string, notes: string[]): Promise<void> {
  const failure = await removeIfAllowed(folder.path);

  if (failure === undefined) return;

  if (failure.denied && (await isFolderMade(folder))) {
    const entries = (await readdir(folder.path).catch(() => [])).filter((name) => name === folder.clone || name.startsWith(".BC.T_"));
    const paths = entries.map((name) => join(folder.path, name));

    await clearProtection([folder.path, ...paths]);

    for (const path of paths) await unlink(path).catch(() => undefined);

    try {
      await rmdir(folder.path);

      return;
    } catch (error) {
      failure.message = describeError(error);
    }
  }

  leftBehind(folder.path, "folder", failure.message, displayPath, notes);
}

/** Remove `path` (recursively; a symbolic link is removed itself): undefined once it is gone, else why not. */
async function removeIfAllowed(path: string): Promise<{ message: string; denied: boolean } | undefined> {
  try {
    await rm(path, REMOVE_OPTIONS);

    return undefined;
  } catch (error) {
    return { message: describeError(error), denied: isDenied(error) };
  }
}

/** Whether `folder.path` is still the folder made there, not anything put in its place since. */
async function isFolderMade(folder: TempFolder): Promise<boolean> {
  const stats = await lstat(folder.path).catch(() => undefined);

  return stats !== undefined && stats.isDirectory() && stats.dev === folder.dev && stats.ino === folder.ino;
}

/**
 * On macOS, clear the user-immutable and append-only flags and the ACL of each of `paths` (files and folders of this
 * process's own, so it may), each on its own: -h acts on a symbolic link itself, never on what it leads to, which
 * chmod -N does even with -R. Whether this was tried.
 */
async function clearProtection(paths: string[]): Promise<boolean> {
  if (process.platform !== "darwin") return false;

  await execFileAsync("/usr/bin/chflags", ["-h", "nouchg,nouappnd", ...paths]).catch(() => undefined);
  await execFileAsync("/bin/chmod", ["-h", "-N", ...paths]).catch(() => undefined);

  return true;
}

/** Report a temporary file or folder that could not be removed, and remember it (see leftoverFolders). */
function leftBehind(temp: string, kind: "file" | "folder", why: string, displayPath: string, notes: string[]): void {
  notes.push(
    `Note: ${besideFile(displayPath, basename(temp))}, a temporary ${kind} of this write, could not be removed (${why}). Tell the user; later writes in that folder change files in place instead.`,
  );

  const folder = dirname(temp);

  leftoverFolders.delete(folder);
  leftoverFolders.set(folder, temp);

  // A Map keeps insertion order: forget the folder remembered longest ago.
  if (leftoverFolders.size > MAX_LEFTOVER_FOLDERS) leftoverFolders.delete(leftoverFolders.keys().next().value!);
}

/** Whether `folder` is one where a temporary file or folder could not be removed, which is still there. */
async function keepsLeftovers(folder: string): Promise<boolean> {
  const leftover = leftoverFolders.get(folder);

  if (leftover === undefined) return false;

  // Only its being gone counts: a folder that cannot be searched now refuses the write anyway.
  if (await lstat(leftover).then(() => true, (error: unknown) => !isMissing(error))) return true;

  leftoverFolders.delete(folder);

  return false;
}

/** How messages name `name`, a file in the same folder as the one shown as `displayPath`. */
function besideFile(displayPath: string, name: string): string {
  const slash = displayPath.lastIndexOf("/");

  return slash === -1 ? name : `${displayPath.slice(0, slash + 1)}${name}`;
}

/**
 * Space a write leaves free on its disk, so a nearly full disk is refused up front, not half way through: 2% of the
 * disk, at least 1MB and at most 64MB. A fixed 64MB would refuse even a 4-byte edit on a small disk (a USB stick,
 * a RAM disk, a small partition).
 */
export function freeSpaceReserve(diskBytes: number): number {
  return Math.min(MAX_FREE_SPACE_RESERVE, Math.max(MIN_FREE_SPACE_RESERVE, Math.floor(diskBytes * 0.02)));
}

async function assertFreeSpace(
  folder: string,
  bytes: number,
  displayPath: string,
  exists: boolean,
  statfsOf: NonNullable<ReplaceOptions["statfs"]>,
): Promise<void> {
  const space = await statfsNearest(folder, statfsOf);

  // Unknown (an unusual file system, or one that reports no size at all): do not block the write over it.
  if (!space || space.blocks === 0) return;

  const free = space.bavail * space.bsize;

  if (free < bytes + freeSpaceReserve(space.blocks * space.bsize)) {
    throw new Error(
      `Not enough free space to write ${displayPath} (${formatSize(bytes)}): the disk is nearly full (${formatSize(free)} free); the file was not ${exists ? "changed" : "created"}. Tell the user.`,
    );
  }
}

/** statfs of the folder, or of its nearest existing parent while the folders of a new file do not exist yet. */
async function statfsNearest(
  folder: string,
  statfsOf: NonNullable<ReplaceOptions["statfs"]>,
): Promise<DiskSpace | undefined> {
  for (let current = folder; ; current = dirname(current)) {
    try {
      return await statfsOf(current);
    } catch (error) {
      if (!isMissing(error) || dirname(current) === current) return undefined;
    }
  }
}

async function createParents(path: string, displayPath: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    throw new Error(`Could not create the folder for ${displayPath} (${describeError(error)}). Nothing was written.`);
  }
}

/** A read-only file stays refused, as with a plain write; replacing it through a rename would get around that. */
async function assertWritable(path: string, displayPath: string): Promise<void> {
  try {
    await access(path, constants.W_OK);
  } catch (error) {
    throw new Error(`${displayPath} is not writable (${describeError(error)}). It was not changed.`);
  }
}

function assertUnchanged(current: Stats | undefined, expected: FileVersion, displayPath: string): void {
  if (
    current &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs
  ) return;

  throw new Error(`${displayPath} changed while it was being edited; read it again and retry.`);
}

/** Refuse folders, FIFOs, sockets, devices and symlinks, with the same wording read and edit use. */
export function assertRegularFile(stats: Stats, displayPath: string): void {
  if (stats.isFile()) return;

  if (stats.isDirectory()) throw new Error(`${displayPath} is a directory.`);

  throw new Error(`${displayPath} is ${describeKind(stats)}, not a regular file.`);
}

function describeKind(stats: Stats): string {
  if (stats.isFIFO()) return "a named pipe (FIFO)";

  if (stats.isSocket()) return "a socket";

  if (stats.isCharacterDevice()) return "a character device";

  if (stats.isBlockDevice()) return "a block device";

  if (stats.isSymbolicLink()) return "a symbolic link";

  return "a special file";
}

/** The old mode without setuid and setgid, which an in-place write by a non-root user clears as well. */
function keptMode(target: Stats): number {
  return target.mode & 0o1777;
}

function ownedByAnotherUser(target: Stats): boolean {
  return typeof process.getuid === "function" && target.uid !== process.getuid();
}

async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  return code === "EACCES" || code === "EPERM";
}

function isBusy(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EBUSY";
}

/** "ENOSPC: no space left on device" from a Node error, without the system call and paths after it. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return /^E[A-Z0-9]+: [^,]*/.exec(message)?.[0] ?? message;
}
