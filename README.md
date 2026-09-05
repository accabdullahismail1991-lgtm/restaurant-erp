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
  15 اختبار e2e حقيقي (يشغّل السيرفر فعليًا ضد قاعدة بيانات PostgreSQL حقيقية) في
  `apps/api/test/app.e2e-spec.ts`
- ⬜ لم يُبنَ بعد: بقية الوحدات (`ingredients`, `items`, `inventory`, `purchasing`, `production`,
  `transfers`, `sales`)، Frontend فعلي، آلية المزامنة Offline-first، تكامل ZATCA، تكامل الدفع

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
   **المرحلة 2: الأصناف والوصفات (Multi-level BOM)** — `modules/ingredients` و`modules/items`.
2. لا تبدأ بكل الوحدات دفعة وحدة — كل وحدة يجب أن تُبنى وتُختبر (باختبارات e2e حقيقية، مو Unit
   tests وهمية فقط) قبل الانتقال للتالية، بنفس نمط المرحلة 1.
3. اتبع نفس نمط RBAC المستخدم في المرحلة 1 (`@RequirePermission('code')` + `PermissionsGuard`
   يقرأ من قاعدة البيانات مباشرة، مو من الـ JWT) لأي Endpoint جديد يحتاج صلاحية.

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
│   ├── api/                  ← Backend (NestJS) -- المرحلة 1 مبنية وتعمل
│   │   ├── prisma/schema.prisma  ← مخطط قاعدة البيانات الكامل
│   │   ├── prisma/seed.ts        ← صلاحيات/أدوار أساسية + مستخدم مدير
│   │   ├── src/prisma/            ← PrismaService/PrismaModule (بنية تحتية مشتركة)
│   │   ├── src/auth/               ← تسجيل الدخول، JWT، RBAC guard/decorator
│   │   ├── src/users/               ← وحدة المستخدمين (CRUD)
│   │   ├── src/branches/             ← وحدة الفروع/المواقع (CRUD + Scope filtering)
│   │   ├── src/modules/*/README.md    ← بقية الوحدات، لم تُبنَ بعد (كل واحدة README فقط)
│   │   └── test/app.e2e-spec.ts        ← اختبارات المرحلة 1 الكاملة (15 اختبار)
│   └── pos-web/               ← Frontend الكاشير (React + Vite PWA scaffold، لم يُبنَ بعد)
└── docker-compose.yml
```
