import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Location } from '../api/types';
import { useAuth } from '../context/AuthContext';
import { useShift } from '../context/ShiftContext';

export default function ShiftOpenScreen() {
  const { logout } = useAuth();
  const { openShift } = useShift();
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  const [openingFloat, setOpeningFloat] = useState('200');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Location[]>('/locations')
      .then((list) => {
        setLocations(list);
        if (list.length) setLocationId(list[0].id);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'تعذّر جلب الفروع'));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const amount = parseFloat(openingFloat);
    if (!locationId || Number.isNaN(amount) || amount < 0) {
      setError('اختر الفرع واكتب رأس مال افتتاحي صحيح');
      return;
    }
    setBusy(true);
    try {
      await openShift(locationId, amount);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر فتح الوردية');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centered-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1>🕐 فتح وردية جديدة</h1>
        <label>الفرع</label>
        <select className="field" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <label>رأس المال الافتتاحي (نقدي)</label>
        <input
          className="field"
          type="number"
          step="0.01"
          value={openingFloat}
          onChange={(e) => setOpeningFloat(e.target.value)}
        />
        <button className="btn full" type="submit" disabled={busy || !locationId}>
          {busy ? 'جارٍ الفتح...' : 'فتح الوردية'}
        </button>
        <button type="button" className="btn ghost full" style={{ marginTop: 8 }} onClick={logout}>
          خروج
        </button>
        {error && <div className="error-msg">❌ {error}</div>}
      </form>
    </div>
  );
}
