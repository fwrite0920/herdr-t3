// Antigravity CLI (`agy`) as a provider: `agy --output-format stream-json --input-format stream-json --print=`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { ClaudeProcess } from "../claude/process.ts";
import type { ClaudeRecord } from "../claude/process.ts";
import { agentEnv } from "../env.ts";
import { CLAUDE_TOOLS } from "../claude/tools.ts";
import type {
  ProviderAdapter, AdapterHost, AdapterOptions, Capabilities, StartInfo, NormalizedEvent, AssistantBlock, AskAnswer, ImageBlock,
  ModelInfo, AgentCommand, AgentModel, SessionInfo, UsageInfo, PromptMode, Disposition, PermissionMode, ForkPoint,
} from "../types.ts";

type Rec = Record<string, any>;

export const AGY_PERMISSION_MODES: PermissionMode[] = [
  { id: "full", label: "Full access", description: "No sandbox, no approvals, and full filesystem access (--dangerously-skip-permissions)" },
  { id: "auto", label: "Auto", description: "Auto-approve tool calls within the current workspace" },
  { id: "accept-edits", label: "Accept edits", description: "Edit files automatically; ask for commands" },
  { id: "plan", label: "Plan", description: "Read and plan only" },
];

function fullAccessDirs(): string[] {
  if (process.platform === "win32") {
    const dirs: string[] = [];
    for (const d of ["C:\\", "D:\\", homedir()]) {
      if (d && existsSync(d) && !dirs.includes(d)) dirs.push("--add-dir", d);
    }
    return dirs;
  }
  return ["--add-dir", "/"];
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const FALLBACK_MODELS: AgentModel[] = [
  { provider: "antigravity", id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", reasoning: true, enabled: true },
  { provider: "antigravity", id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", reasoning: true, enabled: true },
  { provider: "antigravity", id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)", reasoning: true, enabled: true },
  { provider: "antigravity", id: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)", reasoning: true, enabled: true },
  { provider: "antigravity", id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", reasoning: true, enabled: true },
  { provider: "antigravity", id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", reasoning: true, enabled: true },
  { provider: "antigravity", id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", reasoning: true, enabled: true },
  { provider: "antigravity", id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", reasoning: true, enabled: true },
];

export class AgyAdapter implements ProviderAdapter {
  readonly id = "agy";
  readonly name = "Antigravity";
  readonly tools = CLAUDE_TOOLS;
  readonly capabilities: Capabilities = {
    steer: false, followUp: true, thinkingLevels: EFFORT_LEVELS, permissions: false, permissionModes: AGY_PERMISSION_MODES,
    extensionUi: false, compact: false, compactInstructions: false, rename: false, fork: false, images: false, cost: false, tui: true,
  };
  private opts: AdapterOptions;
  private proc: ClaudeProcess | null = null;
  private host: AdapterHost | null = null;
  private conversationId: string | null = null;
  private modelValue: string | null = null;
  private initModel: string | null = null;
  private effort: string = "medium";
  private permissionMode: string = "full";
  private models: AgentModel[] = [...FALLBACK_MODELS];
  private running = false;
  private curText = "";
  private curThinking = "";
  private activeTools = new Set<string>();
  private lastTokens: number | null = null;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  get alive(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  private emit(ev: NormalizedEvent): void {
    this.host?.emit(ev);
  }

  private require(): ClaudeProcess {
    if (!this.proc || this.proc.exited) throw new Error("Antigravity CLI is not running. Use /reload to restart it.");
    return this.proc;
  }

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.running = false;
    this.curText = "";
    this.curThinking = "";
    this.activeTools.clear();
    if (session) this.conversationId = session;

    const modeFlags = this.permissionMode === "full"
      ? ["--dangerously-skip-permissions", ...fullAccessDirs()]
      : this.permissionMode === "auto"
        ? ["--dangerously-skip-permissions"]
        : ["--mode", this.permissionMode];

    const args = [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      ...modeFlags,
      ...(this.modelValue ? ["--model", this.modelValue] : []),
      ...(this.effort ? ["--effort", this.effort] : []),
      ...(this.conversationId ? [`--conversation=${this.conversationId}`] : []),
      "--print=",
      ...this.opts.args,
    ];
    host.log(`spawn ${this.opts.command} ${args.join(" ")}`);
    const env = agentEnv({});
    const p = new ClaudeProcess({ command: this.opts.command, args, cwd: this.opts.cwd, env });
    this.proc = p;
    p.onRecord = (r) => this.proc === p && this.onRecord(r);
    p.onBadLine = (line) => host.log(`agy stdout (not JSON): ${line.slice(0, 200)}`);
    p.onExit = (info) => {
      if (this.proc !== p) return;
      this.proc = null;
      host.emit({
        type: "exited", code: info.code, signal: info.signal, stderrTail: info.stderr,
        ...(info.spawnError ? { spawnError: info.spawnError } : {}), command: this.opts.command,
      });
    };

    this.emit({ type: "permission_mode", mode: this.permissionMode });
    this.emit({ type: "thinking", level: this.effort });
    this.emitModel();
    this.probeModels();
    return { streaming: false, hasHistory: false };
  }

  private probeModels(): void {
    execFile(this.opts.command, ["models"], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return;
      const parsed: AgentModel[] = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^([a-z0-9._-]+)\t+(.+)$/i);
        if (m) {
          parsed.push({ provider: "antigravity", id: m[1]!, name: m[2]!.trim(), reasoning: true, enabled: true });
        }
      }
      if (parsed.length) {
        this.models = parsed;
        this.emitModel();
      }
    });
  }

  private currentModel(): ModelInfo {
    const id = this.modelValue ?? this.initModel ?? "gemini-4-argon-medium";
    const found = this.models.find((m) => m.id === id);
    return {
      provider: "antigravity",
      id,
      name: found ? found.name : id,
      reasoning: true,
      contextWindow: 1000000,
      input: ["text"],
    };
  }

  private emitModel(): void {
    this.emit({ type: "model", model: this.currentModel() });
  }

  private flushAssistant(usage?: Rec, durationSec?: number): void {
    if (!this.curText && !this.curThinking) return;
    const content: AssistantBlock[] = [];
    if (this.curThinking) content.push({ type: "thinking", text: this.curThinking });
    if (this.curText) content.push({ type: "text", text: this.curText });
    this.curText = "";
    this.curThinking = "";
    const u = usage && typeof usage === "object"
      ? { input: Number(usage.input_tokens ?? 0), output: Number(usage.output_tokens ?? 0), cacheRead: Number(usage.cache_read_tokens ?? 0), cacheWrite: 0, cost: null }
      : undefined;
    if (u && u.input > 0) this.lastTokens = u.input + u.output;
    this.emit({
      type: "assistant_end",
      content,
      model: `antigravity/${this.currentModel().id}`,
      ...(u ? { usage: u } : {}),
      ...(typeof durationSec === "number" ? { durationMs: Math.round(durationSec * 1000) } : {}),
    });
  }

  private onRecord(rec: ClaudeRecord): void {
    this.emit({ type: "heartbeat" });
    const ev = rec.event;
    if (ev === "init") {
      if (typeof rec.conversation_id === "string" && rec.conversation_id) {
        this.conversationId = rec.conversation_id;
        this.emit({ type: "session", id: this.conversationId, file: this.conversationId, name: null });
      }
      if (typeof rec.init?.model === "string" && rec.init.model) {
        this.initModel = rec.init.model;
        this.emitModel();
      }
      return;
    }
    if (ev === "step_update") {
      const su: Rec = rec.step_update ?? {};
      if (!this.running) {
        this.running = true;
        this.emit({ type: "run_started" });
      }
      if (su.step_type === "agent_response") {
        if (typeof su.thinking_delta === "string" && su.thinking_delta) {
          this.curThinking += su.thinking_delta;
          this.emit({ type: "assistant_delta", kind: "thinking", delta: su.thinking_delta });
        }
        if (typeof su.text_delta === "string" && su.text_delta) {
          this.curText += su.text_delta;
          this.emit({ type: "assistant_delta", kind: "text", delta: su.text_delta });
        }
        if (su.state === "DONE") {
          this.flushAssistant(su.usage, su.duration_seconds);
        }
      } else if (su.step_type === "tool") {
        this.flushAssistant();
        const callId = `step-${su.step_index ?? 0}`;
        const name = String(su.tool_name || su.tool_info?.name || "tool");
        const args = su.tool_info?.parameters && typeof su.tool_info.parameters === "object" ? su.tool_info.parameters : {};
        if (su.state === "ACTIVE" && !this.activeTools.has(callId)) {
          this.activeTools.add(callId);
          this.emit({ type: "tool_call", callId, name, args });
        } else if (su.state === "DONE" || su.state === "ERROR") {
          if (!this.activeTools.has(callId)) {
            this.emit({ type: "tool_call", callId, name, args });
          }
          this.activeTools.delete(callId);
          const output = String(su.tool_info?.output ?? su.error_message ?? "");
          this.emit({
            type: "tool_ended",
            callId,
            name,
            isError: su.state === "ERROR",
            output,
            images: 0,
            result: { content: [{ type: "text", text: output }] },
            ...(typeof su.duration_seconds === "number" ? { durationMs: Math.round(su.duration_seconds * 1000) } : {}),
          });
        }
      }
      return;
    }
    if (ev === "result") {
      const res: Rec = rec.result ?? {};
      this.flushAssistant(res.usage, res.duration_seconds);
      if (res.status === "ERROR" && res.error) {
        this.emit({ type: "assistant_end", content: [], stopReason: "error", error: String(res.error) });
      }
      if (this.running) {
        this.running = false;
        this.emit({ type: "run_ended" });
      }
      return;
    }
  }

  async dispose(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    await p.stop();
  }

  kill(): void {
    this.proc?.killNow();
  }

  answer(_askId: string, _answer: AskAnswer): void {}

  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    const proc = this.require();
    this.emit({ type: "user_message", text: p.text, skill: null, images: p.images.length, imageBlocks: p.images, source: "composer" });
    if (!this.running) {
      this.running = true;
      this.emit({ type: "run_started" });
    }
    if (!proc.write({ event: "user", message: { role: "user", content: p.text } })) {
      throw new Error("Antigravity CLI is not running");
    }
    return { disposition: "started" };
  }

  async clearQueue(): Promise<string[]> { return []; }
  canRemoveQueued(_id: string): boolean { return false; }
  async removeQueued(_id: string): Promise<boolean> { return false; }

  abort(): void {
    const p = this.proc;
    if (!p) return;
    p.killNow();
    if (this.running) {
      this.running = false;
      this.emit({ type: "run_ended" });
    }
    if (this.host) void this.start(this.conversationId, this.host);
  }

  async history(): Promise<NormalizedEvent[]> { return []; }
  listSessions(): SessionInfo[] { return []; }
  async listModels(): Promise<AgentModel[]> { return this.models; }
  async commands(): Promise<AgentCommand[]> { return []; }

  async usage(): Promise<UsageInfo> {
    const max = 1000000;
    const tok = this.lastTokens;
    return {
      contextTokens: tok,
      contextWindow: max,
      percent: tok !== null ? Math.round((tok / max) * 1000) / 10 : null,
      cost: null,
    };
  }

  sessionHolder(): { pid: number } | null { return null; }

  tuiCommand(session: string): string[] {
    const id = session || this.conversationId;
    const extra = this.permissionMode === "full"
      ? ["--dangerously-skip-permissions", ...fullAccessDirs()]
      : this.permissionMode === "auto"
        ? ["--dangerously-skip-permissions"]
        : ["--mode", this.permissionMode];
    return id ? [this.opts.command, ...extra, `--conversation=${id}`] : [this.opts.command, ...extra];
  }

  tuiCommands(): { name: string; description: string }[] { return []; }
  utilityCommand(_name: string): string[] | null { return null; }
  tuiInput(_name: string): string | null { return null; }

  async setModel(_provider: string, id: string): Promise<void> {
    this.modelValue = id;
    this.initModel = id;
    this.emitModel();
    if (this.host && !this.running) {
      await this.dispose();
      await this.start(this.conversationId, this.host);
    }
  }

  async setThinking(level: string): Promise<void> {
    if (!EFFORT_LEVELS.includes(level)) throw new Error(`Antigravity effort levels are ${EFFORT_LEVELS.join(", ")}`);
    this.effort = level;
    this.emit({ type: "thinking", level });
    if (this.host && !this.running) {
      await this.dispose();
      await this.start(this.conversationId, this.host);
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode;
    this.emit({ type: "permission_mode", mode });
    if (this.host && !this.running) {
      await this.dispose();
      await this.start(this.conversationId, this.host);
    }
  }

  async compact(): Promise<void> {}

  async newSession(): Promise<void> {
    this.conversationId = null;
    if (this.host) {
      await this.dispose();
      await this.start(null, this.host);
    }
  }

  async switchSession(path: string): Promise<void> {
    this.conversationId = path;
    if (this.host) {
      await this.dispose();
      await this.start(path, this.host);
    }
  }

  async setName(_name: string): Promise<void> {}
  async forkPoints(): Promise<ForkPoint[]> { return []; }
  async fork(_point: string): Promise<{ text: string }> { throw new Error("Fork is not supported for Antigravity yet"); }
}
