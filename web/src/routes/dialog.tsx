import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export type AskOptions = {
  title: string;
  body?: string;
  /** Show a text field. Omit for a plain confirm dialog. */
  input?: boolean;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  /** Disable the confirm button until the field is non-empty. */
  requireValue?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
};

/**
 * Resolves to the entered text for an input dialog (may be an empty string), or
 * `''` for a confirmed plain dialog. Resolves to `null` when the user cancels,
 * presses Escape, or clicks the backdrop.
 */
type Ask = (opts: AskOptions) => Promise<string | null>;

const AskContext = createContext<Ask>(() => Promise.resolve(null));

export function useAsk(): Ask {
  return useContext(AskContext);
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<AskOptions | null>(null);
  const [value, setValue] = useState('');
  const [resolve, setResolve] = useState<{ fn: (v: string | null) => void }>({ fn: () => {} });

  const ask = useCallback<Ask>((o) => {
    setOpts(o);
    setValue(o.defaultValue ?? '');
    return new Promise<string | null>((res) => setResolve({ fn: res }));
  }, []);

  const finish = (v: string | null) => {
    resolve.fn(v);
    setOpts(null);
    setValue('');
  };

  const blocked = !!opts?.input && !!opts.requireValue && !value.trim();

  return (
    <AskContext.Provider value={ask}>
      {children}
      {opts && (
        <div className="modal-backdrop" onMouseDown={() => finish(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={opts.title}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="modal__title">{opts.title}</h3>
            {opts.body && <p className="modal__body">{opts.body}</p>}

            {opts.input &&
              (opts.multiline ? (
                <textarea
                  className="input"
                  rows={3}
                  autoFocus
                  placeholder={opts.placeholder}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !blocked) finish(value);
                    if (e.key === 'Escape') finish(null);
                  }}
                />
              ) : (
                <input
                  className="input"
                  autoFocus
                  placeholder={opts.placeholder}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !blocked) finish(value);
                    if (e.key === 'Escape') finish(null);
                  }}
                />
              ))}

            <div className="modal__actions">
              <button className="btn btn--ghost btn--sm" onClick={() => finish(null)}>
                {opts.cancelLabel ?? 'Cancel'}
              </button>
              <button
                className={`btn btn--sm ${opts.danger ? 'btn--danger' : 'btn--primary'}`}
                disabled={blocked}
                onClick={() => finish(opts.input ? value : '')}
              >
                {opts.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AskContext.Provider>
  );
}
