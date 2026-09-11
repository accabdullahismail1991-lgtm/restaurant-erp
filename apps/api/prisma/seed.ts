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
  { code: 'items.manage', label: 'إدارة أصناف المنيو ووصفاتها' },
  { code: 'inventory.adjust', label: 'تسوية أرصدة المخزون' },
  { code: 'purchasing.approve_po', label: 'اعتماد أوامر الشراء' },
  { code: 'purchasing.create_po', label: 'إنشاء أوامر شراء' },
  { code: 'purchasing.manage_rules', label: 'إدارة مصفوفة الموافقات (Approval Matrix)' },
  { code: 'purchasing.return_po', label: 'تسجيل مرتجع لمورد' },
  { code: 'production.manage', label: 'إدارة أوامر الإنتاج' },
  { code: 'transfers.manage', label: 'إدارة التحويلات بين المواقع' },
  { code: 'pos.void_order', label: 'إلغاء طلب من الكاشير' },
  { code: 'pos.return_order', label: 'تسجيل مرتجع عميل' },
  { code: 'promotions.manage', label: 'إدارة العروض والخصومات' },
  { code: 'analytics.view', label: 'عرض التقارير التحليلية (مبيعات/تكلفة/مخزون)' },
  { code: 'payment_methods.manage', label: 'إدارة طرق الدفع' },
];

// Seeded once, then left alone -- an admin can add more or rename these
// from the "💳 طرق الدفع" screen without this script fighting their edits
// on the next run (upsert only touches `code`+`update:{}`, so it will
// never overwrite a name/isCash a user already customized).
const DEFAULT_PAYMENT_METHODS: Array<{ code: string; name: string; isCash: boolean }> = [
  { code: 'CASH', name: 'كاش', isCash: true },
  { code: 'CARD', name: 'بطاقة', isCash: false },
  { code: 'WALLET', name: 'محفظة إلكترونية', isCash: false },
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
    'items.manage',
    'inventory.adjust',
    'purchasing.create_po',
    'purchasing.approve_po', // local/small POs -- the Approval Matrix's own role check still gates by amount tier
    'purchasing.return_po',
    'production.manage', // local prep as well as central-kitchen runs (decision #5: hybrid production location)
    'transfers.manage',
    'pos.void_order',
    'pos.return_order',
    'promotions.manage',
    'analytics.view',
    'payment_methods.manage',
  ];
  const cashierCodes: string[] = []; // base cashier operations don't need a permission check yet (sales module unbuilt)

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
