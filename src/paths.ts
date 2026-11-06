import { homedir } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class AccessDeniedError extends Error {
  override name = "AccessDeniedError";
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();

  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

/** True when `path` is `root` itself or lies below it (both must be absolute). */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);

  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Workspace-relative display path that always uses forward slashes. */
export function toDisplayPath(root: string, path: string): string {
  const rel = relative(root, path);

  return rel === "" ? "." : rel.split(sep).join("/");
}

/**
 * Resolve symlinks in the longest existing prefix of `path` and append the
 * missing tail unchanged, so not-yet-created files can still be checked.
 * A dangling symlink is refused: its target could point anywhere.
 */
export async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path);
  let candidate = absolute;

  for (;;) {
    try {
      const real = await realpath(candidate);
      const suffix = relative(candidate, absolute);

      return suffix ? resolve(real, suffix) : real;
    } catch (error) {
      if (!isMissing(error)) throw error;

      try {
        if ((await lstat(candidate)).isSymbolicLink()) {
          throw new AccessDeniedError(`Cannot resolve symbolic link: ${candidate}`);
        }
      } catch (lstatError) {
        if (!isMissing(lstatError)) throw lstatError;
      }

      const parent = dirname(candidate);

      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

/**
 * Resolve a user-supplied path against a workspace and make sure it stays
 * inside it, both lexically and after following symlinks.
 */
export async function resolveInside(
  root: string,
  canonicalRoot: string,
  input: string,
): Promise<string> {
  const absolute = resolve(root, expandHome(input));

  if (!isInside(absolute, root) && !isInside(absolute, canonicalRoot)) {
    throw new AccessDeniedError(`Path is outside the workspace: ${input}`);
  }

  const canonical = await canonicalize(absolute);

  if (!isInside(canonical, canonicalRoot)) {
    throw new AccessDeniedError(`Path is outside the workspace: ${input}`);
  }

  return canonical;
}

export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  return code === "ENOENT" || code === "ENOTDIR";
}
