import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Shift } from '../api/types';
import { useAuth } from './AuthContext';

const STORAGE_KEY = 'pos_web_shift_v1';

interface ShiftContextValue {
  shift: Shift | null;
  loading: boolean;
  openShift: (locationId: string, openingFloat: number) => Promise<void>;
  closeShift: (closingCounted: number) => Promise<Shift>;
}

const ShiftContext = createContext<ShiftContextValue | null>(null);

export function ShiftProvider({ children }: { children: ReactNode }) {
  const { phone } = useAuth();
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);

  const clearShift = useCallback(() => {
    setShift(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  // Re-attaches to whatever shift this device last had open (survives a
  // page reload mid-shift) -- verifies it's still actually open server-side
  // rather than trusting the stale local id blindly.
  const rehydrate = useCallback(async () => {
    setLoading(true);
    try {
      const storedId = localStorage.getItem(STORAGE_KEY);
      if (!storedId) {
        setShift(null);
        return;
      }
      const found = await api<Shift>(`/shifts/${storedId}`);
      if (found.closedAt) clearShift();
      else setShift(found);
    } catch {
      clearShift();
    } finally {
      setLoading(false);
    }
  }, [clearShift]);

  useEffect(() => {
    if (phone) {
      void rehydrate();
    } else {
      setShift(null);
      setLoading(false);
    }
  }, [phone, rehydrate]);

  const openShift = async (locationId: string, openingFloat: number) => {
    // The API allows only one open shift per location -- recover it
    // instead of erroring if one already exists (e.g. another tab/device
    // opened it, or this device lost its localStorage).
    const existing = await api<Shift[]>(`/shifts?locationId=${locationId}&openOnly=true`);
    const open = existing[0] ?? (await api<Shift>('/shifts', { method: 'POST', body: JSON.stringify({ locationId, openingFloat }) }));
    localStorage.setItem(STORAGE_KEY, open.id);
    setShift(open);
  };

  const closeShift = async (closingCounted: number) => {
    if (!shift) throw new Error('لا توجد وردية مفتوحة');
    const closed = await api<Shift>(`/shifts/${shift.id}/close`, {
      method: 'POST',
      body: JSON.stringify({ closingCounted }),
    });
    clearShift();
    return closed;
  };

  return <ShiftContext.Provider value={{ shift, loading, openShift, closeShift }}>{children}</ShiftContext.Provider>;
}

export function useShift() {
  const ctx = useContext(ShiftContext);
  if (!ctx) throw new Error('useShift must be used within ShiftProvider');
  return ctx;
}
