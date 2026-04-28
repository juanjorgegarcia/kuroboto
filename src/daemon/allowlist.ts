import fsp from 'node:fs/promises';
import path from 'node:path';

export type RememberGranularity = 'tight' | 'permissive';

export function computeAllowMatcher(
  toolName: string,
  toolInput: Record<string, unknown>,
  granularity: RememberGranularity,
): string {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    const tokens = toolInput.command.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 'Bash';
    const take = granularity === 'permissive' ? 1 : Math.min(2, tokens.length);
    return `Bash(${tokens.slice(0, take).join(' ')}:*)`;
  }
  return toolName;
}

interface SettingsShape {
  permissions?: { allow?: string[]; deny?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

export async function addProjectAllow(cwd: string, matcher: string): Promise<void> {
  const dir = path.join(cwd, '.claude');
  const file = path.join(dir, 'settings.local.json');
  await fsp.mkdir(dir, { recursive: true });
  let json: SettingsShape = {};
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    json = JSON.parse(raw) as SettingsShape;
    if (typeof json !== 'object' || json === null) json = {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const perms = (json.permissions && typeof json.permissions === 'object' ? json.permissions : {}) as NonNullable<SettingsShape['permissions']>;
  const allow = Array.isArray(perms.allow) ? perms.allow : [];
  if (!allow.includes(matcher)) allow.push(matcher);
  json.permissions = { ...perms, allow };
  await fsp.writeFile(file, JSON.stringify(json, null, 2) + '\n');
}
