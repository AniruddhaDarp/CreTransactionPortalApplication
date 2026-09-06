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

  if (error) return <p>Could not load profile: {error}</p>;
  if (!profile) return <p>Loading profile…</p>;

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
      <h2>Signed in as {profile.name}</h2>
      <dl>
        <dt>Email</dt>
        <dd>{profile.email}</dd>
        <dt>Company</dt>
        <dd>{profile.company ?? '—'}</dd>
        <dt>Phone</dt>
        <dd>{profile.phone ?? '—'}</dd>
      </dl>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          void save({
            company: String(data.get('company') ?? ''),
            phone: String(data.get('phone') ?? ''),
          });
        }}
      >
        <label>
          Company <input name="company" defaultValue={profile.company ?? ''} />
        </label>{' '}
        <label>
          Phone <input name="phone" defaultValue={profile.phone ?? ''} />
        </label>{' '}
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
    </section>
  );
}
