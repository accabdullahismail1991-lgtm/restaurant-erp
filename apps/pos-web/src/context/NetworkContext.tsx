import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { db } from '../offline/db';
import { onOfflineChange } from '../offline/store';
import { runSync } from '../offline/syncEngine';

interface NetworkContextValue {
  online: boolean;
  pendingCount: number; // queued, will auto-retry
  failedCount: number; // server genuinely rejected -- needs a human
}

const NetworkContext = createContext<NetworkContextValue>({ online: true, pendingCount: 0, failedCount: 0 });

// Periodic safety net alongside the window 'online' event: browsers don't
// always fire 'online' reliably (flaky Wi-Fi that never fully drops), so a
// queued sale shouldn't have to wait for that event to eventually sync.
const RETRY_INTERVAL_MS = 20_000;

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);

  const refreshCounts = useCallback(async () => {
    const all = await db.localOrders.toArray();
    let pending = 0;
    let failed = 0;
    for (const o of all) {
      if (o.status === 'sync_failed') failed++;
      else pending++;
    }
    setPendingCount(pending);
    setFailedCount(failed);
  }, []);

  useEffect(() => {
    void refreshCounts();
    return onOfflineChange(refreshCounts);
  }, [refreshCounts]);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      void runSync();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    if (navigator.onLine) void runSync(); // catch up on anything queued from a previous session
    const interval = setInterval(() => void runSync(), RETRY_INTERVAL_MS);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      clearInterval(interval);
    };
  }, []);

  return <NetworkContext.Provider value={{ online, pendingCount, failedCount }}>{children}</NetworkContext.Provider>;
}

export function useNetwork() {
  return useContext(NetworkContext);
}
