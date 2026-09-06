import { useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities, DocRequest, DocumentRow, DocVersion, DealsApi } from '../deals-api.js';

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
}: {
  api: DealsApi;
  dealId: string;
  capabilities: Capabilities;
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
    <section>
      <h3>Document room</h3>
      {err && <p style={{ color: '#b00' }}>{err}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitUpload(e.currentTarget);
        }}
      >
        <input name="title" placeholder="Document title" required />{' '}
        <select name="category">
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>{' '}
        <select name="scope">
          {SCOPES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>{' '}
        <input name="description" placeholder="description (optional)" />{' '}
        <input ref={uploadFile} type="file" required />{' '}
        <button type="submit" disabled={busy}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      <table style={{ marginTop: '1rem', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Title</th>
            <th align="left">Category</th>
            <th align="left">Scope</th>
            <th align="left">v</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {docs.map((doc) => (
            <tr key={doc.docId}>
              <td>
                <button onClick={() => setOpenId(openId === doc.docId ? null : doc.docId)}>
                  {doc.title}
                </button>
              </td>
              <td>{doc.category}</td>
              <td>{doc.scope}</td>
              <td>{doc.currentVersion}</td>
              <td>
                <button onClick={() => open(doc.docId, doc.currentVersion, 'view')}>view</button>{' '}
                <button onClick={() => open(doc.docId, doc.currentVersion, 'download')}>
                  download
                </button>{' '}
                {doc.scope.startsWith('side_private') && capabilities.promoteDocument && (
                  <button onClick={() => act(api.promoteDocument(dealId, doc.docId))}>
                    promote → deal-wide
                  </button>
                )}{' '}
                {capabilities.deleteDocument && (
                  <button
                    onClick={() =>
                      act(
                        api
                          .deleteDocument(dealId, doc.docId)
                          .then(() =>
                            setErr('Delete requested — a counterparty lead must approve the handshake.'),
                          ),
                      )
                    }
                  >
                    request delete
                  </button>
                )}
              </td>
            </tr>
          ))}
          {docs.length === 0 && (
            <tr>
              <td colSpan={5}>No documents visible to you.</td>
            </tr>
          )}
        </tbody>
      </table>

      {openId && (
        <div style={{ border: '1px solid #ccc', padding: 8, marginTop: 8 }}>
          <strong>Versions</strong>
          <ul>
            {versions.map((v) => (
              <li key={v.n}>
                v{v.n} — {v.filename}{' '}
                <button onClick={() => open(openId, v.n, 'view')}>view</button>{' '}
                <button onClick={() => open(openId, v.n, 'download')}>download</button>
                {v.note ? ` — ${v.note}` : ''}
              </li>
            ))}
          </ul>
          <input ref={versionFile} type="file" />{' '}
          <button disabled={busy} onClick={() => void submitVersion(openId)}>
            Add version
          </button>
        </div>
      )}

      <h4>Document requests</h4>
      {capabilities.createDocRequest && (
        <form
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
          <select name="category">
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>{' '}
          <select name="scope">
            {SCOPES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>{' '}
          <input name="targetRole" placeholder="target role (e.g. SELLER_AGENT)" required />{' '}
          <input name="note" placeholder="note" />{' '}
          <button type="submit">Request</button>
        </form>
      )}
      <ul>
        {requests.map((r) => (
          <li key={r.reqId}>
            [{r.status}] {r.category} · {r.scope}
            {r.targetRole ? ` · for ${r.targetRole}` : ''}
            {r.note ? ` — ${r.note}` : ''}{' '}
            {r.status === 'open' && (
              <>
                <button
                  onClick={() => {
                    const docId = window.prompt('docId that fulfills this request?');
                    if (docId) act(api.fulfillDocRequest(dealId, r.reqId, docId));
                  }}
                >
                  fulfill
                </button>{' '}
                <button
                  onClick={() =>
                    act(api.declineDocRequest(dealId, r.reqId, window.prompt('reason?') || undefined))
                  }
                >
                  decline
                </button>{' '}
                <button onClick={() => act(api.cancelDocRequest(dealId, r.reqId))}>cancel</button>
              </>
            )}
          </li>
        ))}
        {requests.length === 0 && <li>None.</li>}
      </ul>
    </section>
  );
}
