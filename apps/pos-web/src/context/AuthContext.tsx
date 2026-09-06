import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { currentAuth, login as apiLogin, logout as apiLogout, onAuthChange } from '../api/client';

interface AuthContextValue {
  phone: string | null;
  login: (phone: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phone, setPhone] = useState<string | null>(() => currentAuth()?.phone ?? null);

  // api/client.ts can log the session out on its own (a 401 whose token
  // refresh also failed) -- this keeps React in sync with that without
  // every call site having to remember to do it.
  useEffect(() => onAuthChange(() => setPhone(currentAuth()?.phone ?? null)), []);

  const login = async (p: string, password: string) => {
    await apiLogin(p, password);
    setPhone(p);
  };
  const logout = () => apiLogout();

  return <AuthContext.Provider value={{ phone, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
