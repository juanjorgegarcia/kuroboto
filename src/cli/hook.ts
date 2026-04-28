export async function hookCommand(type: string): Promise<void> {
  switch (type) {
    case 'notification': {
      const m = await import('../hooks/notification.js');
      await m.run();
      return;
    }
    case 'pre-tool': {
      const m = await import('../hooks/preTool.js');
      await m.run();
      return;
    }
    case 'post-tool': {
      const m = await import('../hooks/postTool.js');
      await m.run();
      return;
    }
    case 'user-prompt-submit': {
      const m = await import('../hooks/userPromptSubmit.js');
      await m.run();
      return;
    }
    case 'stop': {
      const m = await import('../hooks/stop.js');
      await m.run();
      return;
    }
    default:
      process.stderr.write(`[kuroboto] unknown hook type: ${type}\n`);
      process.exit(1);
  }
}
