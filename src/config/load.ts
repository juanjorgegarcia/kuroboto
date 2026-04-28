import fsp from 'node:fs/promises';
import { Config, type ConfigT } from './schema.js';
import { CONFIG_FILE } from './paths.js';
import { ConfigError } from '../core/errors.js';

export async function loadConfig(): Promise<ConfigT> {
  let raw: string;
  try {
    raw = await fsp.readFile(CONFIG_FILE, 'utf-8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new ConfigError(`config not found at ${CONFIG_FILE} — run \`kuroboto init\``);
    }
    throw new ConfigError(`failed to read config: ${err.message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`config is not valid JSON: ${(e as Error).message}`);
  }
  const result = Config.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`config validation failed: ${result.error.message}`);
  }
  return result.data;
}
