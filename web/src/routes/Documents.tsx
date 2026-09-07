import { useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities, DocRequest, DocumentRow, DocVersion, DealsApi } from '../deals-api.js';
import { scopeTag } from '../theme.js';
import { SignaturePanel } from './SignaturePanel.js';

const CATEGORIES = [
  'Purchase Agreement',
  'Disclosure',
  'Inspection',
  'Title',
  'Financing',
  'Appraisal',
  'Closing',
  'Other',
];
const SCOPES = ['deal_wide', 'side_private:buy', 'side_private:sell'];

/** PUT the file straight to S3 using the presigned URL. Content-Type must match what was signed. */
async function putToS3(url: string, file: File, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: file,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
}

export function Documents({
  api,
  dealId,
  capabilities,
  myUserId,
}: {
  api: DealsApi;
  dealId: string;
  capabilities: Capabilities;
  myUserId: string;
}) {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [requests, setRequests] = useState<DocRequest[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uploadFile = useRef<HTMLInputElement>(null);
  const versionFile = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api
      .documents(dealId)
      .then((r) => setDocs(r.documents))
      .catch((e: unknown) => setErr(String(e)));
    api
      .docRequests(dealId)
      .then((r) => setRequests(r.requests))
      .catch(() => {});
  }, [api, dealId]);

  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!openId) {
      setVersions([]);
      return;
    }
    api
      .document(dealId, openId)
      .then((r) => setVersions(r.versions))
      .catch((e: unknown) => setErr(String(e)));
  }, [api, dealId, openId]);

  const open = async (docId: string, n: number, mode: 'view' | 'download') => {
    try {
      const r =
        mode === 'download'
          ? await api.documentDownloadUrl(dealId, docId, n)
          : await api.documentViewUrl(dealId, docId, n);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      setErr(String(e));
    }
  };

  const submitUpload = async (form: HTMLFormElement) => {
    const d = new FormData(form);
    const file = uploadFile.current?.files?.[0];
    if (!file) return;
    const contentType = file.type || 'application/octet-stream';
    setBusy(true);
    setErr(null);
    try {
      const { uploadUrl } = await api.createDocument(dealId, {
        category: String(d.get('category')),
        title: String(d.get('title')),
        description: String(d.get('description') || '') || undefined,
        scope: String(d.get('scope')),
        filename: file.name,
        contentType,
      });
      await putToS3(uploadUrl, file, contentType);
      form.reset();
      load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitVersion = async (docId: string) => {
    const file = versionFile.current?.files?.[0];
    if (!file) return;
    const contentType = file.type || 'application/octet-stream';
    setBusy(true);
    setErr(null);
    try {
      const { uploadUrl } = await api.addDocumentVersion(dealId, docId, {
        filename: file.name,
        contentType,
      });
      await putToS3(uploadUrl, file, contentType);
      if (versionFile.current) versionFile.current.value = '';
      const r = await api.document(dealId, docId);
      setVersions(r.versions);
      load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = (p: Promise<unknown>) => {
    void p.then(load).catch((e: unknown) => setErr(String(e)));
  };

  return (
    <>
      {err && <p className="error">{err}</p>}

      <form
        className="form-inline"
        style={{ marginBottom: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submitUpload(e.currentTarget);
        }}
      >
        <label className="field" style={{ minWidth: 160 }}>
          <span>Title</span>
          <input className="input" name="title" placeholder="Document title" required />
        </label>
        <label className="field">
          <span>Category</span>
          <select className="select" name="category">
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Visibility</span>
          <select className="select" name="scope">
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {scopeTag(s).label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Notes (optional)</span>
          <input className="input" name="description" placeholder="—" />
        </label>
        <label className="field">
          <span>File</span>
          <input className="input" ref={uploadFile} type="file" required />
        </label>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Category</th>
              <th>Visibility</th>
              <th>v</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => {
              const s = scopeTag(doc.scope);
              return (
                <tr key={doc.docId}>
                  <td>
                    <button
                      className="linkbtn"
                      onClick={() => setOpenId(openId === doc.docId ? null : doc.docId)}
                    >
                      {doc.title}
                    </button>
                  </td>
                  <td className="muted">{doc.category}</td>
                  <td>
                    <span className={s.cls}>{s.label}</span>
                  </td>
                  <td className="num">{doc.currentVersion}</td>
                  <td>
                    <span className="btn-row">
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => open(doc.docId, doc.currentVersion, 'view')}
                      >
                        View
                      </button>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => open(doc.docId, doc.currentVersion, 'download')}
                      >
                        Download
                      </button>
                      {doc.scope.startsWith('side_private') && capabilities.promoteDocument && (
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => act(api.promoteDocument(dealId, doc.docId))}
                        >
                          Promote → deal-wide
                        </button>
                      )}
                      {capabilities.deleteDocument && (
                        <button
                          className="btn btn--danger btn--sm"
                          onClick={() =>
                            act(
                              api
                                .deleteDocument(dealId, doc.docId)
                                .then(() =>
                                  setErr(
                                    'Delete requested — a counterparty lead must approve the handshake.',
                                  ),
                                ),
                            )
                          }
                        >
                          Request delete
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
            {docs.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <span className="empty">No documents visible to you.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openId && (
        <div className="card" style={{ marginTop: 10 }}>
          <h4 style={{ marginTop: 0 }}>Versions</h4>
          <ul className="section-list">
            {versions.map((v) => (
              <li key={v.n}>
                <span className="num">v{v.n}</span>
                <span>{v.filename}</span>
                {v.note && <span className="muted">— {v.note}</span>}
                <span className="btn-row" style={{ marginLeft: 'auto' }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => open(openId, v.n, 'view')}>
                    View
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => open(openId, v.n, 'download')}
                  >
                    Download
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <input className="input" ref={versionFile} type="file" style={{ maxWidth: 260 }} />
            <button className="btn btn--sm" disabled={busy} onClick={() => void submitVersion(openId)}>
              Add version
            </button>
          </div>

          <SignaturePanel
            api={api}
            dealId={dealId}
            docId={openId}
            myUserId={myUserId}
            canSend={!!capabilities.sendForSignature}
          />
        </div>
      )}

      <h4>Document requests</h4>
      {capabilities.createDocRequest && (
        <form
          className="form-inline"
          style={{ marginBottom: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            act(
              api.createDocRequest(dealId, {
                category: String(d.get('category')),
                note: String(d.get('note') || '') || undefined,
                targetRole: String(d.get('targetRole') || '') || undefined,
                scope: String(d.get('scope')),
              }),
            );
            e.currentTarget.reset();
          }}
        >
          <label className="field">
            <span>Category</span>
            <select className="select" name="category">
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Visibility</span>
            <select className="select" name="scope">
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {scopeTag(s).label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Target role</span>
            <input className="input" name="targetRole" placeholder="e.g. SELLER_AGENT" required />
          </label>
          <label className="field" style={{ minWidth: 150 }}>
            <span>Note</span>
            <input className="input" name="note" placeholder="—" />
          </label>
          <button className="btn" type="submit">
            Request
          </button>
        </form>
      )}
      <ul className="section-list">
        {requests.map((r) => (
          <li key={r.reqId}>
            <span className={`pill pill--${r.status === 'open' ? 'warn' : r.status === 'fulfilled' ? 'ok' : 'danger'}`}>
              {r.status}
            </span>
            <span>{r.category}</span>
            <span className={scopeTag(r.scope).cls}>{scopeTag(r.scope).label}</span>
            {r.targetRole && <span className="muted">for {r.targetRole}</span>}
            {r.note && <span className="muted">— {r.note}</span>}
            {r.status === 'open' && (
              <span className="btn-row" style={{ marginLeft: 'auto' }}>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    const docId = window.prompt('docId that fulfills this request?');
                    if (docId) act(api.fulfillDocRequest(dealId, r.reqId, docId));
                  }}
                >
                  Fulfil
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() =>
                    act(api.declineDocRequest(dealId, r.reqId, window.prompt('reason?') || undefined))
                  }
                >
                  Decline
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => act(api.cancelDocRequest(dealId, r.reqId))}
                >
                  Cancel
                </button>
              </span>
            )}
          </li>
        ))}
        {requests.length === 0 && (
          <li>
            <span className="empty">None.</span>
          </li>
        )}
      </ul>
    </>
  );
}
