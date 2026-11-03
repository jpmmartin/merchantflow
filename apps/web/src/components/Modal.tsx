import type { ReactNode } from 'react';

interface ModalProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}

/**
 * A dialog drawn with Bootstrap's modal classes and controlled by React: it is
 * shown while it is rendered, and the parent removes it to close it. It does
 * not use Bootstrap's JavaScript.
 */
export function Modal({ title, children, footer }: ModalProps) {
  return (
    <>
      <div
        className="modal d-block"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-dialog modal-dialog-centered">
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title h5">{title}</h2>
            </div>
            <div className="modal-body">{children}</div>
            <div className="modal-footer">{footer}</div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}
