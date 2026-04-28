import fsp from 'node:fs/promises';
import { Config, type ConfigT } from './schema.js';
import { CONFIG_DIR, CONFIG_FILE } from './paths.js';
import { ConfigError } from '../core/errors.js';

export async function saveConfig(config: ConfigT): Promise<void> {
  const result = Config.safeParse(config);
  if (!result.success) {
    throw new ConfigError(`config validation failed: ${result.error.message}`);
  }
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const json = JSON.stringify(result.data, null, 2);
  await fsp.writeFile(CONFIG_FILE, json, { mode: 0o600 });
  try {
    await fsp.chmod(CONFIG_FILE, 0o600);
  } catch {
    // Windows NTFS doesn't honor POSIX modes; best-effort
  }
}
