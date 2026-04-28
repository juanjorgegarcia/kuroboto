export interface NotificationPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: 'Notification';
  message?: string;
}

export interface PreToolUsePayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface StopPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: 'Stop';
  stop_hook_active?: boolean;
}

export interface UserPromptSubmitPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: 'UserPromptSubmit';
  prompt?: string;
}

export type HookPayload =
  | NotificationPayload
  | PreToolUsePayload
  | StopPayload
  | UserPromptSubmitPayload;

export type Decision =
  | { decision: 'allow'; reason?: string; remember?: boolean }
  | { decision: 'deny'; reason?: string }
  | { decision: 'ask'; reason?: string };

export interface PromptRequest {
  requestId: string;
  text: string;
  buttons: PromptButton[];
}

export type PromptButtonAction = 'allow' | 'allow_remember' | 'deny' | 'deny_note';

export interface PromptButton {
  label: string;
  action: PromptButtonAction;
}

export interface DecisionEvent {
  requestId: string;
  decision: Decision;
}

export interface FreeTextEvent {
  text: string;
}
