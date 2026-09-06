import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// A 1x1 red pixel PNG -- small, real, valid image bytes (not a text stub),
// so the round-trip actually exercises binary storage/retrieval.
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de' +
    '0000000173524742' +
    '00aece1ce9' +
    '0000000467414d410000b18f0bfc61050000000970485973' +
    '000016250000162501495224f7' +
    '0000001749444154789c6360606018058c0c0000006400012f9e5aad' +
    '0000000049454e44ae426082',
  'hex',
);

// Menu item photos: display data (same sensitivity as name/price, unlike
// cost/margin), stored directly in Postgres (bytea) same as
// GeneratedReport.fileData -- no cloud object storage credentials exist in
// this environment. Runs against a real app + a real Postgres test
// database, uploading and re-downloading REAL image bytes, not a mocked
// buffer.
describe('Menu item images (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let manageToken: string;
  let noPermToken: string;
  let menuItemId: string;
  let plainMenuItemId: string;

  const MANAGE_PHONE = '+966500000140';
  const NOPERM_PHONE = '+966500000141';
  const PASSWORD = 'ItemImageTest123';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { in: [MANAGE_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: 'ItemImage-Test-Manager' } });
    await prisma.permission.deleteMany({ where: { code: 'items.manage' } });

    const itemsPerm = await prisma.permission.create({ data: { code: 'items.manage', label: 'إدارة المنيو' } });
    const role = await prisma.role.create({ data: { name: 'ItemImage-Test-Manager' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: itemsPerm.id } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    manageToken = await makeUser(MANAGE_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);

    const item = await prisma.menuItem.create({ data: { name: 'صنف بصورة', category: 'رئيسي', price: 30 } });
    menuItemId = item.id;
    const plainItem = await prisma.menuItem.create({ data: { name: 'صنف بدون صورة', category: 'رئيسي', price: 20 } });
    plainMenuItemId = plainItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks uploading an image without items.manage (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/items/${menuItemId}/image`)
      .set(auth(noPermToken))
      .attach('file', PNG_1X1, { filename: 'pixel.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('rejects an unsupported image format', async () => {
    const res = await request(app.getHttpServer())
      .post(`/items/${menuItemId}/image`)
      .set(auth(manageToken))
      .attach('file', Buffer.from('not really a gif'), { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(400);
  });

  it('uploads a real image and lists it with hasImage: true', async () => {
    const uploadRes = await request(app.getHttpServer())
      .post(`/items/${menuItemId}/image`)
      .set(auth(manageToken))
      .attach('file', PNG_1X1, { filename: 'pixel.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.hasImage).toBe(true);

    const listRes = await request(app.getHttpServer()).get('/items').set(auth(manageToken));
    const row = listRes.body.find((r: { id: string }) => r.id === menuItemId);
    expect(row.hasImage).toBe(true);
    expect(row.imageMimeType).toBeUndefined(); // never leaked into the list response

    const otherRow = listRes.body.find((r: { id: string }) => r.id === plainMenuItemId);
    expect(otherRow.hasImage).toBe(false);
  });

  it('serves back the exact bytes that were uploaded', async () => {
    const res = await request(app.getHttpServer())
      .get(`/items/${menuItemId}/image`)
      .set(auth(manageToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body as Buffer, PNG_1X1)).toBe(0);
  });

  it('returns 404 for an item with no image', async () => {
    const res = await request(app.getHttpServer()).get(`/items/${plainMenuItemId}/image`).set(auth(manageToken));
    expect(res.status).toBe(404);
  });

  it('removes the image, after which it 404s again', async () => {
    const del = await request(app.getHttpServer()).delete(`/items/${menuItemId}/image`).set(auth(manageToken));
    expect(del.status).toBe(200);
    expect(del.body.hasImage).toBe(false);

    const res = await request(app.getHttpServer()).get(`/items/${menuItemId}/image`).set(auth(manageToken));
    expect(res.status).toBe(404);
  });
});
