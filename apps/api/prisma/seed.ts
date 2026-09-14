// Seeds a small, realistic baseline: enough permission codes to cover
// every module named in docs/DECISIONS.md (even though only users/
// branches are actually implemented yet -- the codes are cheap to
// declare now and each future module's guard just references one),
// three roles built from sensible subsets of them, and one admin user
// to log in with locally. Re-runnable: every upsert is keyed so running
// this twice does not create duplicates.
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const PERMISSIONS: Array<{ code: string; label: string }> = [
  { code: 'users.manage', label: 'إدارة المستخدمين والأدوار' },
  { code: 'branches.manage', label: 'إدارة الفروع والمواقع' },
  { code: 'ingredients.manage', label: 'إدارة الأصناف الخام ونصف المصنّعة ووصفاتها' },
  // View-only counterparts for the back-office/cost-sensitive screens a
  // plain cashier shouldn't browse by default (unlike menu items/combos/
  // customers/branches, which stay permission-free reads -- the cashier
  // needs those to actually sell). *.manage already implies write access;
  // these gate the GET routes those same modules expose.
  { code: 'ingredients.view', label: 'عرض المواد الخام ووصفاتها وتكلفتها' },
  { code: 'items.manage', label: 'إدارة أصناف المنيو ووصفاتها' },
  { code: 'inventory.adjust', label: 'تسوية أرصدة المخزون' },
  { code: 'inventory.view', label: 'عرض أرصدة المخزون وحركاته' },
  { code: 'purchasing.approve_po', label: 'اعتماد أوامر الشراء' },
  { code: 'purchasing.create_po', label: 'إنشاء أوامر شراء' },
  { code: 'purchasing.manage_rules', label: 'إدارة مصفوفة الموافقات (Approval Matrix)' },
  { code: 'purchasing.return_po', label: 'تسجيل مرتجع لمورد' },
  { code: 'purchasing.view', label: 'عرض المشتريات وأوامر الشراء والموردين' },
  { code: 'production.manage', label: 'إدارة أوامر الإنتاج' },
  { code: 'production.view', label: 'عرض أوامر الإنتاج' },
  { code: 'transfers.manage', label: 'إدارة التحويلات بين المواقع' },
  { code: 'transfers.view', label: 'عرض التحويلات بين الفروع' },
  { code: 'pos.void_order', label: 'إلغاء طلب من الكاشير' },
  { code: 'pos.return_order', label: 'تسجيل مرتجع عميل' },
  { code: 'pos.apply_discount', label: 'تطبيق خصم يدوي على فاتورة مبيعات' },
  { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
  { code: 'promotions.manage', label: 'إدارة العروض والخصومات' },
  { code: 'combos.manage', label: 'إدارة وجبات الكمبو والبوكس' },
  { code: 'analytics.view', label: 'عرض التقارير التحليلية (مبيعات/تكلفة/مخزون)' },
  { code: 'payment_methods.manage', label: 'إدارة طرق الدفع' },
  { code: 'system.reset_data', label: 'حذف/تصفير بيانات النظام (إجراء حسّاس)' },
  { code: 'system.backup_manage', label: 'إنشاء/تحميل/استعادة النسخ الاحتياطية (إجراء حسّاس)' },
];

// Seeded once, then left alone -- an admin can add more or rename these
// from the "💳 طرق الدفع" screen without this script fighting their edits
// on the next run (upsert only touches `code`+`update:{}`, so it will
// never overwrite a name/isCash a user already customized).
const DEFAULT_PAYMENT_METHODS: Array<{ code: string; name: string; isCash: boolean }> = [
  { code: 'CASH', name: 'كاش', isCash: true },
  { code: 'CARD', name: 'شبكة (بطاقة)', isCash: false },
  { code: 'WALLET', name: 'محفظة إلكترونية', isCash: false },
  // Not real cash/settlement -- an employee's meal recorded at the till so
  // it still shows in sales/kitchen data, tracked apart from the shift's
  // cash-drawer reconciliation. No payroll module exists to auto-deduct it
  // yet -- shifts.closeSummary's byPaymentMethod breakdown is what lets an
  // admin read off the employee-meals total to apply manually for now.
  { code: 'STAFF_MEAL', name: 'وجبات الموظفين', isCash: false },
];

// A starter catalog only -- Ingredient.unit stays a free string (see
// UnitOfMeasure model comment), so this just gives the Ingredients form's
// unit dropdown something to show on a fresh install. An admin can add
// more from the "وحدات القياس" screen.
const DEFAULT_UNITS: Array<{ code: string; name: string }> = [
  { code: 'g', name: 'جرام' },
  { code: 'kg', name: 'كيلوجرام' },
  { code: 'ml', name: 'مليلتر' },
  { code: 'l', name: 'لتر' },
  { code: 'pcs', name: 'قطعة' },
];

// Overridable via env so a real deployment (Render, etc.) isn't stuck with
// the well-known local dev credential -- falls back to it when unset so
// nothing changes for local development.
const ADMIN_PHONE = process.env.ADMIN_PHONE || '+966500000000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!'; // dev-only seed credential -- see README

async function main() {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code: p.code }, update: { label: p.label }, create: p });
  }

  const allCodes = PERMISSIONS.map((p) => p.code);
  const branchManagerCodes = [
    'branches.manage',
    'ingredients.manage',
    'ingredients.view',
    'items.manage',
    'inventory.adjust',
    'inventory.view',
    'purchasing.create_po',
    'purchasing.approve_po', // local/small POs -- the Approval Matrix's own role check still gates by amount tier
    'purchasing.return_po',
    'purchasing.view',
    'production.manage', // local prep as well as central-kitchen runs (decision #5: hybrid production location)
    'production.view',
    'transfers.manage',
    'transfers.view',
    'pos.void_order',
    'pos.return_order',
    'pos.apply_discount',
    'pos.manage_shift',
    'promotions.manage',
    'combos.manage',
    'analytics.view',
    'payment_methods.manage',
  ];
  // A cashier can run the daily POS (open/close their own shift; selling,
  // discounts/voids/returns are separately permission-gated per-action as
  // before) but starts with NO visibility into cost-sensitive back-office
  // screens (recipes/costs, inventory, purchasing, production, transfers)
  // -- a manager grants those individually from the Roles & Permissions
  // screen if a given cashier genuinely needs one.
  const cashierCodes: string[] = ['pos.manage_shift'];

  const adminRole = await upsertRoleWithPermissions('مدير النظام', 'صلاحية كاملة على كل الوحدات', allCodes);
  await upsertRoleWithPermissions('مدير فرع', 'إدارة فرع واحد أو أكثر ضمن نطاقه', branchManagerCodes);
  await upsertRoleWithPermissions('كاشير', 'تشغيل نقطة البيع اليومية', cashierCodes);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const admin = await prisma.user.upsert({
    where: { phone: ADMIN_PHONE },
    update: {},
    create: { name: 'مدير النظام', phone: ADMIN_PHONE, passwordHash, isActive: true },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: adminRole.id } },
    update: {},
    create: { userId: admin.id, roleId: adminRole.id },
  });

  for (const m of DEFAULT_PAYMENT_METHODS) {
    await prisma.paymentMethod.upsert({ where: { code: m.code }, update: {}, create: m });
  }

  for (const u of DEFAULT_UNITS) {
    await prisma.unitOfMeasure.upsert({ where: { code: u.code }, update: {}, create: u });
  }

  // eslint-disable-next-line no-console
  console.log(`Seed complete. Admin login: ${ADMIN_PHONE} / ${ADMIN_PASSWORD}`);
}

async function upsertRoleWithPermissions(name: string, description: string, permissionCodes: string[]) {
  const role = await prisma.role.upsert({ where: { name }, update: { description }, create: { name, description } });
  for (const code of permissionCodes) {
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code } });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }
  return role;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
