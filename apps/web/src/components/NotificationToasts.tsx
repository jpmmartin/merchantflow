import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import type { AppNotification } from '../api/notifications';
import {
  notificationAmount,
  notificationPath,
  notificationTitle,
} from './notification-labels';
import { useNotifications } from './NotificationsProvider';

/** How long a toast stays before it hides itself. */
const TOAST_DELAY_MS = 6_000;

/** Toasts kept on screen at once; older ones are dropped. */
const MAX_VISIBLE_TOASTS = 4;

function NotificationToast({
  notification,
  onOpen,
  onDismiss,
}: {
  readonly notification: AppNotification;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
}) {
  // The timer starts once per toast; a new render of the parent keeps it.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const timer = setTimeout(() => dismiss.current(), TOAST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [notification.id]);

  return (
    <div className="toast show" role="alert" aria-atomic="true">
      <div className="toast-header">
        <strong className="me-auto">{notificationTitle(notification)}</strong>
        <small>{notificationAmount(notification)}</small>
        <button
          type="button"
          className="btn-close ms-2"
          aria-label="Close"
          onClick={onDismiss}
        />
      </div>
      <button
        type="button"
        className="toast-body btn btn-link text-start text-decoration-none text-reset w-100"
        onClick={onOpen}
      >
        {notification.summary}{' '}
        <span className="text-primary">Open payment</span>
      </button>
    </div>
  );
}

/**
 * A Bootstrap toast for each notification received live, in the upper right
 * corner, inside an `aria-live` region. Each one hides itself after a few
 * seconds; a click opens the payment it is about and marks it as read.
 */
export function NotificationToasts() {
  const notifications = useNotifications();
  const navigate = useNavigate();
  if (notifications === undefined) return null;
  const visible = notifications.toasts.slice(-MAX_VISIBLE_TOASTS);
  return (
    <div aria-live="polite" aria-atomic="true">
      <div
        className="toast-container position-fixed top-0 end-0 p-3"
        style={{ zIndex: 1090 }}
      >
        {visible.map((notification) => (
          <NotificationToast
            key={notification.id}
            notification={notification}
            onDismiss={() => notifications.dismissToast(notification.id)}
            onOpen={() => {
              notifications.dismissToast(notification.id);
              notifications.markRead(notification.id);
              void navigate(notificationPath(notification));
            }}
          />
        ))}
      </div>
    </div>
  );
}
