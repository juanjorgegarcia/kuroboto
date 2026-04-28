import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import prompts from 'prompts';
import chalk from 'chalk';
import { saveConfig } from '../config/save.js';
import { CONFIG_FILE } from '../config/paths.js';
import type { ConfigT } from '../config/schema.js';

interface TelegramGetUpdatesResp {
  ok: boolean;
  result: Array<{
    message?: { chat: { id: number }; text?: string };
  }>;
  description?: string;
}

export async function initCommand(): Promise<void> {
  console.log(chalk.bold('\nkuroboto init'));
  console.log('Vamos configurar o bot Telegram e instalar os hooks no Claude Code.\n');

  const has = await prompts({
    type: 'confirm',
    name: 'val',
    message: 'Você já tem um bot Telegram criado?',
    initial: true,
  });
  if (has.val !== true) {
    console.log(chalk.cyan('\nCrie o bot:'));
    console.log('  1. No Telegram, busque @BotFather');
    console.log('  2. Envie /newbot e siga as instruções');
    console.log('  3. Copie o token (formato 1234567890:ABC...)\n');
    const cont = await prompts({ type: 'confirm', name: 'val', message: 'Pronto, criou? Quando estiver com o token, prossiga.', initial: true });
    if (cont.val !== true) { console.log('Abandonado.'); return; }
  }

  const tokenAns = await prompts({
    type: 'password',
    name: 'val',
    message: 'Cola o token aqui:',
    validate: (s: string) => /^\d+:[A-Za-z0-9_-]+$/.test((s ?? '').trim()) || 'token inválido',
  });
  const token = ((tokenAns.val as string) ?? '').trim();
  if (!token) { console.log('Cancelado.'); return; }

  console.log(chalk.cyan('\nAbra seu bot no Telegram (busca pelo username dele) e envie /start.'));
  await prompts({ type: 'confirm', name: 'val', message: 'Mandou /start? Eu busco o chat_id.', initial: true });

  let chatId: number | null = null;
  for (let i = 0; i < 3 && chatId === null; i++) {
    chatId = await fetchChatId(token);
    if (chatId === null && i < 2) {
      const retry = await prompts({ type: 'confirm', name: 'val', message: 'Nada encontrado. Manda /start de novo e tenta de novo?', initial: true });
      if (retry.val !== true) break;
    }
  }
  if (chatId === null) {
    console.log(chalk.red('\nNão consegui pegar o chat_id. Rode `kuroboto init` de novo após mandar /start.'));
    return;
  }
  console.log(chalk.green(`✓ chat_id capturado: ${chatId}`));

  const portAns = await prompts({
    type: 'number',
    name: 'val',
    message: 'Porta do daemon (loopback only):',
    initial: 47891,
    min: 1024,
    max: 65535,
  });
  const port = (portAns.val as number) ?? 47891;

  const authToken = randomBytes(32).toString('hex');
  const config: ConfigT = {
    channel: { type: 'telegram', token, chatId },
    daemon: { port, authToken },
    inject: { enabled: false },
    policy: {
      permissionTimeoutMs: 55_000,
      notifyDelayMs: 60_000,
      permissionMatchers: ['Bash', 'Edit', 'Write'],
      failOpen: true,
    },
  };
  await saveConfig(config);
  console.log(chalk.green(`✓ config salvo em ${CONFIG_FILE}`));

  const installH = await prompts({
    type: 'confirm',
    name: 'val',
    message: 'Instalar hooks em ~/.claude/settings.json?',
    initial: true,
  });
  if (installH.val === true) {
    await mergeHooks();
    console.log(chalk.green('✓ hooks instalados (Notification, PreToolUse, Stop)'));
  }

  console.log(chalk.bold('\n✓ Setup pronto.'));
  console.log('Próximos passos:');
  console.log('  • `kuroboto start --detach` pra subir o daemon');
  console.log('  • ou direto `kuroboto claude` em qualquer pasta\n');
}

async function fetchChatId(token: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    if (!res.ok) return null;
    const json = (await res.json()) as TelegramGetUpdatesResp;
    if (!json.ok) return null;
    for (const update of [...json.result].reverse()) {
      const id = update.message?.chat?.id;
      if (typeof id === 'number') return id;
    }
    return null;
  } catch {
    return null;
  }
}

interface HookBlock {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

interface ClaudeSettings {
  hooks?: Record<string, HookBlock[]>;
  [key: string]: unknown;
}

async function mergeHooks(): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let json: ClaudeSettings = {};
  try {
    const raw = await fsp.readFile(settingsPath, 'utf-8');
    json = JSON.parse(raw) as ClaudeSettings;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  }
  if (!json.hooks) json.hooks = {};
  const wanted: Array<[string, string]> = [
    ['Notification', 'kuroboto hook notification'],
    ['PreToolUse', 'kuroboto hook pre-tool'],
    ['PostToolUse', 'kuroboto hook post-tool'],
    ['UserPromptSubmit', 'kuroboto hook user-prompt-submit'],
    ['Stop', 'kuroboto hook stop'],
  ];
  for (const [event, cmd] of wanted) {
    const block: HookBlock = { matcher: '', hooks: [{ type: 'command', command: cmd }] };
    const existing = json.hooks[event];
    if (!Array.isArray(existing)) {
      json.hooks[event] = [block];
    } else {
      const filtered = existing.filter(
        (b) => !b.hooks?.some((h) => typeof h.command === 'string' && h.command.includes('kuroboto')),
      );
      filtered.push(block);
      json.hooks[event] = filtered;
    }
  }
  await fsp.writeFile(settingsPath, JSON.stringify(json, null, 2));
}
