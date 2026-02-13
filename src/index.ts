#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";

const execFileAsync = promisify(execFile);

// ─── Constants ─────────────────────────────────────────────────────
const DEFAULT_TEMPLATE =
  "https://bitbucket.org/mtinnovation/flutter_clean_template_2025";
const TOTAL_STEPS = 11;
const DART_PACKAGE_NAME_RE = /^[a-z][a-z0-9_]*$/;

// ─── Flutter runner abstraction ────────────────────────────────────
// Detects fvm at startup; every command goes through this so we
// transparently fall back to bare flutter/dart when fvm is absent.

let useFvm = false;

async function detectFvm(): Promise<boolean> {
  try {
    await execFileAsync("which", ["fvm"]);
    return true;
  } catch {
    return false;
  }
}

/** Prefix a command with `fvm` when available. */
function fvmCmd(cmd: string): string {
  return useFvm ? "fvm" : cmd;
}

function fvmArgs(cmd: string, args: string[]): string[] {
  return useFvm ? [cmd, ...args] : args;
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Run a command and return combined stdout + stderr. Throws on non-zero exit. */
async function run(
  command: string,
  args: string[],
  cwd?: string,
  extraEnv?: Record<string, string>
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  } catch (err: any) {
    const msg = err.stderr || err.stdout || err.message;
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${msg}`);
  }
}

/**
 * Run a command inside a real PTY using `expect` (pre-installed on macOS).
 *
 * mason_logger (used by flavorizr) calls `stdout.hasTerminal` and throws
 * if there's no TTY. Neither CI=true nor piping stdin fixes this reliably.
 *
 * `expect` spawns the process with a proper pseudo-terminal allocated by
 * the OS, so the child process sees a real TTY. It also automatically
 * answers any Y/n confirmation prompts.
 *
 * Falls back to CI=true + TERM=dumb if `expect` is not available.
 */
async function runInteractive(
  command: string,
  args: string[],
  cwd?: string
): Promise<string> {
  const fullCmd = [command, ...args]
    .map((a) => (a.includes(" ") ? `"${a}"` : a))
    .join(" ");

  // Strategy 1: Use `expect` to allocate a real PTY (available on macOS by default)
  const hasExpect = await commandExists("expect");
  if (hasExpect) {
    const expectScript = [
      "set timeout 300",
      `spawn ${fullCmd}`,
      "expect {",
      '  -re {\\(Y/n\\)|\\(y/N\\)|\\[Y/n\\]|\\[y/N\\]|proceed} { send "y\\r"; exp_continue }',
      "  timeout { exit 1 }",
      "  eof",
      "}",
      "lassign [wait] pid spawnid os_error_flag value",
      "exit $value",
    ].join("\n");

    return await run("expect", ["-c", expectScript], cwd);
  }

  // Strategy 2: CI=true + TERM=dumb (works with newer mason_logger versions)
  return await run(command, args, cwd, { CI: "true", TERM: "dumb" });
}

/** Checks that a command exists on PATH. */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** Format a step progress line. */
function stepMsg(n: number, msg: string): string {
  return `[${n}/${TOTAL_STEPS}] ${msg}`;
}

/** Convert a dart package name to a display name: my_super_app → My Super App */
function toDisplayName(pkg: string): string {
  return pkg
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Strip underscores from a dart package name for use in applicationId/bundleId */
function toAppId(pkg: string): string {
  return pkg.replace(/_/g, "");
}

// ─── Config file contents ──────────────────────────────────────────
function configJson(env: string): string {
  return JSON.stringify(
    {
      secretKey: env.toUpperCase(),
      baseUrl: "",
      xAPIKey: "",
      oneSignalKey: "",
    },
    null,
    2
  );
}

// ─── MCP Server ────────────────────────────────────────────────────
const server = new McpServer({
  name: "MTDevKit",
  version: "1.0.0",
});

// ─── Prompts (show as /slash commands in Cursor) ──────────────────

server.prompt(
  "create-flutter-project",
  "Scaffold a new Flutter project from the MT clean-architecture template",
  {
    name: z
      .string()
      .describe("Dart/Flutter project name, e.g. telecom_app_enterprise"),
    org: z
      .string()
      .describe("Organisation identifier in reverse-domain, e.g. mu.mt"),
  },
  ({ name, org }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Create a new Flutter project with name "${name}" and org "${org}". Use the create_flutter_project tool with dry_run=true first to preview the plan, then run it for real.`,
        },
      },
    ],
  })
);

server.prompt(
  "list-flutter-projects",
  "List all Flutter projects in a directory",
  {
    dir: z
      .string()
      .optional()
      .describe("Directory to scan (default: current working directory)"),
  },
  ({ dir }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `List all Flutter projects${dir ? ` in "${dir}"` : " in the current directory"}. Use the list_flutter_projects tool.`,
        },
      },
    ],
  })
);

server.prompt(
  "project-info",
  "Get details about an existing Flutter project",
  {
    path: z.string().describe("Absolute path to the Flutter project root"),
  },
  ({ path }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Get detailed info about the Flutter project at "${path}". Use the get_project_info tool.`,
        },
      },
    ],
  })
);

// ── Tool: create_flutter_project ───────────────────────────────────
server.tool(
  "create_flutter_project",
  `Scaffold a new Flutter project from the custom clean-architecture template.

Runs the full 11-step setup:
  1. Install/update app_starter_plus
  2. Clone template & rename project
  3. Initialise Git (+ hooks if present)
  4. Install Flutter dependencies
  5. Generate localisations
  6. Update flavorizr.yaml with project name & org
  7. Commit all files before flavorizr
  8. Generate flavors (flavorizr)
  9. Revert main.dart & app.dart (overwritten by flavorizr)
  10. Create config files (dev / uat / prod)
  11. Configure Android build (desugaring, HMS, ProGuard)

Automatically detects fvm; falls back to plain flutter/dart if fvm is not installed.
Returns the absolute path to the ready-to-develop project.

NOTE: This tool does NOT ask for confirmation — it runs immediately.
Use dry_run=true first if you want to preview the plan before executing.`,
  {
    name: z
      .string()
      .regex(
        DART_PACKAGE_NAME_RE,
        "Must be lowercase, start with a letter, contain only [a-z0-9_]"
      )
      .describe("Dart/Flutter project name, e.g. telecom_app_enterprise"),
    org: z
      .string()
      .min(1)
      .describe("Organisation identifier in reverse-domain, e.g. mu.mt"),
    template: z
      .string()
      .url()
      .optional()
      .describe(`Template repo URL (default: ${DEFAULT_TEMPLATE})`),
    dir: z
      .string()
      .optional()
      .describe(
        "Parent directory to create the project in (default: current working directory)"
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "If true, report what would happen without executing anything"
      ),
  },
  async ({ name, org, template, dir, dry_run }) => {
    const templateUrl = template ?? DEFAULT_TEMPLATE;
    const parentDir = resolve(dir ?? process.cwd());
    const projectDir = join(parentDir, name);
    const dryRun = dry_run ?? false;
    const log: string[] = [];

    const push = (msg: string) => log.push(msg);

    try {
      // ── Detect tooling ───────────────────────────────────────
      useFvm = await detectFvm();
      const hasGit = await commandExists("git");
      const runner = useFvm ? "fvm" : "flutter/dart (fvm not found)";

      push(`Project:  ${name}`);
      push(`Org:      ${org}`);
      push(`Template: ${templateUrl}`);
      push(`Location: ${projectDir}`);
      push(`Runner:   ${runner}`);
      if (dryRun) push("Mode:     DRY RUN\n");

      // ── Pre-flight checks ────────────────────────────────────
      if (!dryRun) {
        if (!useFvm && !(await commandExists("flutter"))) {
          throw new Error(
            "Neither fvm nor flutter found on PATH. Install Flutter or fvm first."
          );
        }
        if (!hasGit) throw new Error("git is not installed.");
        if (existsSync(projectDir))
          throw new Error(
            `Directory '${projectDir}' already exists. Remove it or choose a different name.`
          );
      } else {
        push(
          `[pre-flight] Would verify: flutter/fvm, git installed; ${projectDir} does not exist`
        );
      }

      // ── Step 1: Install app_starter_plus ─────────────────────
      push(stepMsg(1, "Installing app_starter_plus"));
      if (dryRun) {
        push(
          `  [dry-run] ${fvmCmd("dart")} ${fvmArgs("dart", ["pub", "global", "activate", "app_starter_plus"]).join(" ")}`
        );
      } else {
        await run(
          fvmCmd("dart"),
          fvmArgs("dart", [
            "pub",
            "global",
            "activate",
            "app_starter_plus",
          ])
        );
      }
      push("✔ app_starter_plus ready");

      // ── Step 2: Clone template ───────────────────────────────
      push(stepMsg(2, `Cloning template into ${name}`));
      const starterArgs = fvmArgs("dart", [
        "pub",
        "global",
        "run",
        "app_starter_plus:app_starter_plus",
        "--name",
        name,
        "--org",
        org,
        "--template",
        templateUrl,
        ...(useFvm ? ["--fvm"] : []),
      ]);
      if (dryRun) {
        push(`  [dry-run] ${fvmCmd("dart")} ${starterArgs.join(" ")}`);
      } else {
        await run(fvmCmd("dart"), starterArgs, parentDir);
      }
      push("✔ Template cloned");

      // ── Step 3: Git init ─────────────────────────────────────
      push(stepMsg(3, "Initialising Git repository"));
      if (dryRun) {
        push("  [dry-run] git init (if .git/ does not exist)");
        push(
          "  [dry-run] git config core.hooksPath .githooks/ (if .githooks/ exists)"
        );
      } else {
        if (!existsSync(join(projectDir, ".git"))) {
          await run("git", ["init"], projectDir);
          push("✔ Git repository initialised");
        } else {
          push("✔ Git repository already exists");
        }

        if (existsSync(join(projectDir, ".githooks"))) {
          await run(
            "git",
            ["config", "core.hooksPath", ".githooks/"],
            projectDir
          );
          push("✔ Git hooks configured (.githooks/)");
        } else {
          push("⚠ No .githooks/ directory found — skipping hook setup");
        }
      }

      // ── Step 4: Install dependencies ─────────────────────────
      push(stepMsg(4, "Installing Flutter dependencies"));
      if (dryRun) {
        push(
          `  [dry-run] ${fvmCmd("flutter")} ${fvmArgs("flutter", ["pub", "get"]).join(" ")}`
        );
      } else {
        await run(
          fvmCmd("flutter"),
          fvmArgs("flutter", ["pub", "get"]),
          projectDir
        );
      }
      push("✔ Dependencies installed");

      // ── Step 5: Generate localisations ───────────────────────
      push(stepMsg(5, "Generating localisations"));
      if (dryRun) {
        push(
          `  [dry-run] ${fvmCmd("flutter")} ${fvmArgs("flutter", ["gen-l10n"]).join(" ")}`
        );
      } else {
        await run(
          fvmCmd("flutter"),
          fvmArgs("flutter", ["gen-l10n"]),
          projectDir
        );
      }
      push("✔ Localisations generated");

      // ── Step 6: Update flavorizr.yaml ───────────────────────
      push(stepMsg(6, "Updating flavorizr.yaml"));
      if (dryRun) {
        push("  [dry-run] Update flavorizr.yaml with project name & org");
      } else {
        const flavorizrPath = join(projectDir, "flavorizr.yaml");
        if (!existsSync(flavorizrPath)) {
          throw new Error(`flavorizr.yaml not found at ${flavorizrPath}`);
        }

        const displayName = toDisplayName(name);
        const appId = toAppId(name);
        const flavorizrContent = `flavors:
  dev:
    app:
      name: "[DEV] ${displayName}"
    android:
      applicationId: "${org}.${appId}.dev"
    ios:
      bundleId: "${org}.${appId}.dev"
  prod:
    app:
      name: "${displayName}"
    android:
      applicationId: "${org}.${appId}"
    ios:
      bundleId: "${org}.${appId}"
  uat:
    app:
      name: "[UAT] ${displayName}"
    android:
      applicationId: "${org}.${appId}.uat"
    ios:
      bundleId: "${org}.${appId}.uat"
`;
        writeFileSync(flavorizrPath, flavorizrContent);
      }
      push("✔ flavorizr.yaml updated");

      // ── Step 7: Commit all files before flavorizr ───────────
      push(stepMsg(7, "Committing all files before flavorizr"));
      if (dryRun) {
        push("  [dry-run] git add -A && git commit");
      } else {
        await run("git", ["add", "-A"], projectDir);
        await run(
          "git",
          ["commit", "-m", "Initial project setup before flavorizr"],
          projectDir
        );
      }
      push("✔ All files committed");

      // ── Step 8: Generate flavors (needs PTY) ─────────────────
      push(stepMsg(8, "Generating flavors (flavorizr)"));
      if (dryRun) {
        push(
          `  [dry-run] ${fvmCmd("flutter")} ${fvmArgs("flutter", ["pub", "run", "flutter_flavorizr"]).join(" ")}`
        );
        push("  [dry-run] (will use expect for PTY allocation)");
      } else {
        await runInteractive(
          fvmCmd("flutter"),
          fvmArgs("flutter", ["pub", "run", "flutter_flavorizr"]),
          projectDir
        );
      }
      push("✔ Flavors generated");

      // ── Step 9: Revert main.dart & app.dart ─────────────────
      push(stepMsg(9, "Reverting main.dart & app.dart (overwritten by flavorizr)"));
      if (dryRun) {
        push("  [dry-run] git checkout -- lib/main.dart lib/app.dart");
      } else {
        await run(
          "git",
          ["checkout", "--", "lib/main.dart", "lib/app.dart"],
          projectDir
        );
      }
      push("✔ main.dart & app.dart reverted");

      // ── Step 10: Create config files ─────────────────────────
      push(stepMsg(10, "Creating config files"));
      if (dryRun) {
        push("  [dry-run] mkdir -p config");
        push("  [dry-run] Write config/app_config_{dev,prod,uat}.json");
      } else {
        const configDir = join(projectDir, "config");
        mkdirSync(configDir, { recursive: true });

        for (const env of ["dev", "prod", "uat"]) {
          writeFileSync(
            join(configDir, `app_config_${env}.json`),
            configJson(env) + "\n"
          );
        }
      }
      push("✔ Config files created (config/app_config_{dev,prod,uat}.json)");

      // ── Step 11: Configure Android build ─────────────────────
      push(stepMsg(11, "Configuring Android build (desugaring, HMS, ProGuard)"));
      if (dryRun) {
        push("  [dry-run] Patch android/app/build.gradle.kts (compileOptions, buildTypes, dependencies)");
        push("  [dry-run] Create android/app/proguard-rules.pro");
      } else {
        const gradlePath = join(projectDir, "android", "app", "build.gradle.kts");
        if (!existsSync(gradlePath)) {
          throw new Error(`android/app/build.gradle.kts not found at ${gradlePath}`);
        }

        let gradle = readFileSync(gradlePath, "utf-8");

        // 8a. Add isCoreLibraryDesugaringEnabled inside compileOptions
        gradle = gradle.replace(
          /compileOptions\s*\{/,
          "compileOptions {\n        isCoreLibraryDesugaringEnabled = true"
        );

        // 8b. Replace buildTypes block
        gradle = gradle.replace(
          /buildTypes\s*\{[\s\S]*?\n    \}/,
          `buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android.txt"),
                "proguard-rules.pro"
            )
        }
    }`
        );

        // 8c. Append dependencies block at the end
        gradle =
          gradle.trimEnd() +
          "\n\ndependencies {\n" +
          '    implementation("com.huawei.hms:push:6.11.0.300")\n' +
          '    implementation("androidx.multidex:multidex:2.0.1")\n' +
          '    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")\n' +
          "}\n";

        writeFileSync(gradlePath, gradle);
        push("✔ android/app/build.gradle.kts updated (desugaring, buildTypes, dependencies)");

        // 8d. Create proguard-rules.pro
        const proguardPath = join(projectDir, "android", "app", "proguard-rules.pro");
        const proguardContent = `-ignorewarnings
-keepattributes *Annotation*
-keepattributes Exceptions
-keepattributes InnerClasses
-keepattributes Signature
-keep class com.hianalytics.android.**{*;}
-keep class com.huawei.updatesdk.**{*;}
-keep class com.huawei.hms.**{*;}

## Flutter wrapper
-keep class io.flutter.app.** { *; }
-keep class io.flutter.plugin.**  { *; }
-keep class io.flutter.util.**  { *; }
-keep class io.flutter.view.**  { *; }
-keep class io.flutter.**  { *; }
-keep class io.flutter.plugins.**  { *; }
-dontwarn io.flutter.embedding.**
-keep class com.huawei.hms.flutter.** { *; }
-keep class androidx.lifecycle.DefaultLifecycleObserver
-repackageclasses
`;
        writeFileSync(proguardPath, proguardContent);
        push("✔ android/app/proguard-rules.pro created");
      }

      // ── Done ─────────────────────────────────────────────────
      if (dryRun) {
        push("\n── Dry run complete! No changes were made. ──");
      } else {
        push(`\n── Setup complete! ──`);
        push(`Project location: ${projectDir}`);
        push(`\nNext steps:`);
        push(`  1. Fill in config/app_config_*.json with your API keys`);
        push(`  2. Open ${projectDir} in your IDE and start building`);
      }

      return {
        content: [{ type: "text", text: log.join("\n") }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ Setup failed:\n${err.message}\n\nProgress so far:\n${log.join("\n")}`,
          },
        ],
      };
    }
  }
);

// ── Tool: list_flutter_projects ────────────────────────────────────
server.tool(
  "list_flutter_projects",
  "List Flutter projects in a given directory (looks for pubspec.yaml).",
  {
    dir: z
      .string()
      .optional()
      .describe("Directory to scan (default: current working directory)"),
  },
  async ({ dir }) => {
    const scanDir = resolve(dir ?? process.cwd());

    if (!existsSync(scanDir)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Directory not found: ${scanDir}` }],
      };
    }

    const entries = readdirSync(scanDir, { withFileTypes: true });
    const projects: string[] = [];

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        existsSync(join(scanDir, entry.name, "pubspec.yaml"))
      ) {
        projects.push(entry.name);
      }
    }

    if (projects.length === 0) {
      return {
        content: [
          { type: "text", text: `No Flutter projects found in ${scanDir}` },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Flutter projects in ${scanDir}:\n${projects.map((p) => `  • ${p}`).join("\n")}`,
        },
      ],
    };
  }
);

// ── Tool: get_project_info ─────────────────────────────────────────
server.tool(
  "get_project_info",
  "Get details about an existing Flutter project (pubspec, flavors, config files, etc.).",
  {
    path: z.string().describe("Absolute path to the Flutter project root"),
  },
  async ({ path: projectPath }) => {
    const absPath = resolve(projectPath);

    if (!existsSync(absPath)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Project not found: ${absPath}` }],
      };
    }

    const info: string[] = [`Project: ${absPath}\n`];

    // pubspec.yaml
    const pubspecPath = join(absPath, "pubspec.yaml");
    if (existsSync(pubspecPath)) {
      const pubspec = readFileSync(pubspecPath, "utf-8");
      const nameMatch = pubspec.match(/^name:\s*(.+)$/m);
      const versionMatch = pubspec.match(/^version:\s*(.+)$/m);
      const descMatch = pubspec.match(/^description:\s*(.+)$/m);
      info.push(`Name:        ${nameMatch?.[1] ?? "unknown"}`);
      info.push(`Version:     ${versionMatch?.[1] ?? "unknown"}`);
      info.push(`Description: ${descMatch?.[1] ?? "—"}`);
    } else {
      info.push("⚠ No pubspec.yaml found — may not be a Flutter project");
    }

    // FVM config
    const fvmPath = join(absPath, ".fvmrc");
    if (existsSync(fvmPath)) {
      const fvm = readFileSync(fvmPath, "utf-8");
      info.push(`FVM config:  ${fvm.trim()}`);
    }

    // Config files
    const configDir = join(absPath, "config");
    if (existsSync(configDir)) {
      const configs = readdirSync(configDir).filter((f) =>
        f.endsWith(".json")
      );
      info.push(`\nConfig files (${configs.length}):`);
      for (const c of configs) {
        info.push(`  • config/${c}`);
      }
    }

    // Git status
    if (existsSync(join(absPath, ".git"))) {
      try {
        const branch = await run(
          "git",
          ["branch", "--show-current"],
          absPath
        );
        info.push(`\nGit branch:  ${branch}`);
      } catch {
        info.push("\nGit:         initialised (could not read branch)");
      }
    } else {
      info.push("\nGit:         not initialised");
    }

    return {
      content: [{ type: "text", text: info.join("\n") }],
    };
  }
);

// ─── Start ─────────────────────────────────────────────────────────
async function main() {
  useFvm = await detectFvm();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `MTDevKit server running on stdio (fvm: ${useFvm ? "yes" : "no — using plain flutter/dart"})`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
