import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import prompts from 'prompts';
import chalk from 'chalk';
import { saveConfig } from '../config/save.js';
import { CONFIG_FILE } from '../config/paths.js';
import type { ConfigT } from '../config/schema.js';
import { TelegramApi } from '../channels/telegram/api.js';
import { validateBotPermissions } from '../channels/telegram/forumValidation.js';

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

  const modeAns = await prompts({
    type: 'select',
    name: 'val',
    message: 'Onde o bot vai postar?',
    choices: [
      { title: 'DM 1:1 (padrão)', value: 'dm', description: 'um único chat com você' },
      {
        title: 'Supergroup com topics',
        value: 'forum',
        description: 'um topic por sessão Claude — recomendado pra multi-sessão',
      },
    ],
    initial: 0,
  });
  const forumMode = modeAns.val === 'forum';

  if (forumMode) {
    console.log(chalk.cyan('\nSupergroup com topics:'));
    console.log('  1. No Telegram, crie um New Group (só você) e converta pra Supergroup');
    console.log('  2. Settings do grupo → "Topics" → ative');
    console.log('  3. Add o bot como Administrator com a permissão "Manage Topics"');
    console.log('  4. Mande qualquer mensagem dentro do supergroup (qualquer topic, ex: General)');
    console.log('     — eu uso essa mensagem pra capturar o chat_id (negativo, começa com -100)');
    await prompts({
      type: 'confirm',
      name: 'val',
      message: 'Pronto, mandou a mensagem? Eu busco o chat_id.',
      initial: true,
    });
  } else {
    console.log(chalk.cyan('\nAbra seu bot no Telegram (busca pelo username dele) e envie /start.'));
    await prompts({
      type: 'confirm',
      name: 'val',
      message: 'Mandou /start? Eu busco o chat_id.',
      initial: true,
    });
  }

  let chatId: number | null = null;
  for (let i = 0; i < 3 && chatId === null; i++) {
    chatId = await fetchChatId(token, forumMode);
    if (chatId === null && i < 2) {
      const retry = await prompts({
        type: 'confirm',
        name: 'val',
        message: forumMode
          ? 'Nada encontrado. Manda outra mensagem no supergroup e tenta de novo?'
          : 'Nada encontrado. Manda /start de novo e tenta de novo?',
        initial: true,
      });
      if (retry.val !== true) break;
    }
  }
  if (chatId === null) {
    console.log(chalk.red('\nNão consegui pegar o chat_id. Rode `kuroboto init` de novo.'));
    return;
  }
  console.log(chalk.green(`✓ chat_id capturado: ${chatId}`));

  if (forumMode) {
    // Hard gate: refuse to save a forum config that won't work at runtime.
    try {
      await validateBotPermissions(new TelegramApi(token), chatId);
      console.log(chalk.green('✓ permissões do bot OK (admin + can_manage_topics)'));
    } catch (e) {
      console.log(chalk.red(`\n${(e as Error).message}`));
      console.log(chalk.yellow('Ajusta as permissões e roda `kuroboto init` de novo.'));
      return;
    }
  }

  const portAns = await prompts({
    type: 'number',
    name: 'val',
    message: 'Porta do daemon (loopback only):',
    initial: 47891,
    min: 1024,
    max: 65535,
  });
  const port = (portAns.val as number) ?? 47891;

  console.log(chalk.cyan('\nQ&A inject (PTY): responda no Telegram quando o Claude pausa pedindo input livre.'));
  console.log('Use `kuroboto claude` para rodar dentro do PTY que recebe as respostas.');
  const injectAns = await prompts({
    type: 'confirm',
    name: 'val',
    message: 'Habilitar Q&A (inject via PTY)?',
    initial: true,
  });
  const inject: ConfigT['inject'] = injectAns.val === true
    ? { enabled: true, strategy: 'pty', replyTimeoutMs: 7_200_000 }
    : { enabled: false, strategy: 'pty', replyTimeoutMs: 7_200_000 };

  console.log(chalk.cyan('\nDesktop notifications: toast nativa do SO quando o sleep mode termina (sucesso, falha ou timeout).'));
  const desktopAns = await prompts({
    type: 'confirm',
    name: 'val',
    message: 'Habilitar desktop notifications? (default: sim)',
    initial: true,
  });
  const desktopEnabled = desktopAns.val === true;

  const authToken = randomBytes(32).toString('hex');
  const config: ConfigT = {
    channel: { type: 'telegram', token, chatId, forumMode },
    daemon: { port, authToken },
    inject,
    policy: {
      permissionTimeoutMs: 55_000,
      notifyDelayMs: 60_000,
      permissionMatchers: ['Bash', 'Edit', 'Write'],
      rememberGranularity: 'tight',
      gamingAlwaysAsk: [],
      sleepMaxDurationMs: 8 * 60 * 60 * 1000,
      sleepWorktreeDir: '~/.kuroboto/worktrees',
      maxConcurrentSleeps: 6,
      sleepModel: 'sonnet',
      failOpen: true,
    },
    notifications: { desktop: desktopEnabled },
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

async function fetchChatId(token: string, forumMode: boolean): Promise<number | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    if (!res.ok) return null;
    const json = (await res.json()) as TelegramGetUpdatesResp;
    if (!json.ok) return null;
    for (const update of [...json.result].reverse()) {
      const id = update.message?.chat?.id;
      if (typeof id !== 'number') continue;
      // In forum mode the chatId is a negative supergroup id (-100…). DM mode
      // is positive. Filter so we don't accidentally pick up an unrelated DM
      // when the user has both kinds of chat with the bot in flight.
      if (forumMode && id >= 0) continue;
      if (!forumMode && id < 0) continue;
      return id;
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
