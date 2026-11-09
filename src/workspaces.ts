import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJson, writeJsonPrivate } from "./config.ts";
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
 */
export class WorkspaceRegistry {
  readonly allowedRoots: string[];
  private readonly roots = new Map<string, string>();
  private readonly storeFile: string | undefined;

  constructor(allowedRoots: string[], stateDir?: string) {
    this.allowedRoots = allowedRoots.map((root) => resolve(expandHome(root)));
    this.storeFile = stateDir ? join(stateDir, "workspaces.json") : undefined;

    const saved = this.storeFile ? readJson<Record<string, string>>(this.storeFile) : undefined;

    for (const [id, root] of Object.entries(saved ?? {})) this.roots.set(id, root);
  }

  async open(input: string, create = false): Promise<Workspace> {
    const [firstRoot] = this.allowedRoots;

    if (!firstRoot) throw new Error("No allowed roots are configured.");

    // Relative paths are taken relative to the first allowed root.
    const root = resolve(firstRoot, expandHome(input.trim()));
    await this.assertAllowed(root, input);

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
    await this.assertAllowed(root, root);
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
  resolvePath(workspace: Workspace, path: string): Promise<string> {
    return resolveInside(workspace.root, workspace.canonicalRoot, path);
  }

  private async assertAllowed(path: string, input: string): Promise<void> {
    const denied = new AccessDeniedError(
      `Path is outside the allowed roots (${this.allowedRoots.join(", ")}): ${input}`,
    );

    if (!this.allowedRoots.some((root) => isInside(path, root))) throw denied;

    const canonical = await canonicalize(path);

    for (const root of this.allowedRoots) {
      const canonicalRoot = await realpath(root).catch(() => undefined);

      if (canonicalRoot && isInside(canonical, canonicalRoot)) return;
    }

    throw denied;
  }

  private save(): void {
    if (this.storeFile) writeJsonPrivate(this.storeFile, Object.fromEntries(this.roots));
  }
}
