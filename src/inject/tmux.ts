import { spawn, type SpawnOptions } from 'node:child_process';

export interface InjectStrategy {
  inject(text: string): Promise<void>;
}

export interface TmuxRunResult {
  code: number;
  stderr: string;
}

export type TmuxRunFn = (args: readonly string[]) => Promise<TmuxRunResult>;

export class TmuxInjectStrategy implements InjectStrategy {
  constructor(
    private readonly session: string,
    private readonly run: TmuxRunFn = defaultRun,
  ) {}

  async inject(text: string): Promise<void> {
    // `-l` (literal) writes the bytes verbatim — no key-name parsing — so quotes,
    // `$`, backticks, and embedded newlines round-trip into the user's terminal
    // unmodified. A separate `Enter` press submits.
    await this.runOrThrow(['send-keys', '-t', this.session, '-l', text]);
    await this.runOrThrow(['send-keys', '-t', this.session, 'Enter']);
  }

  private async runOrThrow(args: readonly string[]): Promise<void> {
    const { code, stderr } = await this.run(args);
    if (code !== 0) {
      throw new Error(`tmux ${args.join(' ')} exited ${code}: ${stderr.trim()}`);
    }
  }
}

function defaultRun(args: readonly string[]): Promise<TmuxRunResult> {
  return runTmux(args);
}

export function runTmux(args: readonly string[], opts?: SpawnOptions): Promise<TmuxRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args as string[], { ...opts, shell: false });
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}
