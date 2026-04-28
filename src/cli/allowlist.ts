import fsp from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';

interface SettingsShape {
  permissions?: { allow?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

async function readSettings(dir: string): Promise<SettingsShape | null> {
  const file = path.join(dir, '.claude', 'settings.local.json');
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8')) as SettingsShape;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function allowlistList(dir: string): Promise<void> {
  const target = path.resolve(dir);
  const settings = await readSettings(target);
  if (!settings) {
    console.log(chalk.dim(`(nenhum .claude/settings.local.json em ${target})`));
    return;
  }
  const allow = settings.permissions?.allow ?? [];
  if (allow.length === 0) {
    console.log(chalk.dim('(allowlist vazia)'));
    return;
  }
  console.log(chalk.bold(`allowlist em ${target}/.claude/settings.local.json:`));
  for (const m of allow) console.log(`  ${m}`);
}

export async function allowlistExport(dir: string): Promise<void> {
  const target = path.resolve(dir);
  const settings = await readSettings(target);
  process.stdout.write(JSON.stringify(settings ?? {}, null, 2) + '\n');
}
