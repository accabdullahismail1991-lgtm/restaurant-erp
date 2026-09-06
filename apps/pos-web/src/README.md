# pos-web — واجهة الكاشير

React app حقيقي (مبني ومُختبر e2e عبر Playwright ضد الـ API الحقيقي، أونلاين وبدون اتصال): تسجيل
دخول (`context/AuthContext.tsx`)، فتح/إغلاق وردية (`context/ShiftContext.tsx`، يستعيد الوردية
المفتوحة تلقائيًا عند إعادة تحميل الصفحة)، شاشة الكاشير الرئيسية (`screens/POSScreen.tsx`) مع شبكة
المنيو (`components/MenuGrid.tsx`)، السلة (`components/CartPanel.tsx`)، شاشة الدفع
(`components/PaymentModal.tsx`)، ولوحة طلبات الوردية (`components/OrdersPanel.tsx`).

`makeableCount` في `POSScreen.tsx` يُعيد إنتاج منطق تفجير الوصفة نفسه الموجود في الـ API
(`docs/ARCHITECTURE.md` → "نقطة التكامل الأهم") لعرض تلميح توفر مخزون في الواجهة فقط -- السيرفر
يبقى مصدر الحقيقة الوحيد ويتحقق من المخزون فعليًا وبذرية وقت `POST /orders`.

`prototypes/pos_prototype.html` كان المرجع الأصلي لهذا المنطق قبل بناء الواجهة الفعلية، ولا يزال
مفيدًا كنموذج HTML/JS مستقل لفهم التدفق سريعًا.

## Offline-first (المرحلة 8، مكتملة)

- `offline/db.ts` + `offline/store.ts`: IndexedDB (Dexie) لكاش المنيو/الوصفات/الأرصدة، وجدول
  `localOrders` كطابور مزامنة -- كل بيع/دفع/إلغاء وقت انقطاع الاتصال يُكتب هناك فورًا بمعرّف عميل
  (`local_...`) بدل انتظار الشبكة.
- `offline/syncEngine.ts`: يُعيد تشغيل كل صف معلّق بنفس ترتيب استدعاءات الـ API الحقيقية عند حدث
  `online` أو كل 20 ثانية (`context/NetworkContext.tsx`). صف مكتمل تمامًا يُحذف فورًا لأن السيرفر
  بقى المصدر الوحيد للحقيقة عنه.
- `api/client.ts`'s `isNetworkError`: يفرّق بين فشل شبكة حقيقي (`TypeError` من `fetch`، يُعاد
  لاحقًا) ورفض سيرفر حقيقي (نفاد مخزون فعلي مثلًا -- لا يُعاد آليًا، يُعلَّم `sync_failed` في
  `OrdersPanel` لمراجعة يدوية بدل تخمين قرار عمل غير مبرمَج، حسب `docs/ARCHITECTURE.md`).
- `vite.config.ts`'s `vite-plugin-pwa`: Service Worker حقيقي يخزّن قالب التطبيق (JS/CSS/HTML)
  فقط، ولا يتدخل في استدعاءات الـ API إطلاقًا (تلك مسؤولية Dexie أعلاه عمدًا). `npm run dev` لا
  يُفعّله (Vite dev mode) -- لاختباره فعليًا استخدم `npm run build && npx vite preview`.
