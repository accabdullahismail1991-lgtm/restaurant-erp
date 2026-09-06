import { AuthProvider, useAuth } from './context/AuthContext';
import { ShiftProvider, useShift } from './context/ShiftContext';
import { ToastProvider, useToast } from './context/ToastContext';
import { NetworkProvider } from './context/NetworkContext';
import LoginScreen from './screens/LoginScreen';
import ShiftOpenScreen from './screens/ShiftOpenScreen';
import POSScreen from './screens/POSScreen';
import OfflineBanner from './components/OfflineBanner';

function Toast() {
  const { toast } = useToast();
  if (!toast) return null;
  return <div className={`toast${toast.kind === 'err' ? ' err' : ''}`}>{toast.text}</div>;
}

function Gate() {
  const { phone } = useAuth();
  const { shift, loading } = useShift();

  if (!phone) return <LoginScreen />;
  if (loading) return <div className="loading-screen">جارٍ التحميل...</div>;
  if (!shift) return <ShiftOpenScreen />;
  return <POSScreen />;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <ShiftProvider>
          <NetworkProvider>
            <OfflineBanner />
            <Gate />
            <Toast />
          </NetworkProvider>
        </ShiftProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
