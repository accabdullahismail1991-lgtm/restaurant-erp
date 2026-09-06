# Restaurant ERP — نظام تشغيل سلسلة مطاعم متكامل

نظام مخصص (Full Custom) يربط الكاشير بالمبيعات والإنتاج والمشتريات والمخزون في دورة واحدة متكاملة،
لسلسلة فروع بعلامة تجارية واحدة تتضمن مطبخ مركزي (Central Kitchen) وفروع (Branches).

هذا المشروع تحت البناء المرحلي — راجع `docs/DECISIONS.md` للقرارات المعمارية الكاملة،
و`docs/ARCHITECTURE.md` لخطة التنفيذ المرحلية (Roadmap).

## الحالة الحالية

- ✅ توثيق كامل للقرارات المعمارية (`docs/DECISIONS.md`)
- ✅ مخطط معماري عالي المستوى (`docs/ARCHITECTURE.md`)
- ✅ مخطط قاعدة بيانات كامل (Prisma schema) يغطي كل الوحدات المتفق عليها
- ✅ **المرحلة 1 مكتملة وتعمل فعليًا (ليست مجرد هيكل)**: تسجيل دخول (Phone + Password)،
  JWT (access + refresh)، RBAC مرن (Role → Permission، غير مبرمج ثابت بالكود)، Scope على
  مستوى الموقع (فرع/مؤسسة)، وحدتا `users` و`branches` (Locations) بعمليات CRUD كاملة —
  15 اختبار e2e حقيقي في `apps/api/test/app.e2e-spec.ts`
- ✅ **المرحلة 2 مكتملة وتعمل فعليًا**: `ingredients` (خامات + نصف مصنّعة، كل نصف مصنّع
  له وصفته الخاصة) و`items` (أصناف منيو ووصفاتها) — BOM متعدد المستويات حقيقي (صنف نصف
  مصنّع يُستخدم كمكوّن داخل صنف منيو)، مع منع الدورات (Cycle) والمكوّنات الوهمية — 8 اختبارات
  e2e في `apps/api/test/recipes.e2e-spec.ts`
- ✅ **المرحلتان 3+4 مكتملتان وتعملان فعليًا** (بُنيتا معًا لأن البيع يحتاج خصم مخزون حقيقي):
  `inventory` (دفعات `InventoryBatch` + سجل حركات `StockMovement` FIFO + أرصدة مجمّعة، واستلام/تسوية/تالف
  عبر `inventory.adjust`) و`sales` (ورديات بتسوية نقدية كاملة، وطلبات تخصم مكوّنات وصفتها من المخزون
  **بذرية DB transaction واحدة** -- الطلب وخصم كل مكوّن ينجحان معًا أو يفشلان معًا -- ثم دفع، ثم إلغاء
  عبر `pos.void_order` بيرجّع بالضبط ما استُهلك لنفس الدفعات) — 13 اختبار e2e في
  `apps/api/test/sales.e2e-spec.ts`. الجرد الدوري (Stocktake) -- جزء من المرحلة 4 الأصلية -- لسه
  بلا منطق/Endpoints (الجدول موجود بالمخطط فقط).
- ✅ **المرحلة 5 مكتملة وتعمل فعليًا**: `purchasing` -- موردون (`suppliers`، مع موردين مخصصين
  لموقع واحد أو متاحين للكل)، **مصفوفة موافقات حقيقية غير مبرمجة بالكود** (`ApprovalRule`
  تُدار عبر `approval-rules` بصلاحية `purchasing.manage_rules`، تُطابق المستند حسب المبلغ
  والموقع وتحدد الدور المطلوب فعليًا لا مجرد صلاحية)، ودورة حياة أمر شراء كاملة: مسودة → تقديم
  (اعتماد تلقائي لو مفيش قاعدة تغطيه، أو انتظار موافقة الدور المحدد) → اعتماد/رفض → إرسال
  للمورد → **استلام يُنشئ `InventoryBatch` حقيقية عبر نفس `InventoryService.receive`** (بلا تكرار
  منطق) → أو إلغاء. 20 اختبار e2e في `apps/api/test/purchasing.e2e-spec.ts`.
- ⬜ لم يُبنَ بعد: بقية الوحدات (`production`, `transfers`)، Frontend فعلي، آلية المزامنة
  Offline-first، تكامل ZATCA (توليد/توقيع الفاتورة فعليًا)، تكامل الدفع

## تشغيل المشروع محليًا

```bash
# 1) قاعدة بيانات PostgreSQL -- عبر Docker (الافتراضي) أو سيرفر محلي موجود بالفعل
docker compose up -d          # أو: تأكد إن سيرفر PostgreSQL محلي شغال ومتاح على نفس القيم بالأسفل

cd apps/api
cp .env.example .env          # عدّل DATABASE_URL/JWT_SECRET لو لزم
npm install
npm run prisma:migrate        # ينشئ الجداول
npm run prisma:seed           # يزرع صلاحيات/أدوار أساسية + مستخدم مدير (راجع الناتج في التيرمنال لبيانات الدخول)
npm run start:dev             # http://localhost:3000
```

**تشغيل اختبارات المرحلة 1 (e2e حقيقي ضد قاعدة بيانات منفصلة)**:

```bash
createdb restaurant_erp_test   # أو أنشئها بأي طريقة تفضّلها
cp .env.example .env.test      # عدّل DATABASE_URL فيها لتشير إلى restaurant_erp_test
export $(cat .env.test | xargs) && npx prisma migrate deploy
export $(cat .env.test | xargs) && npm run test:e2e
```

## كيف تكمل من هنا (باستخدام Claude Code)

1. المرحلة التالية بالترتيب المقترح في `docs/ARCHITECTURE.md` → قسم "خطة التنفيذ المرحلية":
   **المرحلة 6: Production Orders (multi-level BOM)** — أمر إنتاج يستهلك مكوّنات (عبر
   `InventoryService.consume` الموجودة) وينتج دفعة صنف نصف مصنّع جديدة (عبر
   `InventoryService.receive` بـ sourceType='PRODUCTION') بذرية DB transaction واحدة، نفس نمط
   خصم/استلام المخزون في المبيعات والمشتريات.
2. لا تبدأ بكل الوحدات دفعة وحدة — كل وحدة يجب أن تُبنى وتُختبر (باختبارات e2e حقيقية، مو Unit
   tests وهمية فقط) قبل الانتقال للتالية، بنفس نمط المراحل 1-5.
3. اتبع نفس نمط RBAC المستخدم في المراحل السابقة (`@RequirePermission('code')` + `PermissionsGuard`
   يقرأ من قاعدة البيانات مباشرة، مو من الـ JWT) لأي Endpoint جديد يحتاج صلاحية، ونمط الـ Scope
   المشترك في `src/common/location-scope.util.ts` لأي مورد مرتبط بموقع.
4. `InventoryService` (استلام/خصم FIFO/عكس استهلاك) و`src/common/location-scope.util.ts` مبنيان
   كوحدات مشتركة يُعاد استخدامها -- لا تكرّر منطقهما في وحدات الإنتاج/التحويلات القادمة.
5. **مهم لأي اختبار e2e جديد**: كل `*.e2e-spec.ts` يشغّل بنفس عملية Jest (`--runInBand`) بترتيب
   أبجدي بالاسم، ضد نفس قاعدة البيانات المُهاجَرة. أي جدول جديد له FK على `Ingredient` أو
   `MenuItem` أو `Location` (أو أي جدول مشترك آخر) لازم يُنظَّف دفاعيًا (children قبل parents) في
   بداية `beforeAll` لكل ملف اختبار **آخر** ترتيبه أبجديًا بعد ملفك -- وإلا كسرت تنظيفه هو
   بمخلّفات تشغيلة سابقة متقطعة. راجع التعليقات في أعلى `beforeAll` بكل ملف اختبار حالي كمثال.

## التقنيات

| الطبقة | التقنية |
|---|---|
| Backend API | Node.js + TypeScript + NestJS |
| قاعدة البيانات | PostgreSQL + Prisma ORM |
| المصادقة | JWT (access 15m + refresh 7d)، RBAC مرن بجدول Role/Permission، Scope على مستوى الموقع |
| Frontend (الكاشير) | React + Vite + TypeScript كـ PWA (لم يُبنَ بعد — راجع `apps/pos-web/src/README.md`) |
| الحاويات | Docker Compose للتطوير المحلي (اختياري -- سيرفر PostgreSQL محلي يعمل بنفس الكفاءة) |

## البنية

```
restaurant-erp/
├── docs/
│   ├── DECISIONS.md          ← كل القرارات المعمارية من جلسة التصميم
│   └── ARCHITECTURE.md       ← تفصيل تقني + خطة تنفيذ مرحلية
├── apps/
│   ├── api/                  ← Backend (NestJS) -- المراحل 1-5 مبنية وتعمل
│   │   ├── prisma/schema.prisma  ← مخطط قاعدة البيانات الكامل
│   │   ├── prisma/seed.ts        ← صلاحيات/أدوار أساسية + مستخدم مدير
│   │   ├── src/prisma/            ← PrismaService/PrismaModule (بنية تحتية مشتركة)
│   │   ├── src/common/             ← أدوات مشتركة بين الوحدات (Scope على مستوى الموقع)
│   │   ├── src/auth/                ← تسجيل الدخول، JWT، RBAC guard/decorator
│   │   ├── src/users/                ← وحدة المستخدمين (CRUD)
│   │   ├── src/branches/              ← وحدة الفروع/المواقع (CRUD + Scope filtering)
│   │   ├── src/ingredients/            ← خامات + نصف مصنّعة (CRUD + وصفة كل نصف مصنّع)
│   │   ├── src/items/                   ← أصناف المنيو (CRUD + وصفة كل صنف)
│   │   ├── src/inventory/                ← دفعات/حركات/أرصدة مخزون (استلام + خصم FIFO + عكس استهلاك)
│   │   ├── src/sales/                     ← ورديات (تسوية نقدية) + طلبات (خصم مخزون بذرية) + دفع/إلغاء
│   │   ├── src/purchasing/                 ← موردون + مصفوفة موافقات + أوامر شراء (دورة حياة كاملة)
│   │   ├── src/modules/*/README.md          ← بقية الوحدات، لم تُبنَ بعد (كل واحدة README فقط)
│   │   └── test/*.e2e-spec.ts                ← اختبارات المراحل 1-5 الكاملة (57 اختبار)
│   └── pos-web/               ← Frontend الكاشير (React + Vite PWA scaffold، لم يُبنَ بعد)
├── prototypes/
│   ├── pos_prototype.html    ← النموذج الأولي HTML/JS المرجعي (منطق البيع/خصم المخزون)
│   ├── login_demo.html        ← صفحة تجريبية بسيطة لتسجيل الدخول (Phase 1) ضد API حقيقي
│   └── admin_panel.html        ← لوحة تحكم إدارية بسيطة: فروع، أصناف خام/نصف مصنّعة (بوصفاتها)، أصناف منيو (بوصفاتها)
└── docker-compose.yml
```
