// sessionParser.ts — reconstruct VS Code chat .jsonl session files and extract
// conversations plus metadata (files touched, tools, skills, agents, models).
// Pure Node (fs/path only) — no vscode dependency, so it can be tested via CLI.
import * as fs from "fs";
import * as path from "path";

export interface FileTouch {
  path: string;
  kind: "created" | "edited" | "referenced";
}

export interface ParsedRequest {
  timestamp: number;
  userText: string;
  agentName?: string;
  modelId?: string;
  assistantMarkdown: string[];
  thinking: string[];
  toolSummaries: string[];
  skills: string[];
  subagents: string[];
  files: FileTouch[];
  questions: string[];
  elapsedMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ParsedSession {
  sessionId: string;
  title: string;
  creationDate: number;
  lastMessageDate: number;
  responder?: string;
  requests: ParsedRequest[];
  sourceFile: string;
}

/* ------------------------------------------------------------------ */
/* JSONL patch reconstruction                                          */
/* ------------------------------------------------------------------ */

function setPath(obj: any, keys: (string | number)[], value: any): void {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === undefined || cur[k] === null) {
      cur[k] = typeof keys[i + 1] === "number" ? [] : {};
    }
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function pushPath(obj: any, keys: (string | number)[], items: any): void {
  let cur = obj;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const last = i === keys.length - 1;
    if (last) {
      if (!Array.isArray(cur[k])) cur[k] = [];
      const arr = Array.isArray(items) ? items : [items];
      cur[k].push(...arr);
    } else {
      if (cur[k] === undefined || cur[k] === null) {
        cur[k] = typeof keys[i + 1] === "number" ? [] : {};
      }
      cur = cur[k];
    }
  }
}

/** Rebuild the full session object from an incremental-patch .jsonl file. */
export function reconstructJsonl(filePath: string): any | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let base: any = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let op: any;
    try {
      op = JSON.parse(trimmed);
    } catch {
      continue; // tolerate partially-written trailing lines
    }
    if (op.kind === 0) {
      base = op.v;
    } else if (base && op.kind === 1 && Array.isArray(op.k)) {
      setPath(base, op.k, op.v);
    } else if (base && op.kind === 2 && Array.isArray(op.k)) {
      pushPath(base, op.k, op.v);
    }
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Extraction helpers                                                  */
/* ------------------------------------------------------------------ */

const ABS_PATH_RE = /^\//;

function uriToFsPath(u: any): string | undefined {
  if (!u) return undefined;
  if (typeof u === "string") {
    if (u.startsWith("file://")) {
      try {
        return decodeURIComponent(new URL(u).pathname);
      } catch {
        return undefined;
      }
    }
    return ABS_PATH_RE.test(u) ? u : undefined;
  }
  if (typeof u === "object") {
    if (typeof u.fsPath === "string" && u.fsPath) return u.fsPath;
    if (typeof u.path === "string" && u.scheme === "file") {
      return decodeURIComponent(u.path);
    }
    if (typeof u.external === "string" && u.external.startsWith("file://")) {
      return uriToFsPath(u.external);
    }
  }
  return undefined;
}

/** Recursively collect file paths from toolSpecificData objects. */
function collectToolPaths(obj: any, out: Set<string>, depth = 0): void {
  if (!obj || typeof obj !== "object" || depth > 6) return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectToolPaths(item, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      if (/^(filePath|filepath|path|fsPath|targetFile|fileUri|uri|resource)$/i.test(k)) {
        const p = uriToFsPath(v);
        if (p && !p.includes("\n")) out.add(p);
      }
    } else if (v && typeof v === "object") {
      // URI-like objects
      const asUri = uriToFsPath(v);
      if (asUri && /uri|path|file/i.test(k)) out.add(asUri);
      else collectToolPaths(v, out, depth + 1);
    }
  }
}

function classifyTool(toolId: string, summary: string): FileTouch["kind"] | null {
  const s = (toolId + " " + summary).toLowerCase();
  if (/create_file|createfile|create file|writing new|create_directory|creating/.test(s)) return "created";
  if (/replacestring|replace_string|insert_edit|edit_notebook|editfile|edit_file|copilot_edit|apply|writing|saved file|renam|move|delete/.test(s)) return "edited";
  if (/read_file|readfile|reading|open_file|view_image|grep|search|list_dir/.test(s)) return "referenced";
  return null;
}

function cleanSummary(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\\`/g, "`")
    .trim()
    .slice(0, 200);
}

function extractUserText(message: any): string {
  if (!message) return "";
  if (typeof message.text === "string" && message.text.trim()) return message.text;
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => p && (p.kind === "text" || p.kind === undefined) && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
  }
  if (typeof message === "string") return message;
  return "";
}

function mergeFileTouch(list: FileTouch[], filePath: string, kind: FileTouch["kind"]): void {
  const existing = list.find((f) => f.path === filePath);
  const rank = { created: 3, edited: 2, referenced: 1 } as const;
  if (!existing) {
    list.push({ path: filePath, kind });
  } else if (rank[kind] > rank[existing.kind]) {
    existing.kind = kind;
  }
}

/* ------------------------------------------------------------------ */
/* Session parsing                                                     */
/* ------------------------------------------------------------------ */

export function parseSessionFile(filePath: string): ParsedSession | null {
  let base: any;
  if (filePath.endsWith(".jsonl")) {
    base = reconstructJsonl(filePath);
  } else {
    // Legacy single-JSON format (older VS Code versions)
    try {
      base = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }
  if (!base || !Array.isArray(base.requests)) return null;

  const requests: ParsedRequest[] = [];
  let lastMessageDate: number = base.creationDate || Date.now();

  for (const r of base.requests) {
    if (!r || r.hiddenFromTranscript) continue;
    const userText = extractUserText(r.message);
    const timestamp: number = r.timestamp || lastMessageDate;

    const req: ParsedRequest = {
      timestamp,
      userText,
      agentName: r.agent?.fullName || r.agent?.name || undefined,
      modelId: typeof r.modelId === "string" ? r.modelId : undefined,
      assistantMarkdown: [],
      thinking: [],
      toolSummaries: [],
      skills: [],
      subagents: [],
      files: [],
      questions: [],
      elapsedMs: r.elapsedMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    };

    // Skills invoked via slash command in the user's message
    const slash = userText.match(/^\s*\/([\w.-]+)/);
    if (slash) req.skills.push(slash[1]);

    for (const p of r.response || []) {
      if (!p || typeof p !== "object") continue;
      const kind = p.kind;

      if (kind === undefined || kind === "markdownContent") {
        if (typeof p.value === "string" && p.value.trim()) {
          req.assistantMarkdown.push(p.value);
        }
        continue;
      }
      if (kind === "thinking") {
        const t = p.value || p.metadata?._completeThinking || "";
        if (typeof t === "string" && t.trim()) req.thinking.push(t);
        continue;
      }
      if (kind === "toolInvocationSerialized") {
        const toolId: string = p.toolId || p.toolSpecificData?.kind || "tool";
        const msg = p.invocationMessage?.value ? p.invocationMessage : p.pastTenseMessage;
        const summary = cleanSummary(String(msg?.value || toolId));
        req.toolSummaries.push(`\`${toolId}\` — ${summary}`);

        // Skill reads
        for (const m of summary.matchAll(/skill `([^`]+)`/g)) {
          if (!req.skills.includes(m[1])) req.skills.push(m[1]);
        }
        // Subagent invocations
        if (/subagent/i.test(toolId) || /subagent/i.test(summary)) {
          const raw = JSON.stringify(p.toolSpecificData || {});
          const am = raw.match(/"agentName"\s*:\s*"([^"]+)"/) || summary.match(/agent[:\s]+["“]?([\w .-]{2,40})/i);
          if (am && !req.subagents.includes(am[1])) req.subagents.push(am[1].trim());
        }
        // File paths from tool arguments (skip terminals — too noisy)
        if (!/terminal/i.test(toolId) && !/terminal/i.test(String(p.toolSpecificData?.kind || ""))) {
          const paths = new Set<string>();
          collectToolPaths(p.toolSpecificData, paths);
          // Built-in copilot_* tools keep file URIs in invocationMessage.uris
          const uris = msg?.uris;
          if (uris && typeof uris === "object") {
            for (const [u, v] of Object.entries(uris as Record<string, any>)) {
              const fp = uriToFsPath(v) || uriToFsPath(String(u).split("#")[0]);
              if (fp) paths.add(fp);
            }
          }
          const k = classifyTool(toolId, summary);
          if (k) {
            for (const fp of paths) mergeFileTouch(req.files, fp, k);
          }
        }
        continue;
      }
      if (kind === "textEditGroup") {
        const fp = uriToFsPath(p.uri);
        if (fp) mergeFileTouch(req.files, fp, "edited");
        continue;
      }
      if (kind === "codeblockUri") {
        const fp = uriToFsPath(p.uri);
        if (fp) mergeFileTouch(req.files, fp, p.isEdit ? "edited" : "created");
        continue;
      }
      if (kind === "inlineReference") {
        const fp = uriToFsPath(p.inlineReference);
        if (fp) mergeFileTouch(req.files, fp, "referenced");
        continue;
      }
      if (kind === "questionCarousel" && Array.isArray(p.questions)) {
        for (const q of p.questions) {
          if (q?.title || q?.message) req.questions.push(String(q.title || q.message).slice(0, 120));
        }
        continue;
      }
      // mcpServersStarting, progressTaskSerialized, undoStop, etc. -> ignored
    }

    if (req.timestamp + (req.elapsedMs || 0) > lastMessageDate) {
      lastMessageDate = req.timestamp + (req.elapsedMs || 0);
    }
    requests.push(req);
  }

  const title: string =
    (typeof base.customTitle === "string" && base.customTitle.trim()) ||
    (requests.find((r) => r.userText.trim())?.userText.trim().slice(0, 60)) ||
    "Untitled session";

  return {
    sessionId: String(base.sessionId || path.basename(filePath).replace(/\.jsonl?$/, "")),
    title,
    creationDate: base.creationDate || (requests[0]?.timestamp ?? Date.now()),
    lastMessageDate,
    responder: base.responderUsername,
    requests,
    sourceFile: filePath,
  };
}

/** Parse every session file in a chatSessions directory. */
export function parseAllSessions(sessionsDir: string): ParsedSession[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const sessions: ParsedSession[] = [];
  for (const e of entries) {
    if (!/\.(jsonl|json)$/.test(e)) continue;
    const parsed = parseSessionFile(path.join(sessionsDir, e));
    if (parsed && parsed.requests.some((r) => r.userText.trim() || r.assistantMarkdown.length)) {
      sessions.push(parsed);
    }
  }
  sessions.sort((a, b) => a.creationDate - b.creationDate);
  return sessions;
}
