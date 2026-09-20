// exporter.ts — turn parsed sessions into clean Markdown files.
// Pure Node (fs/path only) — no vscode dependency.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ParsedSession, ParsedRequest, FileTouch, parseSessionFile } from "./sessionParser";

export interface ExportOptions {
  includeToolSummaries: boolean;
  includeThinking: boolean;
  /** Workspace root used to relativize file paths. */
  workspaceRoot?: string;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dateStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "untitled"
  );
}

function displayPath(p: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    const rel = path.relative(workspaceRoot, p);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  const home = os.homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function sessionFiles(s: ParsedSession): FileTouch[] {
  const merged: FileTouch[] = [];
  for (const r of s.requests) {
    for (const f of r.files) {
      const existing = merged.find((m) => m.path === f.path);
      const rank = { created: 3, edited: 2, referenced: 1 } as const;
      if (!existing) merged.push({ ...f });
      else if (rank[f.kind] > rank[existing.kind]) existing.kind = f.kind;
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Markdown generation                                                 */
/* ------------------------------------------------------------------ */

function renderRequest(req: ParsedRequest, index: number, opts: ExportOptions): string {
  const out: string[] = [];
  const ws = opts.workspaceRoot;

  out.push(`## Turn ${index + 1} — 👤 User · ${fmtDate(req.timestamp)}`);
  out.push("");
  out.push(req.userText.trim() || "_(empty message)_");
  out.push("");

  const meta: string[] = [];
  if (req.agentName) meta.push(`**Agent:** ${req.agentName}`);
  if (req.modelId) meta.push(`**Model:** \`${req.modelId}\``);
  if (req.elapsedMs) meta.push(`**Duration:** ${Math.round(req.elapsedMs / 1000)}s`);
  if (req.promptTokens || req.completionTokens) {
    meta.push(`**Tokens:** ${req.promptTokens ?? "?"} in / ${req.completionTokens ?? "?"} out`);
  }
  if (meta.length) {
    out.push(`> ${meta.join(" · ")}`);
    out.push("");
  }

  if (req.skills.length) {
    out.push(`> 🎯 **Skills:** ${dedupe(req.skills).map((s) => `\`${s}\``).join(", ")}`);
  }
  if (req.subagents.length) {
    out.push(`> 🤖 **Subagents:** ${dedupe(req.subagents).map((s) => `\`${s}\``).join(", ")}`);
  }
  if (req.skills.length || req.subagents.length) out.push("");

  out.push(`### 🤖 Assistant`);
  out.push("");
  const md = req.assistantMarkdown.join("").trim();
  out.push(md || "_(no text response)_");
  out.push("");

  if (opts.includeThinking && req.thinking.length) {
    out.push("<details>");
    out.push(`<summary>🧠 Thinking (${req.thinking.length} blocks)</summary>`);
    out.push("");
    for (const t of req.thinking) {
      out.push(...t.split("\n").map((line) => `> ${line}`));
      out.push(">");
    }
    out.push("");
    out.push("</details>");
    out.push("");
  }

  const touched = req.files.filter((f) => f.kind !== "referenced");
  const referenced = req.files.filter((f) => f.kind === "referenced");
  if (touched.length) {
    out.push(`> 📁 **Files ${touched.some((f) => f.kind === "created") ? "created/modified" : "modified"}:**`);
    for (const f of touched) {
      out.push(`> - ${f.kind === "created" ? "🆕 created" : "✏️ edited"} \`${displayPath(f.path, ws)}\``);
    }
    out.push("");
  }
  if (referenced.length) {
    out.push(`> 📖 **Files read/referenced:** ${referenced.map((f) => `\`${displayPath(f.path, ws)}\``).join(", ")}`);
    out.push("");
  }

  if (opts.includeToolSummaries && req.toolSummaries.length) {
    const shown = req.toolSummaries.slice(0, 30);
    out.push("<details>");
    out.push(`<summary>🛠️ Tools used (${req.toolSummaries.length})</summary>`);
    out.push("");
    for (const t of shown) out.push(`- ${t}`);
    if (req.toolSummaries.length > shown.length) {
      out.push(`- …and ${req.toolSummaries.length - shown.length} more`);
    }
    out.push("");
    out.push("</details>");
    out.push("");
  }

  if (req.questions.length) {
    out.push(`> ❓ **Questions asked:** ${req.questions.map((q) => `_${q}_`).join("; ")}`);
    out.push("");
  }

  out.push("---");
  out.push("");
  return out.join("\n");
}

export function sessionToMarkdown(s: ParsedSession, opts: ExportOptions): string {
  const ws = opts.workspaceRoot;
  const files = sessionFiles(s);
  const allSkills = dedupe(s.requests.flatMap((r) => r.skills));
  const allSubagents = dedupe(s.requests.flatMap((r) => r.subagents));
  const allAgents = dedupe(s.requests.map((r) => r.agentName).filter((a): a is string => !!a));
  const allModels = dedupe(s.requests.map((r) => r.modelId).filter((m): m is string => !!m));

  const out: string[] = [];
  out.push("---");
  out.push(`title: ${yamlString(s.title)}`);
  out.push(`session: ${s.sessionId}`);
  out.push(`created: ${fmtDate(s.creationDate)}`);
  out.push(`lastUpdated: ${fmtDate(s.lastMessageDate)}`);
  if (allAgents.length) out.push(`agents: [${allAgents.map(yamlString).join(", ")}]`);
  if (allModels.length) out.push(`models: [${allModels.map(yamlString).join(", ")}]`);
  if (allSkills.length) out.push(`skills: [${allSkills.map(yamlString).join(", ")}]`);
  if (allSubagents.length) out.push(`subagents: [${allSubagents.map(yamlString).join(", ")}]`);
  if (files.length) {
    out.push("filesTouched:");
    for (const f of files) {
      out.push(`  - ${yamlString(displayPath(f.path, ws))} # ${f.kind}`);
    }
  }
  out.push("---");
  out.push("");
  out.push(`# ${s.title}`);
  out.push("");
  out.push(`> 🗓️ ${fmtDate(s.creationDate)} → ${fmtDate(s.lastMessageDate)} · ${s.requests.length} turn(s)` +
    (allSkills.length ? ` · 🎯 ${allSkills.join(", ")}` : "") +
    (allSubagents.length ? ` · 🤖 subagents: ${allSubagents.join(", ")}` : ""));
  out.push("");
  out.push("---");
  out.push("");

  s.requests.forEach((r, i) => out.push(renderRequest(r, i, opts)));

  // Session summary
  out.push("## 📋 Session summary");
  out.push("");
  out.push(`- **Turns:** ${s.requests.length}`);
  if (allAgents.length) out.push(`- **Agents:** ${allAgents.join(", ")}`);
  if (allModels.length) out.push(`- **Models:** ${allModels.map((m) => `\`${m}\``).join(", ")}`);
  if (allSkills.length) out.push(`- **Skills used:** ${allSkills.map((sk) => `\`${sk}\``).join(", ")}`);
  if (allSubagents.length) out.push(`- **Subagents used:** ${allSubagents.map((a) => `\`${a}\``).join(", ")}`);
  const totalIn = s.requests.reduce((a, r) => a + (r.promptTokens || 0), 0);
  const totalOut = s.requests.reduce((a, r) => a + (r.completionTokens || 0), 0);
  if (totalIn || totalOut) out.push(`- **Tokens:** ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out`);
  if (files.length) {
    out.push(`- **Files touched (${files.length}):**`);
    for (const f of files) {
      const icon = f.kind === "created" ? "🆕" : f.kind === "edited" ? "✏️" : "📖";
      out.push(`  - ${icon} \`${displayPath(f.path, ws)}\` (${f.kind})`);
    }
  }
  out.push("");
  out.push("_Saved automatically by Chat History Saver._");
  out.push("");
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* File output                                                         */
/* ------------------------------------------------------------------ */

function outputFileName(s: ParsedSession): string {
  return `${dateStamp(s.creationDate)}-${slugify(s.title)}-${s.sessionId.slice(0, 8)}.md`;
}

/**
 * Export one session file to outDir. Returns the output path, or null if the
 * session was skipped (empty) or the content was unchanged.
 */
export function exportSessionFile(sessionFilePath: string, outDir: string, opts: ExportOptions): string | null {
  const session = parseSessionFile(sessionFilePath);
  if (!session || !session.requests.some((r) => r.userText.trim() || r.assistantMarkdown.length)) {
    return null;
  }
  fs.mkdirSync(outDir, { recursive: true });

  // Remove stale files from previous exports of the same session (title may change)
  const sid8 = session.sessionId.slice(0, 8);
  const newName = outputFileName(session);
  try {
    for (const existing of fs.readdirSync(outDir)) {
      if (existing.endsWith(`-${sid8}.md`) && existing !== newName) {
        fs.unlinkSync(path.join(outDir, existing));
      }
    }
  } catch {
    /* ignore */
  }

  const content = sessionToMarkdown(session, opts);
  const outPath = path.join(outDir, newName);
  try {
    const prev = fs.readFileSync(outPath, "utf8");
    if (prev === content) return null; // unchanged — avoid churn
  } catch {
    /* file does not exist yet */
  }
  fs.writeFileSync(outPath, content, "utf8");
  return outPath;
}

/** Export every session in a chatSessions directory. Returns number written/updated. */
export function exportAll(sessionsDir: string, outDir: string, opts: ExportOptions): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const e of entries) {
    if (!/\.(jsonl|json)$/.test(e)) continue;
    try {
      if (exportSessionFile(path.join(sessionsDir, e), outDir, opts)) count++;
    } catch {
      /* skip unreadable session */
    }
  }
  return count;
}

/** Delete the exported Markdown for a session whose source file was removed. */
export function removeExportFor(sessionId: string, outDir: string): boolean {
  const sid8 = sessionId.slice(0, 8);
  let removed = false;
  try {
    for (const existing of fs.readdirSync(outDir)) {
      if (existing.endsWith(`-${sid8}.md`)) {
        fs.unlinkSync(path.join(outDir, existing));
        removed = true;
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}
