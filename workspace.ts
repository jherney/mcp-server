import { promises as fs } from "node:fs";
import path from "node:path";

/** Directories skipped by search and listing unless explicitly requested. */
const DEFAULT_IGNORES = new Set([".git", "node_modules", ".DS_Store", "dist", ".next", ".cache"]);

export class WorkspaceError extends Error {}

/**
 * All filesystem access goes through this class. Every path a client sends is
 * resolved against the workspace root and rejected if it escapes it, including
 * escapes via `..` segments, absolute paths, or symlinks pointing outside.
 */
export class Workspace {
  private constructor(
    readonly root: string,
    readonly maxReadBytes: number,
  ) {}

  static async open(root: string, maxReadBytes = 1024 * 1024): Promise<Workspace> {
    const resolved = await fs.realpath(path.resolve(root)).catch(() => {
      throw new WorkspaceError(`Workspace directory does not exist: ${root}`);
    });
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new WorkspaceError(`Workspace is not a directory: ${resolved}`);
    return new Workspace(resolved, maxReadBytes);
  }

  private isInside(p: string): boolean {
    const rel = path.relative(this.root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /**
   * Resolve a client-supplied path to an absolute path inside the workspace.
   * For paths that don't exist yet (e.g. a new file), the nearest existing
   * ancestor is checked via realpath so a symlinked parent can't escape.
   */
  async resolve(userPath: string): Promise<string> {
    const cleaned = userPath.replace(/^\/+/, "");
    const target = path.resolve(this.root, cleaned);
    if (!this.isInside(target)) throw new WorkspaceError(`Path is outside the workspace: ${userPath}`);

    let existing = target;
    const missing: string[] = [];
    for (;;) {
      try {
        const real = await fs.realpath(existing);
        if (!this.isInside(real)) throw new WorkspaceError(`Path is outside the workspace: ${userPath}`);
        return path.join(real, ...missing.reverse());
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        missing.push(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
  }

  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/") || ".";
  }

  async readFile(userPath: string): Promise<string> {
    const abs = await this.resolve(userPath);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new WorkspaceError(`${userPath} is a directory; use list_directory`);
    if (stat.size > this.maxReadBytes) {
      throw new WorkspaceError(`${userPath} is ${stat.size} bytes, over the ${this.maxReadBytes}-byte read limit`);
    }
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) throw new WorkspaceError(`${userPath} appears to be a binary file`);
    return buf.toString("utf-8");
  }

  async writeFile(userPath: string, content: string, overwrite: boolean): Promise<{ path: string; created: boolean }> {
    const abs = await this.resolve(userPath);
    let exists = false;
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) throw new WorkspaceError(`${userPath} is a directory`);
      exists = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (exists && !overwrite) {
      throw new WorkspaceError(`${userPath} already exists; pass overwrite: true to replace it`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    return { path: this.relative(abs), created: !exists };
  }

  async listDirectory(userPath: string): Promise<{ name: string; type: "file" | "directory" | "other"; size?: number }[]> {
    const abs = await this.resolve(userPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const out = await Promise.all(
      entries.map(async (e) => {
        const type = e.isDirectory() ? "directory" : e.isFile() ? "file" : "other";
        const size = e.isFile() ? (await fs.stat(path.join(abs, e.name))).size : undefined;
        return { name: e.name, type, size } as const;
      }),
    );
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
  }

  /**
   * Recursively find files whose workspace-relative path matches a glob
   * (`*` within a segment, `**` across segments, `?` one character).
   * A pattern without a slash matches against the file name alone.
   */
  async searchFiles(pattern: string, directory = ".", limit = 200, contentQuery?: string) {
    const start = await this.resolve(directory);
    const regex = globToRegExp(pattern);
    const matchName = !pattern.includes("/");
    const needle = contentQuery?.toLowerCase();
    const results: { path: string; line?: number; preview?: string }[] = [];
    let truncated = false;

    const walk = async (dir: string): Promise<void> => {
      if (truncated) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable directory: skip rather than fail the whole search
      }
      for (const e of entries) {
        if (truncated) return;
        if (DEFAULT_IGNORES.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!e.isFile()) continue;
        const rel = this.relative(abs);
        if (!regex.test(matchName ? e.name : rel)) continue;

        if (needle === undefined) {
          results.push({ path: rel });
        } else {
          const stat = await fs.stat(abs);
          if (stat.size > this.maxReadBytes) continue;
          const buf = await fs.readFile(abs);
          if (buf.includes(0)) continue;
          const lines = buf.toString("utf-8").split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              results.push({ path: rel, line: i + 1, preview: lines[i].trim().slice(0, 200) });
              if (results.length >= limit) break;
            }
          }
        }
        if (results.length >= limit) truncated = true;
      }
    };

    await walk(start);
    return { results, truncated };
  }

  async fileInfo(userPath: string) {
    const abs = await this.resolve(userPath);
    const stat = await fs.stat(abs);
    return {
      path: this.relative(abs),
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      size: stat.size,
      modified: stat.mtime.toISOString(),
      created: stat.birthtime.toISOString(),
    };
  }
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; bare `**` matches anything
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}
