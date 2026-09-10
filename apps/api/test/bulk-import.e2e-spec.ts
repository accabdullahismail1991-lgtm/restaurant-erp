import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase G: bulk import for the master-data modules that are otherwise
// one-row-at-a-time forms (branches, ingredients, menu items, suppliers,
// customers) -- POST /<module>/bulk-import takes { rows: [...] } and
// reuses each module's own CreateXDto for per-row validation (see
// src/common/bulk-import.util.ts) so a single bad row is reported and
// skipped instead of 400-ing the whole file, which is what the admin
// panel's CSV importer relies on to show "3 succeeded, 1 failed: row 2 --
// ...".  Gated behind the SAME permission as that module's normal create
// endpoint -- bulk-importing branches without branches.manage would be a
// backdoor around RBAC otherwise.
describe('Phase G: bulk import for master-data modules (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let managerToken: string;
  let noPermToken: string;

  const MANAGER_PHONE = '+966500000190';
  const NOPERM_PHONE = '+966500000191';
  const PASSWORD = 'BulkImportTest123';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { in: [MANAGER_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['Bulk-Import-Manager', 'Bulk-Import-NoPerm'] } } });

    const permCodes = ['branches.manage', 'ingredients.manage', 'items.manage', 'purchasing.create_po'];
    const perms = await Promise.all(
      permCodes.map((code) => prisma.permission.upsert({ where: { code }, update: {}, create: { code, label: code } })),
    );
    const managerRole = await prisma.role.create({ data: { name: 'Bulk-Import-Manager' } });
    await Promise.all(perms.map((p) => prisma.rolePermission.create({ data: { roleId: managerRole.id, permissionId: p.id } })));
    await prisma.role.create({ data: { name: 'Bulk-Import-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    managerToken = await makeUser(MANAGER_PHONE, managerRole.id);
    noPermToken = await makeUser(NOPERM_PHONE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects bulk-import for every gated module without the matching manage permission (403)', async () => {
    const branches = await request(app.getHttpServer())
      .post('/locations/bulk-import')
      .set(auth(noPermToken))
      .send({ rows: [{ name: 'فرع بلا صلاحية', type: 'BRANCH' }] });
    const ingredients = await request(app.getHttpServer())
      .post('/ingredients/bulk-import')
      .set(auth(noPermToken))
      .send({ rows: [{ name: 'خامة بلا صلاحية', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 }] });
    const items = await request(app.getHttpServer())
      .post('/items/bulk-import')
      .set(auth(noPermToken))
      .send({ rows: [{ name: 'صنف بلا صلاحية', category: 'رئيسي', price: 10 }] });
    const suppliers = await request(app.getHttpServer())
      .post('/suppliers/bulk-import')
      .set(auth(noPermToken))
      .send({ rows: [{ name: 'مورد بلا صلاحية' }] });
    expect(branches.status).toBe(403);
    expect(ingredients.status).toBe(403);
    expect(items.status).toBe(403);
    expect(suppliers.status).toBe(403);
  });

  it('bulk-imports branches: valid rows created, invalid rows reported without failing the batch', async () => {
    const suffix = Date.now();
    const res = await request(app.getHttpServer())
      .post('/locations/bulk-import')
      .set(auth(managerToken))
      .send({
        rows: [
          { name: `فرع استيراد ١ ${suffix}`, type: 'BRANCH' },
          { name: `فرع استيراد ٢ ${suffix}`, type: 'WAREHOUSE', address: 'شارع الاختبار' },
          { name: `فرع بنوع خاطئ ${suffix}`, type: 'NOT_A_REAL_TYPE' },
          { type: 'BRANCH' }, // missing required name
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(2);
    expect(res.body.errorCount).toBe(2);
    expect(res.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);

    const created = await prisma.location.findMany({ where: { name: { contains: String(suffix) } } });
    expect(created.length).toBe(2);
  });

  it('bulk-imports ingredients with numeric fields correctly coerced', async () => {
    const suffix = Date.now();
    const res = await request(app.getHttpServer())
      .post('/ingredients/bulk-import')
      .set(auth(managerToken))
      .send({
        rows: [
          { name: `خامة استيراد ${suffix}`, unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 50, shelfLifeDays: 7 },
          { name: `خامة بحد سالب ${suffix}`, unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: -5 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.errors[0].row).toBe(2);

    const created = await prisma.ingredient.findFirst({ where: { name: `خامة استيراد ${suffix}` } });
    expect(created).not.toBeNull();
    expect(Number(created!.lowStockThreshold)).toBe(50);
    expect(created!.shelfLifeDays).toBe(7);
  });

  it('bulk-imports menu items', async () => {
    const suffix = Date.now();
    const res = await request(app.getHttpServer())
      .post('/items/bulk-import')
      .set(auth(managerToken))
      .send({
        rows: [
          { name: `صنف استيراد ١ ${suffix}`, category: 'رئيسي', price: 25 },
          { name: `صنف استيراد ٢ ${suffix}`, category: 'حلويات', price: 15.5 },
          { name: `صنف بسعر خاطئ ${suffix}`, category: 'رئيسي', price: -1 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(2);
    expect(res.body.errorCount).toBe(1);
  });

  it('bulk-imports suppliers', async () => {
    const suffix = Date.now();
    const res = await request(app.getHttpServer())
      .post('/suppliers/bulk-import')
      .set(auth(managerToken))
      .send({ rows: [{ name: `مورد استيراد ${suffix}`, phone: '+966500000199' }] });
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(0);
  });

  it('bulk-imports customers (no special permission needed beyond being logged in) and reports duplicate phones as row errors', async () => {
    const suffix = Date.now();
    const phone1 = `+96650${String(suffix).slice(-7)}`;
    const res = await request(app.getHttpServer())
      .post('/customers/bulk-import')
      .set(auth(noPermToken))
      .send({
        rows: [
          { phone: phone1, name: 'عميل استيراد' },
          { phone: phone1, name: 'نفس الرقم مكرر' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.errors[0].row).toBe(2);
    expect(res.body.errors[0].message).toContain('مستخدم بالفعل');
  });
});
