# flutter-project-mcp

An MCP (Model Context Protocol) server that scaffolds Flutter projects from your custom clean-architecture template. Any MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, etc.) can call it as a tool.

## What it does

Exposes three tools to AI agents:

| Tool | Description |
|---|---|
| `create_flutter_project` | Full 7-step project setup (clone template → git init → deps → l10n → flavors → config) |
| `list_flutter_projects` | Scan a directory for Flutter projects |
| `get_project_info` | Read pubspec, config, git status of an existing project |

### `create_flutter_project` parameters

| Parameter | Required | Description |
|---|---|---|
| `name` | ✅ | Dart package name (e.g. `telecom_app_enterprise`) |
| `org` | ✅ | Reverse-domain org (e.g. `mu.mt`) |
| `template` | | Template repo URL (defaults to your Bitbucket template) |
| `dir` | | Parent directory (defaults to cwd) |
| `dry_run` | | Preview without executing |

## Prerequisites

On the machine running this server you need:

- **Node.js** ≥ 18
- **fvm** (`dart pub global activate fvm`)
- **git**
- **Flutter** (managed via fvm)
- SSH key or credentials configured for your Bitbucket template repo

## Setup

```bash
# Clone / copy this folder, then:
cd flutter-project-mcp
npm install
npm run build
```

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "flutter-project": {
      "command": "node",
      "args": ["/absolute/path/to/flutter-project-mcp/dist/index.js"],
      "env": {
        "PATH": "/usr/local/bin:/usr/bin:/bin:/your/flutter/path"
      }
    }
  }
}
```

> **Tip:** Make sure `PATH` in `env` includes the directories where `fvm`, `git`, and `dart` live so the server can find them.

## Usage with Claude Code

```bash
claude mcp add flutter-project node /absolute/path/to/flutter-project-mcp/dist/index.js
```

## Usage with Cursor / other MCP clients

Consult your client's docs for adding stdio-based MCP servers. The command is:

```
node /absolute/path/to/flutter-project-mcp/dist/index.js
```

## Example interaction

Once connected, an agent can do:

> **You:** Create a new Flutter project called `logistics_app` for org `mu.mt`
>
> **Agent** calls `create_flutter_project` with `{ name: "logistics_app", org: "mu.mt" }` and gets back the full setup log + project path. Then it can open the project and start implementing features.

## Dry run

Pass `dry_run: true` to preview every command without executing anything — useful for the agent to confirm the plan before committing.

## Customisation

- **Template URL** — change `DEFAULT_TEMPLATE` in `src/index.ts` or pass it per-call.
- **Config file shape** — edit the `configJson()` helper to match your team's schema.
- **Extra steps** — add more steps (e.g. `build_runner`, `mason`, initial commit) by following the same pattern in the tool handler.
