# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server that scaffolds Flutter projects from a custom clean-architecture Bitbucket template. It exposes three tools to AI agents via stdio transport:

- **`create_flutter_project`** — Full 7-step project setup (install app_starter_plus → clone template → git init → deps → l10n → flavors → config files)
- **`list_flutter_projects`** — Scan a directory for Flutter projects (by finding pubspec.yaml)
- **`get_project_info`** — Read pubspec, config, fvm, and git status of an existing project

## Build & Run

```bash
npm install          # install deps
npm run build        # compile TypeScript → dist/
npm run dev          # watch mode (tsc --watch)
npm start            # run the server (node dist/index.js)
```

The compiled entry point is `dist/index.js`. The server communicates over stdio (stdin/stdout), not HTTP.

## Architecture

Single-file server in `src/index.ts` (~536 lines). Key sections:

- **FVM detection** (lines 29-47): At startup, detects whether `fvm` is on PATH. All Flutter/Dart commands are transparently prefixed with `fvm` when available, otherwise fall back to bare `flutter`/`dart`. The helpers `fvmCmd()` and `fvmArgs()` handle this.
- **`run()` helper** (lines 52-69): Async wrapper around `execFile` for shell commands. Returns combined stdout+stderr.
- **`runInteractive()` helper** (lines 82-112): Uses macOS `expect` to allocate a real PTY for commands that require a terminal (specifically `flutter_flavorizr` which uses `mason_logger`). Falls back to `CI=true TERM=dumb` if `expect` is unavailable.
- **MCP server setup** (lines 144-147): Uses `@modelcontextprotocol/sdk` `McpServer` class with `StdioServerTransport`.
- **Tool handlers**: Each tool is registered via `server.tool()` with Zod schemas for parameter validation.

## Key Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `zod` — Runtime parameter validation for tool inputs

## Runtime Prerequisites

The machine running this server needs: Node.js ≥ 18, git, Flutter (via `fvm` or direct), and SSH access to the Bitbucket template repo.

## Customisation Points

- `DEFAULT_TEMPLATE` constant — change the template repo URL
- `configJson()` function — change the shape of generated config files (dev/uat/prod)
- Add new steps by following the existing step pattern in the `create_flutter_project` handler (step number, dry_run branch, push to log)
