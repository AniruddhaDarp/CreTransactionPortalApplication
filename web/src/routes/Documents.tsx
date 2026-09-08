import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Capabilities,
  DocRequest,
  DocumentRow,
  DocVersion,
  DealsApi,
  Handshake,
  SignatureEnvelope,
} from '../deals-api.js';
import { isSameSideDelete, roleLabel, SELL_BLIND_CATEGORIES } from '../roles.js';
import { scopeTag } from '../theme.js';
import { SignaturePanel } from './SignaturePanel.js';
import { useAsk } from './dialog.js';
import { isMembershipSyncing, SYNCING_NOTE } from './sync.js';
import { useMemberNames } from './useMemberNames.js';
import { humanizeError } from './errors.js';
import { usePoll } from './usePoll.js';

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

const fmtDate = (iso?: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

type DocSortKey = 'title' | 'category' | 'scope' | 'currentVersion' | 'updated';
const docSortVal = (d: DocumentRow, k: DocSortKey): string | number => {
  if (k === 'updated') return d.updatedAt ?? d.createdAt ?? '';
  if (k === 'currentVersion') return d.currentVersion;
  return d[k] ?? '';
};

type MenuItem = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean };

/** A compact "Actions ▾" dropdown for a table row. Positioned fixed so it isn't
 *  clipped by the table's horizontal scroll container. */
function RowMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        !btnRef.current?.contains(e.target as Node) &&
        !popRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onScroll = () => setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  return (
    <>
      <button
        ref={btnRef}
        className="btn btn--ghost btn--sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        Actions ▾
      </button>
      {open && (
        <div
          ref={popRef}
          className="rowmenu"
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              disabled={it.disabled}
              className={`rowmenu__item${it.danger ? ' rowmenu__item--danger' : ''}`}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

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
  dealActive,
}: {
  api: DealsApi;
  dealId: string;
  capabilities: Capabilities;
  myUserId: string;
  dealActive: boolean;
}) {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [requests, setRequests] = useState<DocRequest[]>([]);
  const [deleteHs, setDeleteHs] = useState<Handshake[]>([]);
  const [sigs, setSigs] = useState<SignatureEnvelope[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fulfilFor, setFulfilFor] = useState<string | null>(null);
  const [fulfilDoc, setFulfilDoc] = useState('');
  const uploadFile = useRef<HTMLInputElement>(null);
  const versionFile = useRef<HTMLInputElement>(null);
  const { label: nameOf, members, roles } = useMemberNames(api, dealId);
  const myRole = roles[myUserId];
  const mySide = members.find((m) => m.userId === myUserId)?.side;
  const ask = useAsk();

  // Visibility options you may actually pick: your own side's private scope, plus
  // deal-wide only if you can post deal-wide (OTHER cannot). Fall back to all
  // while membership is still loading — the server re-checks regardless.
  const scopeOptions = !mySide
    ? SCOPES
    : SCOPES.filter((s) => {
        if (s === 'deal_wide') return !!capabilities.uploadDealWideDoc;
        if (s === 'side_private:buy') return mySide === 'buy';
        if (s === 'side_private:sell') return mySide === 'sell';
        return false;
      });

  const activeMembers = members.filter((m) => m.status === 'active');
  const openDocs = docs.filter((d) => !d.archivedAt);
  const pendingDelete = (docId: string): Handshake | undefined =>
    deleteHs.find((h) => String(h.payload?.docId ?? '') === docId);

  /** Signature state of a document, from the caller's point of view. */
  const sigStateFor = (docId: string): { label: string; cls: string } | null => {
    const open = sigs.filter((e) => e.docId === docId && e.status === 'sent');
    if (open.length === 0) return null;
    const forMe = open.find((e) =>
      e.recipients.some((r) => r.userId === myUserId && r.status === 'sent'),
    );
    if (forMe) return { label: 'awaiting your signature', cls: 'pill pill--warn' };
    if (open.some((e) => e.createdBy === myUserId))
      return { label: 'sent for signature', cls: 'pill' };
    return { label: 'signature pending', cls: 'pill' };
  };

  const [sort, setSort] = useState<{ key: DocSortKey; dir: 1 | -1 }>({ key: 'updated', dir: -1 });
  const sortBy = (key: DocSortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === 'updated' ? -1 : 1 },
    );
  const arrow = (key: DocSortKey) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');
  const sortedDocs = [...docs].sort((a, b) => {
    const av = docSortVal(a, sort.key);
    const bv = docSortVal(b, sort.key);
    const c =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
    return c * sort.dir;
  });

  const load = useCallback(() => {
    api
      .documents(dealId)
      .then((r) => {
        setDocs(r.documents);
        setErr(null);
      })
      .catch((e: unknown) => setErr(humanizeError(String(e))));
    api
      .docRequests(dealId)
      .then((r) => setRequests(r.requests))
      .catch(() => {});
    api
      .handshakes(dealId)
      .then((r) =>
        setDeleteHs(
          r.handshakes.filter(
            (h) =>
              h.action === 'delete_document' &&
              (h.status === 'pending' || h.status === 'approved'),
          ),
        ),
      )
      .catch(() => {});
    api
      .dealSignatures(dealId)
      .then((r) => setSigs(r.envelopes))
      .catch(() => {});
  }, [api, dealId]);

  usePoll(load, 12_000, [load]);
  // while the membership projection is catching up, retry quickly
  useEffect(() => {
    if (!err || !isMembershipSyncing(err)) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [err, load]);

  useEffect(() => {
    if (!openId) {
      setVersions([]);
      return;
    }
    api
      .document(dealId, openId)
      .then((r) => setVersions(r.versions))
      .catch((e: unknown) => setErr(humanizeError(String(e))));
  }, [api, dealId, openId]);

  const open = async (docId: string, n: number, mode: 'view' | 'download') => {
    try {
      const r =
        mode === 'download'
          ? await api.documentDownloadUrl(dealId, docId, n)
          : await api.documentViewUrl(dealId, docId, n);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      setErr(humanizeError(String(e)));
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
      setErr(humanizeError(String(e)));
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
      setErr(humanizeError(String(e)));
    } finally {
      setBusy(false);
    }
  };

  const act = (p: Promise<unknown>) => {
    void p.then(load).catch((e: unknown) => setErr(humanizeError(String(e))));
  };

  return (
    <>
      {err &&
        (isMembershipSyncing(err) ? (
          <p className="muted">{SYNCING_NOTE}</p>
        ) : (
          <p className="error">{err}</p>
        ))}

      {!dealActive && (
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          The deal is closed — the document room is a permanent record. Every document and version
          stays downloadable; nothing can be uploaded, promoted, deleted or sent for signature.
        </p>
      )}

      {dealActive && (
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
            {scopeOptions.map((s) => (
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
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>
                <button className="th-sort" onClick={() => sortBy('title')}>
                  Title{arrow('title')}
                </button>
              </th>
              <th>
                <button className="th-sort" onClick={() => sortBy('category')}>
                  Category{arrow('category')}
                </button>
              </th>
              <th>
                <button className="th-sort" onClick={() => sortBy('scope')}>
                  Visibility{arrow('scope')}
                </button>
              </th>
              <th className="num">
                <button className="th-sort" onClick={() => sortBy('currentVersion')}>
                  Version{arrow('currentVersion')}
                </button>
              </th>
              <th>
                <button className="th-sort" onClick={() => sortBy('updated')}>
                  Updated{arrow('updated')}
                </button>
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sortedDocs.map((doc) => {
              const s = scopeTag(doc.scope);
              const del = pendingDelete(doc.docId);
              const sig = sigStateFor(doc.docId);
              // The sell side can't see this doc (private scope, or a blind
              // category) -> deleting it needs only the buy side.
              const sameSideDel =
                doc.scope.startsWith('side_private') ||
                SELL_BLIND_CATEGORIES.includes(doc.category);
              return (
                <tr key={doc.docId}>
                  <td>
                    <button
                      className="linkbtn"
                      onClick={() => setOpenId(openId === doc.docId ? null : doc.docId)}
                    >
                      {doc.title}
                    </button>
                    {sig && (
                      <span
                        className={sig.cls}
                        style={{ marginLeft: 6, fontSize: 10.5 }}
                        title="Open the document to sign or manage signatures"
                      >
                        ✍ {sig.label}
                      </span>
                    )}
                  </td>
                  <td className="muted">{doc.category}</td>
                  <td>
                    <span className={s.cls}>{s.label}</span>
                    {del && (
                      <span className="pill pill--warn" style={{ marginLeft: 6, fontSize: 10.5 }}>
                        {del.status === 'approved' ? 'archiving…' : 'deletion pending'}
                      </span>
                    )}
                  </td>
                  <td className="num">{doc.currentVersion}</td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {fmtDate(doc.updatedAt ?? doc.createdAt)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <RowMenu
                      items={[
                        {
                          label: 'View',
                          onClick: () => open(doc.docId, doc.currentVersion, 'view'),
                        },
                        {
                          label: 'Download',
                          onClick: () => open(doc.docId, doc.currentVersion, 'download'),
                        },
                        ...(dealActive &&
                        doc.scope.startsWith('side_private') &&
                        capabilities.promoteDocument &&
                        !del &&
                        !SELL_BLIND_CATEGORIES.includes(doc.category)
                          ? [
                              {
                                label: 'Promote to deal-wide',
                                onClick: () => act(api.promoteDocument(dealId, doc.docId)),
                              },
                            ]
                          : []),
                        ...(dealActive && capabilities.deleteDocument
                          ? [
                              del
                                ? {
                                    label:
                                      del.status === 'approved'
                                        ? 'Archiving…'
                                        : 'Deletion pending approval',
                                    disabled: true,
                                    onClick: () => {},
                                  }
                                : {
                                    label: sameSideDel ? 'Delete' : 'Request delete',
                                    danger: true,
                                    onClick: () =>
                                      act(
                                        api.deleteDocument(dealId, doc.docId).then(() =>
                                          setErr(
                                            sameSideDel
                                              ? 'Delete requested — another lead on your side must approve (it takes effect right away if you’re the only lead).'
                                              : 'Delete requested — a counterparty lead must approve.',
                                          ),
                                        ),
                                      ),
                                  },
                            ]
                          : []),
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
            {docs.length === 0 && (
              <tr>
                <td colSpan={6}>
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
                <span className="num">Version {v.n}</span>
                <span>{v.filename}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {fmtDate(v.uploadedAt)}
                </span>
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
          {dealActive && (
            <div className="btn-row" style={{ marginTop: 8 }}>
              <input className="input" ref={versionFile} type="file" style={{ maxWidth: 260 }} />
              <button
                className="btn btn--sm"
                disabled={busy}
                onClick={() => void submitVersion(openId)}
              >
                Add version
              </button>
            </div>
          )}

          <SignaturePanel
            api={api}
            dealId={dealId}
            docId={openId}
            myUserId={myUserId}
            canSend={dealActive && !!capabilities.sendForSignature}
            dealActive={dealActive}
          />
        </div>
      )}

      {deleteHs.length > 0 && (
        <>
          <h4>Pending document deletions</h4>
          <ul className="section-list">
            {deleteHs.map((h) => {
              const dId = String(h.payload?.docId ?? '');
              const title =
                String(h.payload?.title ?? '') ||
                docs.find((d) => d.docId === dId)?.title ||
                'a document';
              const cat = String(h.payload?.category ?? '');
              const sameSide = isSameSideDelete(h);
              return (
                <li key={h.hsId} style={{ flexWrap: 'wrap' }}>
                  <span className="pill pill--warn">
                    {h.status === 'approved' ? 'archiving' : 'pending'}
                  </span>
                  <span>
                    {title}
                    {cat ? <span className="muted"> · {cat}</span> : null}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    requested by {nameOf(h.initiatedBy)} · awaiting{' '}
                    {sameSide ? `another ${h.initiatedSide}-side lead` : 'a counterparty lead'}
                  </span>
                  {h.status === 'pending' && h.initiatedBy !== myUserId && (
                    <span className="btn-row" style={{ marginLeft: 'auto' }}>
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => act(api.approveHandshake(dealId, h.hsId))}
                      >
                        Approve
                      </button>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={async () => {
                          const reason = await ask({
                            title: 'Reject this deletion?',
                            body: 'The requester will be notified. They can re-propose it.',
                            input: true,
                            placeholder: 'Reason (optional)',
                            danger: true,
                            confirmLabel: 'Reject',
                          });
                          if (reason == null) return;
                          act(api.rejectHandshake(dealId, h.hsId, reason || undefined));
                        }}
                      >
                        Reject
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h4>Document requests</h4>
      {dealActive && capabilities.createDocRequest && (
        <form
          className="form-inline"
          style={{ marginBottom: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            const targetUserId = String(d.get('target') || '');
            if (!targetUserId) return;
            act(
              api.createDocRequest(dealId, {
                category: String(d.get('category')),
                note: String(d.get('note') || '') || undefined,
                targetUserId,
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
              {scopeOptions.map((s) => (
                <option key={s} value={s}>
                  {scopeTag(s).label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 190 }}>
            <span>Request from</span>
            <select className="select" name="target" defaultValue="" required>
              <option value="" disabled>
                Choose a person…
              </option>
              {activeMembers.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {nameOf(m.userId)}
                </option>
              ))}
            </select>
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
            {r.targetUserId ? (
              <span className="muted">for {nameOf(r.targetUserId)}</span>
            ) : r.targetRole ? (
              <span className="muted">for any {roleLabel(r.targetRole)}</span>
            ) : null}
            {r.note && <span className="muted">— {r.note}</span>}
            {(() => {
              if (r.status !== 'open' || !dealActive) return null;
              const forWhom = r.targetUserId
                ? nameOf(r.targetUserId)
                : `any ${roleLabel(r.targetRole) || 'member'}`;
              const isTarget =
                (!!r.targetUserId && r.targetUserId === myUserId) ||
                (!!r.targetRole && r.targetRole === myRole);
              const isRequester = r.createdBy === myUserId;

              // The party who owes the document: fulfil or decline.
              if (isTarget) {
                if (fulfilFor === r.reqId) {
                  return (
                    <span className="btn-row" style={{ marginLeft: 'auto', gap: 6 }}>
                      {openDocs.length === 0 ? (
                        <span className="muted" style={{ fontSize: 12 }}>
                          Upload the document to the room first, then fulfil.
                        </span>
                      ) : (
                        <>
                          <select
                            className="select"
                            value={fulfilDoc}
                            onChange={(e) => setFulfilDoc(e.target.value)}
                          >
                            {openDocs.map((d) => (
                              <option key={d.docId} value={d.docId}>
                                {d.title} · {d.category}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn btn--primary btn--sm"
                            onClick={() => {
                              const pick = fulfilDoc || openDocs[0]?.docId;
                              if (!pick) return;
                              setFulfilFor(null);
                              act(api.fulfillDocRequest(dealId, r.reqId, pick));
                            }}
                          >
                            Confirm
                          </button>
                        </>
                      )}
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => setFulfilFor(null)}
                      >
                        Back
                      </button>
                    </span>
                  );
                }
                return (
                  <span className="btn-row" style={{ marginLeft: 'auto' }}>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        setFulfilDoc(openDocs[0]?.docId ?? '');
                        setFulfilFor(r.reqId);
                      }}
                    >
                      Fulfil
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={async () => {
                        const reason = await ask({
                          title: 'Decline this document request?',
                          body: 'The requester will be notified.',
                          input: true,
                          placeholder: 'Reason (optional)',
                          danger: true,
                          confirmLabel: 'Decline',
                        });
                        if (reason == null) return;
                        act(api.declineDocRequest(dealId, r.reqId, reason || undefined));
                      }}
                    >
                      Decline
                    </button>
                  </span>
                );
              }

              // The requester: waiting; may withdraw their own request.
              if (isRequester) {
                return (
                  <span
                    className="btn-row"
                    style={{ marginLeft: 'auto', gap: 8, alignItems: 'center' }}
                  >
                    <span className="muted" style={{ fontSize: 12 }}>
                      pending — waiting on {forWhom}
                    </span>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => act(api.cancelDocRequest(dealId, r.reqId))}
                    >
                      Cancel
                    </button>
                  </span>
                );
              }

              // Anyone else: read-only status.
              return (
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                  pending — waiting on {forWhom}
                </span>
              );
            })()}
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
