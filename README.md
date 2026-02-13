# MTDevKit

An MCP (Model Context Protocol) server that scaffolds Flutter projects from a custom clean-architecture Bitbucket template. Any MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, etc.) can call it as a tool.

## What it does

### Tools

| Tool                     | Description                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `create_flutter_project` | Full 11-step project setup (clone template → git init → deps → l10n → flavorizr → config → Android) |
| `list_flutter_projects`  | Scan a directory for Flutter projects                                                               |
| `get_project_info`       | Read pubspec, config, git status of an existing project                                             |

### Slash commands (prompts)

These show up when you type `/` in Cursor or other MCP clients:

| Command                   | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `/create-flutter-project` | Scaffold a new Flutter project from the MT template |
| `/list-flutter-projects`  | List all Flutter projects in a directory            |
| `/project-info`           | Get details about an existing Flutter project       |

### `create_flutter_project` steps

1. Install/update `app_starter_plus`
2. Clone template & rename project
3. Initialise Git (+ hooks if present)
4. Install Flutter dependencies
5. Generate localisations
6. Update `flavorizr.yaml` with project name & org
7. Commit all files before flavorizr
8. Generate flavors (flavorizr)
9. Revert `main.dart` & `app.dart` (overwritten by flavorizr)
10. Create config files (dev / uat / prod)
11. Configure Android build (desugaring, HMS, ProGuard)

### `create_flutter_project` parameters

| Parameter  | Required | Description                                        |
| ---------- | -------- | -------------------------------------------------- |
| `name`     | Yes      | Dart package name (e.g. `my_super_app`)            |
| `org`      | Yes      | Reverse-domain org (e.g. `mu.mt`)                  |
| `template` |          | Template repo URL (defaults to Bitbucket template) |
| `dir`      |          | Parent directory (defaults to cwd)                 |
| `dry_run`  |          | Preview without executing                          |

## Prerequisites

- **Node.js** >= 18
- **git**
- **Flutter** (via `fvm` or direct — fvm is auto-detected)
- SSH key or credentials configured for your Bitbucket template repo

## Install

### Option 1: via npm (GitHub Packages)

```bash
npx -y @stephangopaul/mtdevkit --registry=https://npm.pkg.github.com
```

### Option 2: from source

```bash
git clone https://github.com/stephangopaul/MTDevKit.git
cd MTDevKit
npm install
npm run build
```

## Usage with Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "MTDevKit": {
      "command": "npx",
      "args": [
        "-y",
        "@stephangopaul/mtdevkit",
        "--registry=https://npm.pkg.github.com"
      ]
    }
  }
}
```

Or if running from source:

```json
{
  "mcpServers": {
    "MTDevKit": {
      "command": "node",
      "args": ["/path/to/MTDevKit/dist/index.js"]
    }
  }
}
```

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "MTDevKit": {
      "command": "npx",
      "args": [
        "-y",
        "@stephangopaul/mtdevkit",
        "--registry=https://npm.pkg.github.com"
      ],
      "env": {
        "PATH": "/usr/local/bin:/usr/bin:/bin:/your/flutter/path"
      }
    }
  }
}
```

> **Tip:** Make sure `PATH` in `env` includes the directories where `fvm`, `git`, and `dart` live.

## Usage with Claude Code

```bash
claude mcp add MTDevKit -- npx -y @stephangopaul/mtdevkit --registry=https://npm.pkg.github.com
```

## Example interaction

> **You:** Create a new Flutter project called `logistics_app` for org `mu.mt`
>
> **Agent** calls `create_flutter_project` with `{ name: "logistics_app", org: "mu.mt" }` and returns the full setup log + project path.

## Dry run

Pass `dry_run: true` to preview every command without executing anything — useful for confirming the plan before committing.

## Customisation

- **Template URL** — change `DEFAULT_TEMPLATE` in `src/index.ts` or pass it per-call
- **Config file shape** — edit the `configJson()` helper to match your team's schema
- **Extra steps** — add more steps by following the existing pattern in the tool handler
