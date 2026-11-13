import type { Config } from "../src/config.mts";
import type { RunFiles, RunRecord } from "../src/runtime.mts";
import type { Backend, Note, Task } from "@agent-board/shared";

export function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `task ${overrides.id}`,
    input: "",
    labels: [],
    status: "todo",
    priority: "normal",
    url: `https://tasks.example/${overrides.id}`,
    closed: false,
    machine: null,
    sessionId: null,
    workdir: null,
    next: "fresh",
    openQuestion: false,
    createdBy: "user",
    lane: null,
    borrowed: false,
    lastActiveAt: null,
    ...overrides,
  };
}

export const CONFIG: Config = {
  backendCommand: ["backend"],
  machine: "here",
  lanes: [{ name: "general", skills: ["*"], slots: 2 }],
  defaultCwd: "/home/me",
  pauseAfterMinutes: 5,
  inactivityMinutes: 15,
  maxRunHours: 6,
  slackWebhookFile: "/nonexistent",
  intake: { prompt: "/review-pr {url} --auto", priority: "normal", allowedTools: ["Read", "Bash(board *)"], disallowedTools: ["Bash(git push *)"], env: [], mcpServers: [] },
  repos: { "cosuno/cosuno": "/work/cosuno" },
};

export interface FakeBackend extends Backend {
  tasks: Task[];
  notes: Map<string, Note[]>;
  writes: string[];
  // Claims of these ids are lost, as if another machine got there first.
  lostClaims: string[];
}

function parseFirstLine(input: string): string {
  return input.split("\n")[0]?.trim() ?? "";
}

let noteCounter = 0;

// A note as the backend returns it; `author` defaults to the agent.
export function note(text: string, createdAt: Date, overrides: Partial<Note> = {}): Note {
  noteCounter++;
  return { id: `n${noteCounter}`, text, createdAt, author: "agent", kind: "comment", ...overrides };
}

// In-memory task store; the array order is the priority. Every write lands in `writes` as a short string, so tests assert on what was done.
export function fakeBackend(tasks: Task[]): FakeBackend {
  const state: FakeBackend = {
    tasks,
    notes: new Map(),
    writes: [],
    lostClaims: [],
    async listTasks({ all = false } = {}) {
      return state.tasks.filter((t) => all || !t.closed).map((t) => ({ ...t }));
    },
    async getTask(id) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      return { ...found };
    },
    async addTask(draft) {
      state.writes.push(`create ${draft.title} | ${draft.input} | ${draft.labels.join(",")}${draft.dedupeKey ? ` | key ${draft.dedupeKey}` : ""}`);
      const existing = state.tasks.find((candidate) => draft.dedupeKey !== undefined && parseFirstLine(candidate.input).includes(draft.dedupeKey));
      if (existing) return { task: { ...existing }, created: false };
      const { dedupeKey: _key, parentId: _parent, createdBy, machine, workdir, ...fields } = draft;
      return { task: task({ id: "new", ...fields, createdBy: createdBy ?? "user", machine: machine ?? null, workdir: workdir ?? null }), created: true };
    },
    async updateTask(id, patch) {
      if (patch.status !== undefined) state.writes.push(`status ${id} -> ${patch.status}`);
      if (patch.input !== undefined) state.writes.push(`input ${id}: ${patch.input}`);
      if (patch.sessionId !== undefined) state.writes.push(`session ${id}: ${patch.sessionId}`);
      if (patch.next !== undefined) state.writes.push(`next ${id}: ${patch.next}`);
      if (patch.workdir !== undefined) state.writes.push(`workdir ${id}: ${patch.workdir}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      Object.assign(found, patch);
      return { ...found };
    },
    async claimTask(id, machine) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      const pinned = found.next === "resume" && found.machine !== null && found.machine !== machine;
      if (found.status !== "todo" || pinned || state.lostClaims.includes(id)) {
        state.writes.push(`claim ${id} lost`);
        return undefined;
      }
      state.writes.push(`claim ${id} by ${machine}`);
      Object.assign(found, { status: "running", machine });
      return { ...found };
    },
    async addNote(id, text, options) {
      state.writes.push(`note ${id}${options?.author === "system" ? " (system)" : ""}: ${text}`);
    },
    async transcript(id, batch) {
      state.writes.push(`transcript ${id} ${batch.runId} ${batch.events.map((e) => e.kind).join(",")}`);
    },
    async heartbeat(id, beat) {
      state.writes.push(`heartbeat ${id} ${beat.lane}${beat.borrowed ? " borrowed" : ""}`);
    },
    async pause(id, note) {
      state.writes.push(`pause ${id}: ${note}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      Object.assign(found, { status: "todo", next: found.sessionId ? "resume" : "fresh" });
      return { ...found };
    },
    async ask(id, questions) {
      state.writes.push(`ask ${id}: ${questions.map((q) => q.header).join(", ")}`);
      const found = state.tasks.find((t) => t.id === id);
      if (found) Object.assign(found, { status: "needs-me", openQuestion: true });
    },
    async readNotes(id) {
      return state.notes.get(id) ?? [];
    },
    async setup(labels) {
      state.writes.push(`setup ${labels.join(",")}`);
      return [];
    },
  };
  return state;
}

export interface FakeRunFiles extends RunFiles {
  runs: Map<string, RunRecord>;
  alive: Map<string, Date>;
  pauses: Map<string, Date>;
  cwds: Map<string, string>;
}

// RunFiles in memory.
export function fakeRunFiles(now: () => Date = () => new Date()): FakeRunFiles {
  const files: FakeRunFiles = {
    dir: "/run/test/agent-board",
    runs: new Map(),
    alive: new Map(),
    pauses: new Map(),
    cwds: new Map(),
    writeRun: (id, record) => void files.runs.set(id, record),
    readRun: (id) => files.runs.get(id),
    lastActive: (id) => files.alive.get(id),
    touchAlive: (id, at = now()) => void files.alive.set(id, at),
    writeCwd: (id, cwd) => void files.cwds.set(id, cwd),
    lastCwd: (id) => files.cwds.get(id),
    requestPause: (id) => void files.pauses.set(id, now()),
    pauseRequestedAt: (id) => files.pauses.get(id),
    clear(id) {
      files.runs.delete(id);
      files.alive.delete(id);
      files.pauses.delete(id);
      files.cwds.delete(id);
    },
  };
  return files;
}
