import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '../api/client';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  readNotificationStream,
  type AppNotification,
} from '../api/notifications';

/** Wait before the first reconnection; doubled up to the maximum. */
const FIRST_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * The API sends a keep-alive comment every 15 seconds. A stream that stays
 * silent for three of them is taken as lost and opened again.
 */
const SILENT_STREAM_LIMIT_MS = 45_000;

/** Notifications per tray page. */
const TRAY_PAGE_SIZE = 20;

type NotificationListener = (notification: AppNotification) => void;

interface NotificationsValue {
  readonly items: readonly AppNotification[];
  readonly unreadCount: number;
  readonly hasMore: boolean;
  /** A failed tray call: list, load more, or mark as read. */
  readonly trayError: unknown;
  /** Why the live stream is not connected, while it reconnects. */
  readonly streamError: unknown;
  readonly connected: boolean;
  /** Notifications received live and not dismissed yet. */
  readonly toasts: readonly AppNotification[];
  readonly loadMore: () => void;
  readonly markRead: (id: string) => void;
  readonly markAllRead: () => void;
  readonly dismissToast: (id: string) => void;
  /** Registers a callback for every notification received live. */
  readonly subscribe: (listener: NotificationListener) => () => void;
}

const NotificationsContext = createContext<NotificationsValue | undefined>(
  undefined,
);

/** Waits, or returns early when the signal aborts. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Keeps the signed-in merchant user's notifications: the tray (newest
 * first, with the unread count), the toasts of new ones, and one live stream
 * of the API. The stream is read with `fetch`; after an error or a stream the
 * server ended, it is opened again after a delay that doubles up to 30
 * seconds, resuming after the last notification received, so the API sends
 * what was missed first. A 401 stops it (the app returns to sign-in), and
 * unmounting, which signing out does, closes it.
 */
export function NotificationsProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [items, setItems] = useState<readonly AppNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [trayError, setTrayError] = useState<unknown>(undefined);
  const [streamError, setStreamError] = useState<unknown>(undefined);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<readonly AppNotification[]>([]);
  const listeners = useRef(new Set<NotificationListener>());

  // IDs already in the tray, so a notification sent again after a
  // reconnection is neither counted nor shown twice.
  const known = useRef(new Set<string>());

  const deliver = useCallback((notification: AppNotification) => {
    if (known.current.has(notification.id)) return;
    known.current.add(notification.id);
    setItems((current) => [notification, ...current]);
    setUnreadCount((count) => count + 1);
    setToasts((current) => [...current, notification]);
    for (const listener of listeners.current) listener(notification);
  }, []);

  useEffect(() => {
    const stop = new AbortController();
    let lastId: string | undefined;
    let delay = FIRST_RECONNECT_DELAY_MS;

    const loadTray = async () => {
      try {
        const page = await listNotifications({ limit: TRAY_PAGE_SIZE });
        known.current = new Set(page.data.map((item) => item.id));
        setItems(page.data);
        setNextCursor(page.next_cursor);
        setUnreadCount(page.unread_count);
        setTrayError(undefined);
        if (lastId === undefined) lastId = page.data[0]?.id;
      } catch (caught) {
        setTrayError(caught);
      }
    };

    // The tray is loaded once; what is missed while disconnected comes back
    // through the stream, which resumes after the last notification received.
    const run = async () => {
      await loadTray();
      while (!stop.signal.aborted) {
        const attempt = new AbortController();
        const abortAttempt = () => attempt.abort();
        stop.signal.addEventListener('abort', abortAttempt, { once: true });
        let silence = setTimeout(abortAttempt, SILENT_STREAM_LIMIT_MS);
        try {
          await readNotificationStream({
            after: lastId,
            signal: attempt.signal,
            onActivity: () => {
              clearTimeout(silence);
              silence = setTimeout(abortAttempt, SILENT_STREAM_LIMIT_MS);
              setConnected(true);
              setStreamError(undefined);
              delay = FIRST_RECONNECT_DELAY_MS;
            },
            onNotification: (notification) => {
              lastId = notification.id;
              deliver(notification);
            },
            onFailure: (failure) =>
              setStreamError(
                new ApiError(
                  undefined,
                  failure.code,
                  failure.message,
                  failure.correlationId,
                ),
              ),
          });
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 401) return;
          setStreamError(caught);
        } finally {
          clearTimeout(silence);
          stop.signal.removeEventListener('abort', abortAttempt);
          setConnected(false);
        }
        if (stop.signal.aborted) return;
        await pause(delay, stop.signal);
        delay = Math.min(MAX_RECONNECT_DELAY_MS, delay * 2);
      }
    };

    void run();
    return () => stop.abort();
  }, [deliver]);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    listNotifications({ cursor: nextCursor, limit: TRAY_PAGE_SIZE }).then(
      (page) => {
        const older = page.data.filter((item) => !known.current.has(item.id));
        for (const item of older) known.current.add(item.id);
        setItems((current) => [...current, ...older]);
        setNextCursor(page.next_cursor);
        setUnreadCount(page.unread_count);
        setTrayError(undefined);
      },
      (caught: unknown) => setTrayError(caught),
    );
  }, [nextCursor]);

  const markRead = useCallback((id: string) => {
    markNotificationRead(id).then(
      (result) => {
        const now = new Date().toISOString();
        setItems((current) =>
          current.map((item) =>
            item.id === id && item.read_at === null
              ? { ...item, read_at: now }
              : item,
          ),
        );
        setUnreadCount(result.unread_count);
        setTrayError(undefined);
      },
      (caught: unknown) => setTrayError(caught),
    );
  }, []);

  const markAllRead = useCallback(() => {
    markAllNotificationsRead().then(
      (result) => {
        const now = new Date().toISOString();
        setItems((current) =>
          current.map((item) =>
            item.read_at === null ? { ...item, read_at: now } : item,
          ),
        );
        setUnreadCount(result.unread_count);
        setTrayError(undefined);
      },
      (caught: unknown) => setTrayError(caught),
    );
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const subscribe = useCallback((listener: NotificationListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<NotificationsValue>(
    () => ({
      items,
      unreadCount,
      hasMore: nextCursor !== null,
      trayError,
      streamError,
      connected,
      toasts,
      loadMore,
      markRead,
      markAllRead,
      dismissToast,
      subscribe,
    }),
    [
      items,
      unreadCount,
      nextCursor,
      trayError,
      streamError,
      connected,
      toasts,
      loadMore,
      markRead,
      markAllRead,
      dismissToast,
      subscribe,
    ],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

/** The notifications of the signed-in merchant user, or `undefined` for others. */
export function useNotifications(): NotificationsValue | undefined {
  return useContext(NotificationsContext);
}

/**
 * Calls `onNotification` for every notification received live while the
 * component is mounted. It does nothing outside the provider.
 */
export function useNotificationListener(
  onNotification: NotificationListener,
): void {
  const subscribe = useContext(NotificationsContext)?.subscribe;
  const latest = useRef(onNotification);
  useEffect(() => {
    latest.current = onNotification;
  }, [onNotification]);
  useEffect(() => {
    if (subscribe === undefined) return undefined;
    return subscribe((notification) => latest.current(notification));
  }, [subscribe]);
}
