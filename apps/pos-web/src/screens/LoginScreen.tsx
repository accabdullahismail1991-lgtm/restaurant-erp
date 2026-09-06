import { FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';

export default function LoginScreen() {
  const { login } = useAuth();
  const [phone, setPhone] = useState('+966500000000');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(phone.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centered-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1>🍽️ كاشير المطعم</h1>
        <label>رقم الجوال</label>
        <input className="field" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="username" />
        <label>كلمة المرور</label>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button className="btn full" type="submit" disabled={busy}>
          {busy ? 'جارٍ الدخول...' : 'تسجيل الدخول'}
        </button>
        {error && <div className="error-msg">❌ {error}</div>}
      </form>
    </div>
  );
}
