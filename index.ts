#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Workspace, WorkspaceError } from "./workspace.js";

const SERVER_NAME = "workspace-mcp-server";
const SERVER_VERSION = "1.0.0";

// ---- Configuration -------------------------------------------------------
// Workspace root: first CLI argument, else MCP_WORKSPACE, else the current directory.
const config = {
  workspace: process.argv[2] ?? process.env.MCP_WORKSPACE ?? process.cwd(),
  readOnly: /^(1|true|yes)$/i.test(process.env.MCP_READ_ONLY ?? ""),
  maxReadBytes: Number(process.env.MCP_MAX_READ_BYTES ?? 1024 * 1024),
};

// ---- Helpers -------------------------------------------------------------
function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** Turn thrown errors into tool errors the model can read and recover from. */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message =
      err instanceof WorkspaceError
        ? err.message
        : code === "ENOENT"
          ? "No such file or directory"
          : code === "EACCES" || code === "EPERM"
            ? "Permission denied"
            : err instanceof Error
              ? err.message
              : String(err);
    return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
  }
}

function mimeFor(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown", json: "application/json", ts: "text/typescript", tsx: "text/typescript",
    js: "text/javascript", jsx: "text/javascript", html: "text/html", css: "text/css",
    py: "text/x-python", yml: "application/yaml", yaml: "application/yaml", csv: "text/csv",
  };
  return (ext && map[ext]) || "text/plain";
}

// ---- Server --------------------------------------------------------------
async function main() {
  const ws = await Workspace.open(config.workspace, config.maxReadBytes);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Tools for reading${config.readOnly ? "" : " and writing"} files in the workspace at ${ws.root}. ` +
        `All paths are relative to that directory. Use search_files to locate files before reading them.`,
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read a UTF-8 text file from the workspace. Paths are relative to the workspace root.",
      inputSchema: { path: z.string().describe("File path relative to the workspace root") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path }) => run(async () => ok(await ws.readFile(path))),
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description: "List the files and subdirectories in a workspace directory.",
      inputSchema: { path: z.string().default(".").describe("Directory relative to the workspace root") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path }) =>
      run(async () => {
        const entries = await ws.listDirectory(path);
        if (entries.length === 0) return ok("(empty directory)");
        return ok(
          entries
            .map((e) => (e.type === "directory" ? `[dir]  ${e.name}/` : `[file] ${e.name}${e.size !== undefined ? ` (${e.size} bytes)` : ""}`))
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description:
        "Find files by glob pattern, optionally only those containing some text. " +
        "A pattern without '/' matches file names (e.g. '*.ts'); with '/' it matches the relative path (e.g. 'src/**/*.tsx'). " +
        "Skips .git, node_modules and dist.",
      inputSchema: {
        pattern: z.string().default("*").describe("Glob: * within a name, ** across directories, ? one character"),
        directory: z.string().default(".").describe("Directory to search from, relative to the workspace root"),
        contains: z.string().optional().describe("Only return files containing this text (case-insensitive); results include matching lines"),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ pattern, directory, contains, limit }) =>
      run(async () => {
        const { results, truncated } = await ws.searchFiles(pattern, directory, limit, contains);
        if (results.length === 0) return ok("No matches.");
        const lines = results.map((r) => (r.line ? `${r.path}:${r.line}: ${r.preview}` : r.path));
        if (truncated) lines.push(`… stopped at ${limit} results; narrow the pattern or raise limit`);
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "get_file_info",
    {
      title: "Get file info",
      description: "Get the type, size and timestamps of a file or directory.",
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path }) => run(async () => ok(JSON.stringify(await ws.fileInfo(path), null, 2))),
  );

  if (!config.readOnly) {
    server.registerTool(
      "write_file",
      {
        title: "Write file",
        description:
          "Create or replace a UTF-8 text file in the workspace, creating parent directories as needed. " +
          "Refuses to replace an existing file unless overwrite is true.",
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root"),
          content: z.string(),
          overwrite: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      ({ path, content, overwrite }) =>
        run(async () => {
          const res = await ws.writeFile(path, content, overwrite);
          return ok(`${res.created ? "Created" : "Overwrote"} ${res.path} (${Buffer.byteLength(content)} bytes)`);
        }),
    );
  }

  // Resources ------------------------------------------------------------
  server.registerResource(
    "settings",
    "config://settings",
    { title: "Server settings", description: "The running server's configuration", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            { name: SERVER_NAME, version: SERVER_VERSION, workspace: ws.root, readOnly: config.readOnly, maxReadBytes: ws.maxReadBytes },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "workspace-file",
    new ResourceTemplate("workspace:///{+path}", {
      // Lets clients browse top-level files as resources without listing the whole tree.
      list: async () => {
        const entries = await ws.listDirectory(".");
        return {
          resources: entries
            .filter((e) => e.type === "file")
            .map((e) => ({ uri: `workspace:///${encodeURI(e.name)}`, name: e.name, mimeType: mimeFor(e.name) })),
        };
      },
    }),
    { title: "Workspace file", description: "A text file in the workspace" },
    async (uri, { path }) => {
      const rel = decodeURIComponent(Array.isArray(path) ? path.join("/") : path);
      return { contents: [{ uri: uri.href, mimeType: mimeFor(rel), text: await ws.readFile(rel) }] };
    },
  );

  await server.connect(new StdioServerTransport());
  // stdout carries the protocol, so all logging goes to stderr.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} serving ${ws.root}${config.readOnly ? " (read-only)" : ""}`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
