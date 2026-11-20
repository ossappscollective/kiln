/**
 * Desktop notifications for alerts (docs/alerts.md). Two ways, one function: inside the desktop shell (Tauri) the notification
 * plugin shows a native notification; in a browser the Notification API does, while the page is open. Nothing is sent anywhere:
 * the text is the alert's title only, shown on this computer only.
 *
 * UNVERIFIED: the Tauri path calls the notification plugin's commands through the shell's own IPC (`__TAURI_INTERNALS__`) because no
 * npm package is installed for it. It was written from the plugin's documented commands and has not been run in a built shell.
 */

type Internals = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };

const internals = (): Internals | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;

/** True inside the desktop shell. */
export const inDesktopShell = (): boolean => internals() !== undefined;

export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

export async function notificationState(): Promise<NotifyState> {
  const tauri = internals();
  if (tauri) {
    try {
      return (await tauri.invoke('plugin:notification|is_permission_granted')) === true
        ? 'granted'
        : 'default';
    } catch {
      return 'unsupported';
    }
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission === 'granted'
    ? 'granted'
    : Notification.permission === 'denied'
      ? 'denied'
      : 'default';
}

/** Asks the person (call it from a click). Returns the state afterwards. */
export async function requestNotificationPermission(): Promise<NotifyState> {
  const tauri = internals();
  try {
    if (tauri) {
      const answer = await tauri.invoke('plugin:notification|request_permission');
      return answer === 'granted' ? 'granted' : answer === 'denied' ? 'denied' : 'default';
    }
    if (typeof Notification === 'undefined') return 'unsupported';
    const answer = await Notification.requestPermission();
    return answer === 'granted' ? 'granted' : answer === 'denied' ? 'denied' : 'default';
  } catch {
    return 'unsupported';
  }
}

/**
 * Shows one notification with a title (the alert's title; `alert-desktop.ts` cleans it) and no body: nothing but the title leaves the
 * app. Returns false when it could not (no permission, unsupported). Never throws.
 */
export async function showNotification(title: string): Promise<boolean> {
  if (title === '' || (await notificationState()) !== 'granted') return false;
  const tauri = internals();
  try {
    if (tauri) {
      await tauri.invoke('plugin:notification|notify', { options: { title } });
      return true;
    }
    new Notification(title);
    return true;
  } catch {
    return false;
  }
}

export const notifyStateText: Record<NotifyState, string> = {
  unsupported: 'This window cannot show desktop notifications.',
  default: 'Desktop notifications are not allowed yet.',
  granted: 'Desktop notifications are allowed.',
  denied: 'Desktop notifications are blocked. Allow them in the system or browser settings.',
};
