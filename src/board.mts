#!/usr/bin/env node
/**
 *   board comment <task> <text>   add a note (long text is fine; `-` reads the text from stdin)
 *   board comment <task> --file <path>   add a note from a file in /tmp
 *   board move <task> <status>    move a task to the bottom of a status (todo, running, needs-me, done)
 *   board notify <task> <text>    Slack message with the task link
 *   board tasks                   open tasks per status
 *   board setup                   ask the backend to create what it needs (statuses, labels)
 *
 * <task> is the task id the backend gives. Add --dry-run to print writes.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync } from "node:fs";
import { buildContext, rejectExtraArgs, runMain, takeFlag, UsageError } from "./cli.mts";
import type { Context } from "./cli.mts";
import { isStatus, STATUSES } from "./contract.mts";
import type { Status } from "./contract.mts";
import { postSlack, slackText } from "./notify.mts";

async function readStdin(): Promise<string> {
  let content = "";
  for await (const chunk of process.stdin) content += String(chunk);
  return content.trim();
}

const USAGE = "usage: board comment <task> <text|--file path> | move <task> <status> | notify <task> <text> | tasks | setup";

const NOTE_FILE_DIR = "/tmp/";
const NOTE_FILE_MAX_BYTES = 1024 * 1024;

// A reviewer's sandbox cannot feed `board` a heredoc or a pipe (the call would stay sandboxed, and `board` runs
// outside it), so long notes come from a file. The reviewer can write /tmp, so the file is opened without
// following a link and its real location is checked on the open descriptor: a link to a secret is refused.
export function readNoteFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new UsageError(`cannot read the note file ${path}`);
  }
  try {
    if (!readlinkSync(`/proc/self/fd/${fd}`).startsWith(NOTE_FILE_DIR)) throw new UsageError(`the note file must be inside ${NOTE_FILE_DIR}`);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > NOTE_FILE_MAX_BYTES) throw new UsageError("the note file must be a regular file of at most 1 MiB");
    return readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
}

// "Needs me" and "needs-me" name the same status, so the skill can keep saying the former.
export function parseStatus(name: string): Status {
  const normalised = name.trim().toLowerCase().replaceAll(" ", "-");
  if (!isStatus(normalised)) throw new UsageError(`unknown status "${name}"; use one of ${STATUSES.join(", ")}`);
  return normalised;
}

async function notify(context: Context, id: string, text: string): Promise<void> {
  const message = slackText(await context.backend.getTask(id), text);
  if (context.dryRun) return context.print(`DRY slack ${message.replaceAll("\n", " | ")}`);
  await postSlack(context.config.slackWebhookFile, message);
}

async function tasks(context: Context): Promise<void> {
  const open = await context.backend.listTasks();
  for (const status of STATUSES) {
    const inStatus = open.filter((task) => task.status === status);
    context.print(`${status} (${inStatus.length})`);
    for (const task of inStatus) context.print(`  ${task.id}  [${task.labels.join(",") || "-"}]  ${task.title}`);
  }
}

async function setup(context: Context): Promise<void> {
  const created = await context.backend.setup(Object.keys(context.config.labels));
  if (created === undefined) return context.print("this backend has no setup; create its statuses and labels there by hand");
  for (const what of created) context.print(`created ${what}`);
}

export async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const dryRun = takeFlag(args, "--dry-run");
  const [command, id, ...rest] = args;
  if (!command || command.startsWith("--") || id?.startsWith("--")) throw new UsageError(USAGE);
  if ((command === "tasks" || command === "setup") && (id !== undefined || rest.length > 0)) rejectExtraArgs([id ?? "", ...rest], USAGE);
  const context = buildContext(dryRun);
  const fromFile = command === "comment" && rest[0] === "--file";
  if (fromFile && rest.length !== 2) throw new UsageError(USAGE);
  const text = fromFile ? readNoteFile(rest[1] ?? "") : rest.join(" ") === "-" ? await readStdin() : rest.join(" ");
  switch (command) {
    case "comment":
      if (!id || !text) throw new UsageError(USAGE);
      return context.backend.addNote(id, text);
    case "notify":
      if (!id || !text) throw new UsageError(USAGE);
      return notify(context, id, text);
    case "move":
      if (!id || !text) throw new UsageError(USAGE);
      await context.backend.updateTask(id, { status: parseStatus(text) });
      return;
    case "tasks":
      return tasks(context);
    case "setup":
      return setup(context);
    default:
      throw new UsageError(USAGE);
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
