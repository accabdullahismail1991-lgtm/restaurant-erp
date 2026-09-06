import { useNetwork } from '../context/NetworkContext';

export default function OfflineBanner() {
  const { online, pendingCount, failedCount } = useNetwork();
  if (online && pendingCount === 0 && failedCount === 0) return null;

  return (
    <div className={`offline-banner${online ? '' : ' offline'}`}>
      {!online && <span>📴 لا يوجد اتصال -- المبيعات تُحفظ محليًا وستُزامن تلقائيًا عند عودة الاتصال</span>}
      {online && pendingCount > 0 && <span>⏳ جارٍ مزامنة {pendingCount} عملية معلّقة...</span>}
      {failedCount > 0 && <span className="warn">⚠️ {failedCount} عملية فشلت مزامنتها وتحتاج مراجعة يدوية</span>}
    </div>
  );
}
