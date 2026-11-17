import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isRecord } from '@agent-board/shared';
import { ConfigError } from './config.mts';
import { tryRealpath } from './dirs.mts';

export interface ConfigFile {
  raw: Record<string, unknown>;
  mode: number;
}

// A config.json that is a link (a dotfiles checkout) is changed where it points, not replaced by a plain file.
export const configTarget = (configFile: string): string => tryRealpath(configFile) ?? configFile;

/** The text of config.json and its permission bits. */
export function readConfigText(configFile: string): { text: string; mode: number } {
  try {
    return { text: readFileSync(configFile, 'utf8'), mode: statSync(configFile).mode & 0o777 };
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    throw new ConfigError(
      missing
        ? `config file missing: ${configFile} (run "board init")`
        : `cannot read the config file ${configFile} (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown error'})`,
    );
  }
}

/** The parsed top-level object of config.json and its permission bits; `fixHint` ends the message about a file that is not JSON. */
export function readConfigFile(configFile: string, fixHint?: string): ConfigFile {
  const { text, mode } = readConfigText(configFile);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`config file is not valid JSON: ${configFile}${fixHint === undefined ? '' : `; ${fixHint}`}`);
  }
  if (!isRecord(raw)) throw new ConfigError('config: top level must be an object');
  return { raw, mode };
}

/**
 * Writes `raw` as JSON with 2 spaces beside config.json and renames it over the file, with `mode`: no reader sees half a
 * file. Hand formatting is lost; the key order is kept.
 */
export function writeConfigFile(configFile: string, raw: Record<string, unknown>, mode: number): void {
  const target = configTarget(configFile);
  const temp = `${target}.tmp-${process.pid}`;
  try {
    rmSync(temp, { force: true });
    writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, { mode, flag: 'wx' });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}
