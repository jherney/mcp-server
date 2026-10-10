# workspace-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI clients (Claude Desktop, Claude Code, Cursor, the MCP Inspector, etc.) sandboxed access to one directory on your machine.

## Tools

| Tool | What it does |
| --- | --- |
| `read_file` | Read a UTF-8 text file (1 MB limit by default; binary files are refused) |
| `list_directory` | List a directory's files and subdirectories |
| `search_files` | Find files by glob (`*.ts`, `src/**/*.tsx`), optionally only those containing some text, with matching lines |
| `get_file_info` | Type, size and timestamps |
| `write_file` | Create or replace a file; refuses to overwrite unless `overwrite: true`. Omitted in read-only mode |

## Resources

- `config://settings` — the running server's configuration
- `workspace:///{path}` — any text file in the workspace (top-level files are listed)

## Safety

Every path is resolved against the workspace root and rejected if it escapes, whether by `..`, an absolute path, or a symlink that points outside (checked with `realpath`, including for files that don't exist yet). Set `MCP_READ_ONLY=true` to remove `write_file` entirely.

## Setup

```bash
npm install
npm run build
npm test          # end-to-end tests over stdio
npm run inspect   # optional: try it in the MCP Inspector
```

## Configuration

| Setting | How | Default |
| --- | --- | --- |
| Workspace directory | first CLI argument, or `MCP_WORKSPACE` | current directory |
| Read-only | `MCP_READ_ONLY=true` | off |
| Read size limit | `MCP_MAX_READ_BYTES` | `1048576` |

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config), using absolute paths, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "workspace": {
      "command": "node",
      "args": ["/absolute/path/to/workspace-mcp-server/dist/index.js", "/absolute/path/to/your/project"],
      "env": { "MCP_READ_ONLY": "false" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add workspace -- node /absolute/path/to/workspace-mcp-server/dist/index.js /absolute/path/to/your/project
```

## Adding a tool

Register it in `src/index.ts` with `server.registerTool(name, { description, inputSchema, annotations }, handler)`. Put any filesystem access in `Workspace` (`src/workspace.ts`) so it goes through `resolve()`, and wrap the handler in `run()` so errors come back as readable tool errors instead of crashing the server.
