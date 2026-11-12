import type { Config, SandboxEntry } from "../src/config.mts";
import type { Backend, Note, Task } from "../src/contract.mts";

export function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `task ${overrides.id}`,
    input: "",
    labels: [],
    status: "todo",
    url: `https://tasks.example/${overrides.id}`,
    closed: false,
    ...overrides,
  };
}

export const NO_SANDBOX_EXTRAS: SandboxEntry = { allowRead: [], allowWrite: [], allowedDomains: [], excludedCommands: [], maskedEnv: [] };

export const CONFIG: Config = {
  backendCommand: ["backend"],
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
}

// In-memory task store; the array order is the priority. Every write lands in `writes` as a short string, so tests assert on what was done.
export function fakeBackend(tasks: Task[]): FakeBackend {
  const state: FakeBackend = {
    tasks,
    notes: new Map(),
    writes: [],
    async listTasks({ all = false } = {}) {
      return state.tasks.filter((t) => all || !t.closed).map((t) => ({ ...t }));
    },
    async getTask(id) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      return { ...found };
    },
    async addTask(draft) {
      state.writes.push(`create ${draft.title} | ${draft.input} | ${draft.labels.join(",")}`);
      return task({ id: "new", ...draft });
    },
    async updateTask(id, patch) {
      if (patch.status !== undefined) state.writes.push(`status ${id} -> ${patch.status}`);
      if (patch.input !== undefined) state.writes.push(`input ${id}: ${patch.input}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      Object.assign(found, patch);
      return { ...found };
    },
    async addNote(id, text) {
      state.writes.push(`note ${id}: ${text}`);
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
