# pos-web — واجهة الكاشير

React app حقيقي أونلاين (مبني ومُختبر e2e عبر Playwright ضد الـ API الحقيقي): تسجيل دخول
(`context/AuthContext.tsx`)، فتح/إغلاق وردية (`context/ShiftContext.tsx`، يستعيد الوردية المفتوحة
تلقائيًا عند إعادة تحميل الصفحة)، شاشة الكاشير الرئيسية (`screens/POSScreen.tsx`) مع شبكة المنيو
(`components/MenuGrid.tsx`)، السلة (`components/CartPanel.tsx`)، شاشة الدفع
(`components/PaymentModal.tsx`)، ولوحة طلبات الوردية (`components/OrdersPanel.tsx`).

`makeableCount` في `POSScreen.tsx` يُعيد إنتاج منطق تفجير الوصفة نفسه الموجود في الـ API
(`docs/ARCHITECTURE.md` → "نقطة التكامل الأهم") لعرض تلميح توفر مخزون في الواجهة فقط -- السيرفر
يبقى مصدر الحقيقة الوحيد ويتحقق من المخزون فعليًا وبذرية وقت `POST /orders`.

`prototypes/pos_prototype.html` كان المرجع الأصلي لهذا المنطق قبل بناء الواجهة الفعلية، ولا يزال
مفيدًا كنموذج HTML/JS مستقل لفهم التدفق سريعًا.

**المتبقي (المرحلة 8، Offline-first)**: تحويل هذا التطبيق لـ PWA بـ IndexedDB (عبر Dexie، الحزمة
مضافة بالفعل في `package.json`) + Sync Queue، بدل الاعتماد الكامل على اتصال أونلاين مباشر كما هو
الآن (القرار #2 في `docs/DECISIONS.md`).
