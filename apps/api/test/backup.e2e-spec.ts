import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Full round-trip coverage for the backup/restore module: permission
// gating, create -> list -> download, restore reverting data taken AFTER
// the backup (including a Bytes column, the one type that needs manual
// serialization -- see BackupService.toPlainRow/fromPlainRow), and
// restore-from-upload accepting a file downloaded from THIS system (the
// exact cross-environment migration path the module exists for).
describe('Backup module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;

  const ADMIN_PHONE = '+966500000240';
  const NOPERM_PHONE = '+966500000241';
  const PASSWORD = 'BackupTest123';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.backup.deleteMany({});
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['BackupTest-Full', 'BackupTest-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: 'system.backup_manage' } });

    const perm = await prisma.permission.create({ data: { code: 'system.backup_manage', label: 'إدارة النسخ الاحتياطية' } });
    const role = await prisma.role.create({ data: { name: 'BackupTest-Full' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    await prisma.role.create({ data: { name: 'BackupTest-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    adminToken = await makeUser(ADMIN_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks every endpoint without system.backup_manage (403)', async () => {
    const create = await request(app.getHttpServer()).post('/backups').set(auth(noPermToken)).send({});
    expect(create.status).toBe(403);
    const list = await request(app.getHttpServer()).get('/backups').set(auth(noPermToken));
    expect(list.status).toBe(403);
  });

  it('rejects restore with a missing/wrong confirm phrase (400)', async () => {
    const backup = await prisma.backup.create({
      data: { createdBy: 'test', fileName: 'x.json.gz', sizeBytes: 1, fileData: Buffer.from('x') },
    });
    const res = await request(app.getHttpServer()).post(`/backups/${backup.id}/restore`).set(auth(adminToken)).send({ confirm: 'nope' });
    expect(res.status).toBe(400);
    await prisma.backup.delete({ where: { id: backup.id } });
  });

  it('create -> list -> download -> mutate -> restore reverts everything, including a Bytes column', async () => {
    const location = await prisma.location.create({
      data: {
        name: 'فرع اختبار النسخ الاحتياطي',
        type: 'BRANCH',
        logoData: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic bytes, as a stand-in real binary payload
        logoMimeType: 'image/png',
      },
    });
    const ingredient = await prisma.ingredient.create({
      data: { name: 'مكوّن اختبار النسخ', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار النسخ', category: 'اختبار', price: 42.5 } });
    await prisma.recipeLine.create({ data: { menuItemId: menuItem.id, ingredientId: ingredient.id, quantity: 2 } });

    const createRes = await request(app.getHttpServer()).post('/backups').set(auth(adminToken)).send({ note: 'e2e snapshot' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toBeTruthy();
    expect(createRes.body.sizeBytes).toBeGreaterThan(0);
    const backupId = createRes.body.id as string;

    const listRes = await request(app.getHttpServer()).get('/backups').set(auth(adminToken));
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((b: { id: string }) => b.id === backupId)).toBe(true);

    const downloadRes = await request(app.getHttpServer()).get(`/backups/${backupId}/download`).set(auth(adminToken));
    expect(downloadRes.status).toBe(200);
    const dump = JSON.parse(downloadRes.text);
    expect(dump.version).toBe(1);
    const dumpedLocation = dump.models.location.find((l: { id: string }) => l.id === location.id);
    expect(dumpedLocation.logoData.$type).toBe('Buffer'); // confirms the manual Bytes serialization actually ran

    // Mutate: delete the recipe line's ingredient (via the same catalog
    // reset an admin would use), add an unrelated ingredient -- simulates
    // "something changed after the backup was taken".
    await prisma.recipeLine.deleteMany({ where: { menuItemId: menuItem.id } });
    await prisma.ingredient.delete({ where: { id: ingredient.id } });
    const strayIngredient = await prisma.ingredient.create({
      data: { name: 'مكوّن طارئ بعد النسخة', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });

    const restoreRes = await request(app.getHttpServer())
      .post(`/backups/${backupId}/restore`)
      .set(auth(adminToken))
      .send({ confirm: 'RESTORE-BACKUP-OVERWRITE-EVERYTHING' });
    expect(restoreRes.status).toBe(201);

    // The stray post-backup row is gone; the original rows are back with
    // their original ids/relations/binary data intact.
    expect(await prisma.ingredient.findUnique({ where: { id: strayIngredient.id } })).toBeNull();
    const restoredIngredient = await prisma.ingredient.findUnique({ where: { id: ingredient.id } });
    expect(restoredIngredient?.name).toBe('مكوّن اختبار النسخ');
    const restoredRecipeLines = await prisma.recipeLine.findMany({ where: { menuItemId: menuItem.id } });
    expect(restoredRecipeLines).toHaveLength(1);
    expect(restoredRecipeLines[0].ingredientId).toBe(ingredient.id);
    const restoredLocation = await prisma.location.findUnique({ where: { id: location.id } });
    expect(restoredLocation?.logoData).toBeInstanceOf(Buffer);
    expect(Buffer.from(restoredLocation!.logoData!).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);

    // restore-from-upload: feed the exact file just downloaded back in as
    // an upload (the cross-environment migration path) -- must succeed
    // identically, proving the download's format is what restore accepts.
    const secondStrayIngredient = await prisma.ingredient.create({
      data: { name: 'مكوّن طارئ آخر', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });
    const uploadRestoreRes = await request(app.getHttpServer())
      .post('/backups/restore-from-upload')
      .set(auth(adminToken))
      .field('confirm', 'RESTORE-BACKUP-OVERWRITE-EVERYTHING')
      .attach('file', Buffer.from(downloadRes.text), 'backup.json');
    expect(uploadRestoreRes.status).toBe(201);
    expect(await prisma.ingredient.findUnique({ where: { id: secondStrayIngredient.id } })).toBeNull();
    expect(await prisma.ingredient.findUnique({ where: { id: ingredient.id } })).not.toBeNull();
  });
});
