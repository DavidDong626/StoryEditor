import { useRef, useState, useSyncExternalStore } from 'react';
import { useDialogFocus } from './useDialogFocus';

interface Request {
  message: string;
  initial?: string;
  resolve: (value: string | null | boolean) => void;
}
let current: Request | null = null;
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((callback) => callback());
function request(message: string, initial?: string) {
  return new Promise<string | null | boolean>((resolve) => {
    // Multiple actions are blocked by the overlay, but safely cancel any displaced request.
    current?.resolve(initial === undefined ? false : null);
    current = { message, initial, resolve };
    notify();
  });
}
export const askConfirmation = async (message: string) => (await request(message)) === true;
export const askText = async (message: string, initial = '') => {
  const result = await request(message, initial);
  return typeof result === 'string' ? result : null;
};
function finish(value: string | null | boolean) {
  const old = current;
  current = null;
  notify();
  old?.resolve(value);
}
function Dialog({ value }: { value: Request }) {
  const [text, setText] = useState(value.initial ?? '');
  const ref = useRef<HTMLElement>(null);
  const isPrompt = value.initial !== undefined;
  useDialogFocus(ref, () => finish(isPrompt ? null : false));
  return (
    <div className="modal-backdrop confirmation-overlay">
      <section
        ref={ref}
        className="modal confirmation-modal"
        role="dialog"
        aria-modal="true"
        aria-label={isPrompt ? '填写名称' : '确认操作'}
      >
        <div className="modal-content">
          <h2>{isPrompt ? value.message : '确认操作'}</h2>
          {!isPrompt && <p className="confirmation-message">{value.message}</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!isPrompt || text.trim()) finish(isPrompt ? text : true);
            }}
          >
            {isPrompt && (
              <input
                autoFocus
                aria-label={value.message}
                value={text}
                maxLength={200}
                onChange={(e) => setText(e.target.value)}
              />
            )}
            <div className="confirmation-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => finish(isPrompt ? null : false)}
              >
                取消
              </button>
              <button type="submit" className="primary-button" disabled={isPrompt && !text.trim()}>
                {isPrompt ? '确定' : '确认'}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
export default function DialogHost() {
  const value = useSyncExternalStore(
    (callback) => {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    () => current,
  );
  return value ? <Dialog key={value.message} value={value} /> : null;
}
