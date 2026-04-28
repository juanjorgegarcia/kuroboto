import notifier from 'node-notifier';

export type NotifyLevel = 'success' | 'error';

export interface DesktopNotifyOpts {
  title: string;
  body: string;
  level: NotifyLevel;
}

export interface DesktopNotifyDeps {
  notify?: (
    notification: { title: string; message: string; sound: boolean; wait: boolean },
    callback: (err: Error | null) => void,
  ) => void;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const defaultNotify: NonNullable<DesktopNotifyDeps['notify']> = (notification, callback) => {
  notifier.notify(notification, callback);
};

export async function notifyDesktop(
  opts: DesktopNotifyOpts,
  deps: DesktopNotifyDeps = {},
): Promise<void> {
  const notify = deps.notify ?? defaultNotify;
  const log = deps.log ?? (() => {});
  const sound = opts.level === 'error';
  return new Promise<void>((resolve) => {
    try {
      notify(
        { title: opts.title, message: opts.body, sound, wait: false },
        (err) => {
          if (err) log('desktop notify failed', { err: err.message });
          resolve();
        },
      );
    } catch (e) {
      log('desktop notify threw', { err: (e as Error).message });
      resolve();
    }
  });
}
