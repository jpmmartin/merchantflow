import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AppNotification } from '../api/notifications';
import { ErrorAlert } from './ErrorAlert';
import { formatTime } from './format';
import {
  notificationAmount,
  notificationPath,
  notificationTitle,
} from './notification-labels';
import { useNotifications } from './NotificationsProvider';

/**
 * The bell of the navigation bar: the unread count, and a tray with the
 * latest notifications. A click on one marks it as read and opens its
 * payment; **Mark all as read** and **Load more** act on the tray. Tray and
 * stream errors show their code and correlation ID.
 */
export function NotificationBell() {
  const notifications = useNotifications();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const container = useRef<HTMLDivElement>(null);

  // The tray closes when the page changes or on a click outside it.
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (
        container.current !== null &&
        event.target instanceof Node &&
        !container.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (notifications === undefined) return null;
  const { items, unreadCount } = notifications;

  function openNotification(notification: AppNotification) {
    if (notification.read_at === null) notifications?.markRead(notification.id);
    void navigate(notificationPath(notification));
  }

  return (
    <div className="position-relative me-3" ref={container}>
      <button
        type="button"
        className="btn btn-outline-light btn-sm position-relative"
        aria-label={`Notifications, ${unreadCount} unread`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">🔔</span>
        {notifications.connected ? null : (
          <span className="visually-hidden">(reconnecting)</span>
        )}
        {unreadCount === 0 ? null : (
          <span className="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger">
            {unreadCount}
          </span>
        )}
      </button>
      {open ? (
        <div
          className="dropdown-menu dropdown-menu-end show p-0 shadow"
          style={{
            right: 0,
            left: 'auto',
            width: 380,
            maxHeight: '70vh',
            overflowY: 'auto',
          }}
          data-bs-theme="light"
        >
          <div className="d-flex align-items-center justify-content-between px-3 py-2 border-bottom">
            <strong>Notifications</strong>
            <button
              type="button"
              className="btn btn-link btn-sm p-0"
              disabled={unreadCount === 0}
              onClick={() => notifications.markAllRead()}
            >
              Mark all as read
            </button>
          </div>
          {notifications.connected ? null : (
            <div className="px-3 pt-2 small text-body-secondary">
              Live updates are reconnecting…
            </div>
          )}
          <div className="px-3 pt-2">
            <ErrorAlert error={notifications.trayError} />
            <ErrorAlert error={notifications.streamError} />
          </div>
          {items.length === 0 ? (
            <div className="px-3 pb-3 text-body-secondary">
              No notifications yet.
            </div>
          ) : (
            <ul className="list-group list-group-flush">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={`list-group-item list-group-item-action${item.read_at === null ? '' : ' text-body-secondary'}`}
                >
                  <button
                    type="button"
                    className="btn btn-link text-start text-decoration-none text-reset p-0 w-100"
                    onClick={() => openNotification(item)}
                  >
                    <div className="d-flex justify-content-between">
                      <span className={item.read_at === null ? 'fw-bold' : ''}>
                        {notificationTitle(item)}
                      </span>
                      <span className="small">{notificationAmount(item)}</span>
                    </div>
                    <div className="small">{item.summary}</div>
                    <div className="small text-body-secondary">
                      {formatTime(item.created_at)}
                    </div>
                  </button>
                  {item.read_at === null ? (
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-sm mt-1"
                      onClick={() => notifications.markRead(item.id)}
                    >
                      Mark as read
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {notifications.hasMore ? (
            <div className="px-3 py-2 border-top">
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm w-100"
                onClick={() => notifications.loadMore()}
              >
                Load more
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
