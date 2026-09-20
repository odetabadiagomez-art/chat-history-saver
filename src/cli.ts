// cli.ts — test harness: export sessions without VS Code.
// Usage: node dist/cli.js <chatSessionsDir> <outDir> [workspaceRoot]
import { exportAll } from "./exporter";

const [sessionsDir, outDir, workspaceRoot] = process.argv.slice(2);
if (!sessionsDir || !outDir) {
  console.error("Usage: node dist/cli.js <chatSessionsDir> <outDir> [workspaceRoot]");
  process.exit(1);
}

const n = exportAll(sessionsDir, outDir, {
  includeToolSummaries: true,
  includeThinking: false,
  workspaceRoot,
});
console.log(`Exported/updated ${n} session(s) to ${outDir}`);
