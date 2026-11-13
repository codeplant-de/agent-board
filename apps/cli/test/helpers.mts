import type { Config, SandboxEntry } from "../src/config.mts";
import type { Backend, Note, Task } from "@agent-board/shared";

export function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `task ${overrides.id}`,
    input: "",
    labels: [],
    status: "todo",
    url: `https://tasks.example/${overrides.id}`,
    closed: false,
    machine: null,
    sessionId: null,
    next: "fresh",
    openQuestion: false,
    ...overrides,
  };
}

export const NO_SANDBOX_EXTRAS: SandboxEntry = { allowRead: [], allowWrite: [], allowedDomains: [], excludedCommands: [], maskedEnv: [] };

export const CONFIG: Config = {
  backendCommand: ["backend"],
  machine: "here",
  maxParallel: 2,
  timeoutMinutes: 45,
  slackWebhookFile: "/nonexistent",
  intakeLabel: "review-pr",
  repos: { "cosuno/cosuno": "/work/cosuno" },
  labels: {
    selftest: { kind: "command", command: ["sleep", "300"], cwd: undefined },
    "review-pr": {
      kind: "skill",
      skill: "board-review-pr",
      allowedTools: ["Read", "Bash(board *)"],
      disallowedTools: ["Bash(git push *)"],
      sandbox: NO_SANDBOX_EXTRAS,
      cwd: "pr-repo",
    },
  },
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
      const existing = state.tasks.find((candidate) => draft.dedupeKey !== undefined && parseFirstLine(candidate.input) === draft.dedupeKey);
      if (existing) return { task: { ...existing }, created: false };
      const { dedupeKey: _key, parentId: _parent, createdBy: _by, ...fields } = draft;
      return { task: task({ id: "new", ...fields }), created: true };
    },
    async updateTask(id, patch) {
      if (patch.status !== undefined) state.writes.push(`status ${id} -> ${patch.status}`);
      if (patch.input !== undefined) state.writes.push(`input ${id}: ${patch.input}`);
      if (patch.sessionId !== undefined) state.writes.push(`session ${id}: ${patch.sessionId}`);
      if (patch.next !== undefined) state.writes.push(`next ${id}: ${patch.next}`);
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
