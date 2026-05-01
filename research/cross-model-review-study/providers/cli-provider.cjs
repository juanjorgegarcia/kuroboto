// Generic subprocess-based provider for CLI tools that have their own auth
// (claude, codex, gemini, copilot). Promptfoo's openai-shim cannot reach these
// because they use OAuth or wrapped auth, not API keys.
//
// Config shape:
//   command:       string — executable name (e.g. "claude")
//   args:          string[] — args; the literal token "${PROMPT}" is replaced
//                  with the rendered prompt. If absent, prompt is piped via stdin.
//   timeoutMs:     number — kill subprocess after this; defaults to 300000 (5min)
//   stripPatterns: { pattern: string, flags?: string }[] — regexes applied to
//                  stdout to strip headers/footers (e.g. codex banner, copilot
//                  token footer). Applied in order.

const { spawn } = require('node:child_process');

class CliProvider {
  constructor(options) {
    this.providerId = options.id || 'cli-provider';
    this.label = options.label || this.providerId;
    this.config = options.config || {};
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt /* string */) {
    const cfg = this.config;
    if (!cfg.command) {
      return { error: `cli-provider config missing "command" for ${this.label}` };
    }
    const argsTemplate = cfg.args || [];
    const usesArgPlaceholder = argsTemplate.some((a) => a === '${PROMPT}');
    const args = argsTemplate.map((a) => (a === '${PROMPT}' ? prompt : a));

    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();

    // Node 24+ refuses to spawn .cmd/.bat directly without shell:true
    // (CVE-2024-27980). Route those through cmd.exe /c on Windows.
    let spawnCmd = cfg.command;
    let spawnArgs = args;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cfg.command)) {
      spawnCmd = process.env.ComSpec || 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', cfg.command, ...args];
    }

    try {
      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(spawnCmd, spawnArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: spawnCmd !== cfg.command, // raw passthrough when going via cmd.exe
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`timed out after ${cfg.timeoutMs ?? 300000}ms`));
        }, cfg.timeoutMs ?? 300000);

        child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => { clearTimeout(timer); resolve(code); });

        if (!usesArgPlaceholder) {
          child.stdin.write(prompt);
        }
        child.stdin.end();
      });

      if (exitCode !== 0) {
        return {
          error: `${cfg.command} exited ${exitCode}: ${stderr.slice(0, 500)}`,
        };
      }
    } catch (e) {
      return { error: `${cfg.command} failed: ${e.message}` };
    }

    let output = stdout;
    for (const sp of cfg.stripPatterns || []) {
      const re = new RegExp(sp.pattern, sp.flags ?? 'g');
      output = output.replace(re, '');
    }
    output = output.trim();

    return {
      output,
      tokenUsage: {},
      cost: 0, // OAuth subscriptions; treat as $0 marginal
      metadata: { durationMs: Date.now() - startedAt, stderrTail: stderr.slice(-200) },
    };
  }
}

module.exports = CliProvider;
