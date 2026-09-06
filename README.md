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
- ✅ **المرحلة 6 مكتملة وتعمل فعليًا**: `production` -- أمر إنتاج (مخطط → قيد التنفيذ → مكتمل/ملغى)
  لصنف نصف مصنّع: البدء (`start`) يخصم مكوّناته **بذرية** عبر `InventoryService.consume` نفسها
  (تلقائيًا من وصفة الصنف الخاصة به، أو بمكوّنات مخصصة لهذا التشغيل تحديدًا)، ويُسجّل التكلفة
  الفعلية المستهلكة (`totalInputCost`، من تكلفة كل دفعة استُهلكت منها فعليًا لا تقديرًا)؛ الاكتمال
  (`complete`) يُنشئ دفعة المنتج الناتج بتكلفة وحدة حقيقية = `totalInputCost / outputQuantity` عبر
  `InventoryService.receive` نفسها؛ الإلغاء وهو قيد التنفيذ يرجّع بالضبط ما استُهلك لنفس الدفعات
  (نفس `reverseConsumption` المستخدمة في إلغاء طلبات البيع). 15 اختبار e2e في
  `apps/api/test/production.e2e-spec.ts`.
- ✅ **المرحلة 7 مكتملة وتعمل فعليًا**: `transfers` -- تحويل بين موقعين: الإرسال يخصم من المصدر
  **بذرية** عبر `InventoryService.consume` ويسجّل تكلفة الوحدة الفعلية لكل سطر (`TransferLine.unitCost`،
  من نفس الدفعات المُستهلَكة لا تقديرًا)؛ الاستلام يضيف للوجهة بنفس التكلفة عبر
  `InventoryService.receive`، والفرق بين الكمية المُرسَلة والمُستلَمة = **فاقد نقل تلقائي** (حقيقة
  مُشتقّة من الكميتين المخزَّنتين، القرار #6) يظهر كحالة `RECEIVED_WITH_VARIANCE`. 12 اختبار e2e
  في `apps/api/test/transfers.e2e-spec.ts`.
- **كل الوحدات التشغيلية الأساسية (المراحل 1-7) مبنية ومُختبرة الآن.** المتبقي: الجرد الدوري
  (Stocktake -- جزء متبقٍ من المرحلة 4)، Frontend فعلي، آلية المزامنة Offline-first، تكامل ZATCA
  (توليد/توقيع الفاتورة فعليًا)، KDS/Multi-channel/Promotions/CRM، BI/Analytics متقدم — راجع
  `docs/ARCHITECTURE.md` لتفاصيل كل مرحلة.

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

1. كل وحدات "دورة التشغيل الأساسية" (المراحل 1-7) مبنية الآن. الأنسب بعدها -- قبل القفز للمرحلة 8
   (Offline-first) -- هو **إغلاق الجزء المتبقي من المرحلة 4: الجرد الدوري (Stocktake)**: جدول
   Stocktake/StocktakeLine موجود بالمخطط بالفعل بدون منطق. جرد يقارن الرصيد النظري
   (`InventoryBalance`) بالكمية المعدودة فعليًا، والفرق (`variance`) يمر بنفس مصفوفة الموافقات
   (`ApprovalRule`, documentType='STOCKTAKE_ADJUSTMENT') قبل ما يُسوّى فعليًا عبر
   `InventoryService.consume`/`receive` -- لا تبني منطق موافقة منفصل، أعد استخدام
   `ApprovalRulesService.findApplicableRule` الموجودة بنفس أسلوب `purchasing`.
2. بعدها: **المرحلة 8 (Offline-first)** -- تحويل الـ POS لـ PWA بـ IndexedDB + Sync Queue، فوق
   منطق مبيعات/مخزون مُختبر جيدًا أونلاين الآن (لا تبدأها قبل الجرد لأن نفس منطق تسوية الفروقات
   محتاج يكون مستقر أولًا).
3. لا تبدأ بكل الوحدات دفعة وحدة — كل وحدة يجب أن تُبنى وتُختبر (باختبارات e2e حقيقية، مو Unit
   tests وهمية فقط) قبل الانتقال للتالية، بنفس نمط المراحل 1-7.
4. اتبع نفس نمط RBAC المستخدم في المراحل السابقة (`@RequirePermission('code')` + `PermissionsGuard`
   يقرأ من قاعدة البيانات مباشرة، مو من الـ JWT) لأي Endpoint جديد يحتاج صلاحية، ونمط الـ Scope
   المشترك في `src/common/location-scope.util.ts` لأي مورد مرتبط بموقع.
5. `InventoryService` (استلام/خصم FIFO/عكس استهلاك)، `src/common/location-scope.util.ts`،
   و`ApprovalRulesService.findApplicableRule` كلها مبنية كوحدات مشتركة يُعاد استخدامها -- لا تكرّر
   منطقها في وحدة الجرد القادمة.
6. **لأي اختبار e2e جديد**: استخدم `test/reset-db.ts`'s `resetDatabase(prisma)` في بداية
   `beforeAll` بدل تنظيف يدوي جدول-جدول -- تنظّف كل الجداول التشغيلية من كل الوحدات المبنية دفعة
   واحدة (children قبل parents)، لأن كل ملفات `*.e2e-spec.ts` تشتغل بنفس عملية Jest
   (`--runInBand`) بترتيب أبجدي ضد نفس القاعدة، وأي جدول جديد له FK على جدول قديم غير محدث فيها
   هيكسر تنظيف ملف اختبار تاني. **أضف جداول الجرد الجديدة لنفس الدالة** (بترتيب children قبل
   parents) بدل تكرار المنطق في كل ملف اختبار.

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
│   ├── api/                  ← Backend (NestJS) -- المراحل 1-7 مبنية وتعمل
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
│   │   ├── src/production/                  ← أوامر إنتاج (استهلاك مكوّنات → إنتاج دفعة بتكلفة حقيقية)
│   │   ├── src/transfers/                    ← تحويلات بين المواقع (إرسال يخصم → استلام يضيف + فاقد نقل)
│   │   ├── src/modules/*/README.md            ← بقية الوحدات، لم تُبنَ بعد (كل واحدة README فقط)
│   │   ├── test/reset-db.ts                    ← تصفير مشترك لكل الجداول التشغيلية، يستخدمه كل اختبار
│   │   └── test/*.e2e-spec.ts                   ← اختبارات المراحل 1-7 الكاملة (84 اختبار)
│   └── pos-web/               ← Frontend الكاشير (React + Vite PWA scaffold، لم يُبنَ بعد)
├── prototypes/
│   ├── pos_prototype.html    ← النموذج الأولي HTML/JS المرجعي (منطق البيع/خصم المخزون)
│   ├── login_demo.html        ← صفحة تجريبية بسيطة لتسجيل الدخول (Phase 1) ضد API حقيقي
│   └── admin_panel.html        ← لوحة تحكم تغطي المراحل 1-7 (فروع/أصناف/مخزون/مبيعات/مشتريات/إنتاج/تحويلات)
└── docker-compose.yml
```
