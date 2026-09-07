import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import type { AppConfig } from '../config.js';

interface Profile {
  userId: string;
  email: string;
  name: string;
  company?: string;
  industryRole?: string;
  phone?: string;
}

export function Home({ config, token }: { config: AppConfig; token: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    apiFetch<Profile>(config, token, '/v1/me')
      .then((p) => live && setProfile(p))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [config, token]);

  if (error) return <p className="error">Could not load profile: {error}</p>;
  if (!profile) return <p className="muted">Loading profile…</p>;

  const save = async (patch: Partial<Profile>) => {
    setSaving(true);
    setError(null);
    try {
      setProfile(
        await apiFetch<Profile>(config, token, '/v1/me', {
          method: 'PUT',
          body: JSON.stringify(patch),
        }),
      );
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h2 style={{ fontSize: 20, letterSpacing: '-0.015em', marginBottom: 4 }}>{profile.name}</h2>
      <p className="deal-header__sub" style={{ marginBottom: 20 }}>{profile.email}</p>

      <div className="panel" style={{ maxWidth: 480 }}>
        <div className="panel__head">
          <h3>Your details</h3>
        </div>
        <form
          className="panel__body form-grid"
          style={{ maxWidth: 'none' }}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void save({
              company: String(data.get('company') ?? ''),
              phone: String(data.get('phone') ?? ''),
            });
          }}
        >
          <label className="field">
            <span>Company</span>
            <input className="input" name="company" defaultValue={profile.company ?? ''} />
          </label>
          <label className="field">
            <span>Phone</span>
            <input className="input" name="phone" defaultValue={profile.phone ?? ''} />
          </label>
          <div>
            <button className="btn btn--primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
