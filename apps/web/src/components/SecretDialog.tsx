import { useState } from 'react';
import { Modal } from './Modal';

interface SecretDialogProps {
  readonly title: string;
  /** What the secret is, for example "API key". */
  readonly label: string;
  readonly secret: string;
  /** Called when the dialog closes; the caller must drop the secret then. */
  readonly onClose: () => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Shows a secret the API returns only once, with a copy button and a warning
 * that it will not be shown again. The secret lives only in the caller's state
 * while this dialog is open.
 */
export function SecretDialog({
  title,
  label,
  secret,
  onClose,
}: SecretDialogProps) {
  const [copy, setCopy] = useState<CopyState>('idle');

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <Modal
      title={title}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          I have stored it, close
        </button>
      }
    >
      <div className="alert alert-warning">
        Copy the {label} now. It will not be shown again and cannot be
        recovered.
      </div>
      <label htmlFor="one-time-secret" className="form-label">
        {label}
      </label>
      <div className="input-group">
        <input
          id="one-time-secret"
          type="text"
          className="form-control font-monospace"
          readOnly
          value={secret}
          onFocus={(event) => event.target.select()}
        />
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={() => void copySecret()}
        >
          Copy
        </button>
      </div>
      {copy === 'copied' ? (
        <div className="form-text text-success">Copied to the clipboard.</div>
      ) : null}
      {copy === 'failed' ? (
        <div className="form-text text-danger">
          The browser did not allow copying. Select the text and copy it by
          hand.
        </div>
      ) : null}
    </Modal>
  );
}
