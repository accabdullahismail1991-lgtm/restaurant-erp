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
  { code: 'production.manage', label: 'إدارة أوامر الإنتاج' },
  { code: 'transfers.manage', label: 'إدارة التحويلات بين المواقع' },
  { code: 'pos.void_order', label: 'إلغاء طلب من الكاشير' },
];

const ADMIN_PHONE = '+966500000000';
const ADMIN_PASSWORD = 'ChangeMe123!'; // dev-only seed credential -- see README

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
    'pos.void_order',
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
