import { runHeartbeat } from './heartbeat.js';

export async function run(): Promise<void> {
  await runHeartbeat('UserPromptSubmit');
}
