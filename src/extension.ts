// extension.ts — VS Code wiring: locate chatSessions, watch for changes,
// export Markdown into <workspace>/chat-history.
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exportSessionFile, exportAll, removeExportFor, ExportOptions } from "./exporter";

const OUTPUT_CHANNEL_NAME = "Chat History Saver";
const DEBOUNCE_MS = 3000; // wait for streaming to settle before re-exporting

let channel: vscode.OutputChannel | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let statusItem: vscode.StatusBarItem | undefined;
const timers = new Map<string, NodeJS.Timeout>();
let sessionsDir: string | undefined;
let outDir: string | undefined;

function log(msg: string): void {
  channel?.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function getOptions(): ExportOptions {
  const cfg = vscode.workspace.getConfiguration("chatHistorySaver");
  return {
    includeToolSummaries: cfg.get<boolean>("includeToolSummaries", true),
    includeThinking: cfg.get<boolean>("includeThinking", false),
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  };
}

/**
 * Locate the chatSessions folder for the current workspace.
 * Primary: derived from context.storageUri (workspaceStorage/<hash>/...).
 * Fallback: scan workspaceStorage for a workspace.json matching the open folder.
 */
function findSessionsDir(context: vscode.ExtensionContext): string | undefined {
  const candidates: string[] = [];

  if (context.storageUri) {
    const hashDir = path.dirname(context.storageUri.fsPath);
    candidates.push(path.join(hashDir, "chatSessions"));
  }

  const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const workspaceFile = vscode.workspace.workspaceFile;
  if (context.globalStorageUri) {
    const storageRoot = path.dirname(path.dirname(context.globalStorageUri.fsPath)); // .../workspaceStorage
    try {
      for (const entry of fs.readdirSync(storageRoot)) {
        const wj = path.join(storageRoot, entry, "workspace.json");
        try {
          const info = JSON.parse(fs.readFileSync(wj, "utf8"));
          const target = info.folder || info.workspace;
          if (!target) continue;
          if (
            (folderUri && decodeURIComponent(target) === decodeURIComponent(folderUri.toString())) ||
            (workspaceFile && decodeURIComponent(target) === decodeURIComponent(workspaceFile.toString()))
          ) {
            candidates.push(path.join(storageRoot, entry, "chatSessions"));
          }
        } catch {
          /* not a workspace.json we can read */
        }
      }
    } catch {
      /* storageRoot unreadable */
    }
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function updateStatus(savedCount: number): void {
  if (!statusItem) return;
  statusItem.text = `$(history) ${savedCount} chat${savedCount === 1 ? "" : "s"} saved`;
  statusItem.tooltip = "Chat History Saver — click to open the chat-history folder";
}

function doExportOne(sessionFile: string): void {
  if (!outDir) return;
  try {
    const result = exportSessionFile(sessionFile, outDir, getOptions());
    if (result) {
      log(`Saved ${path.basename(sessionFile)} -> ${path.basename(result)}`);
      countAndRefreshStatus();
    }
  } catch (err) {
    log(`ERROR exporting ${sessionFile}: ${err}`);
  }
}

function countAndRefreshStatus(): void {
  if (!outDir) return;
  try {
    const n = fs.readdirSync(outDir).filter((f) => f.endsWith(".md")).length;
    updateStatus(n);
  } catch {
    updateStatus(0);
  }
}

function scheduleExport(sessionFile: string): void {
  const existing = timers.get(sessionFile);
  if (existing) clearTimeout(existing);
  timers.set(
    sessionFile,
    setTimeout(() => {
      timers.delete(sessionFile);
      doExportOne(sessionFile);
    }, DEBOUNCE_MS)
  );
}

function setupWatcher(): void {
  watcher?.dispose();
  if (!sessionsDir) return;
  const pattern = new vscode.RelativePattern(vscode.Uri.file(sessionsDir), "*.{jsonl,json}");
  watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidCreate((uri) => {
    log(`New session file: ${uri.fsPath}`);
    scheduleExport(uri.fsPath);
  });
  watcher.onDidChange((uri) => scheduleExport(uri.fsPath));
  watcher.onDidDelete((uri) => {
    const sid = path.basename(uri.fsPath).replace(/\.(jsonl|json)$/, "");
    if (outDir && removeExportFor(sid, outDir)) {
      log(`Removed export for deleted session ${sid}`);
      countAndRefreshStatus();
    }
  });
}

function start(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("chatHistorySaver");
  const enabled = cfg.get<boolean>("enable", true);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!enabled) {
    log("Disabled via chatHistorySaver.enable setting.");
    return;
  }
  if (!workspaceRoot) {
    log("No workspace folder open — nothing to save into.");
    return;
  }

  sessionsDir = findSessionsDir(context);
  if (!sessionsDir) {
    log("Could not locate a chatSessions folder for this workspace yet. Will retry when chat sessions appear.");
    // Retry later: some sessions folders only appear after the first chat use.
    const retry = setTimeout(() => {
      sessionsDir = findSessionsDir(context);
      if (sessionsDir) {
        log(`Found chatSessions on retry: ${sessionsDir}`);
        setupWatcher();
        if (cfg.get<boolean>("exportOnStartup", true)) runExportAll();
      }
    }, 60_000);
    context.subscriptions.push({ dispose: () => clearTimeout(retry) });
    return;
  }

  const folderName = cfg.get<string>("outputFolder", "chat-history") || "chat-history";
  outDir = path.isAbsolute(folderName) ? folderName : path.join(workspaceRoot, folderName);
  log(`Watching ${sessionsDir}`);
  log(`Exporting to ${outDir}`);

  setupWatcher();

  if (cfg.get<boolean>("exportOnStartup", true)) {
    runExportAll();
  } else {
    countAndRefreshStatus();
  }
}

function runExportAll(): void {
  if (!sessionsDir || !outDir) return;
  // Run asynchronously so activation is never blocked
  setImmediate(() => {
    try {
      const n = exportAll(sessionsDir!, outDir!, getOptions());
      log(`Startup export complete: ${n} session(s) written/updated.`);
    } catch (err) {
      log(`ERROR during startup export: ${err}`);
    }
    countAndRefreshStatus();
  });
}

function stop(): void {
  watcher?.dispose();
  watcher = undefined;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

export function activate(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(channel);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "chatHistorySaver.openFolder";
  statusItem.show();
  context.subscriptions.push(statusItem);
  updateStatus(0);

  start(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("chatHistorySaver")) {
        log("Configuration changed — restarting.");
        stop();
        statusItem?.hide();
        start(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("chatHistorySaver.saveNow", async () => {
      if (!sessionsDir || !outDir) {
        // try to (re)locate
        start(context);
      }
      if (!sessionsDir || !outDir) {
        vscode.window.showWarningMessage(
          "Chat History Saver: no chat sessions found for this workspace yet. Start a chat conversation first."
        );
        return;
      }
      const n = exportAll(sessionsDir, outDir, getOptions());
      countAndRefreshStatus();
      vscode.window.showInformationMessage(
        n === 0
          ? `Chat History Saver: history is already up to date (${outDir}).`
          : `Chat History Saver: saved ${n} conversation(s) to ${path.basename(outDir)}/.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("chatHistorySaver.openFolder", async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const cfg = vscode.workspace.getConfiguration("chatHistorySaver");
      const folderName = cfg.get<string>("outputFolder", "chat-history") || "chat-history";
      const dir = outDir || (workspaceRoot ? path.join(workspaceRoot, folderName) : undefined);
      if (!dir || !fs.existsSync(dir)) {
        vscode.window.showWarningMessage("Chat History Saver: no chat-history folder exists yet.");
        return;
      }
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
    })
  );

  log("Chat History Saver activated.");
}

export function deactivate(): void {
  stop();
}
