import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// A 1x1 red pixel PNG -- same fixture menu-item-image.e2e-spec.ts uses, to
// exercise real binary storage/retrieval instead of a mocked buffer.
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

// Location.logoData/logoMimeType (per-branch invoice logo, same
// storage/endpoint pattern as MenuItem's image) plus invoiceHeaderNote/
// invoiceFooterNote (free text printed on the cashier invoice).
describe('Branch logo + invoice header/footer notes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let locationId: string;
  let plainLocationId: string;

  const ADMIN_PHONE = '+966500000270';
  const PASSWORD = 'BranchLogoTest123';
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
    await prisma.user.deleteMany({ where: { phone: ADMIN_PHONE } });
    await prisma.role.deleteMany({ where: { name: 'BranchLogo-Test-Manager' } });
    await prisma.permission.deleteMany({ where: { code: 'branches.manage' } });

    const branchesPerm = await prisma.permission.create({ data: { code: 'branches.manage', label: 'إدارة الفروع' } });
    const role = await prisma.role.create({ data: { name: 'BranchLogo-Test-Manager' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: branchesPerm.id } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const admin = await prisma.user.create({ data: { name: 'Admin', phone: ADMIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع بشعار', type: 'BRANCH' } });
    locationId = location.id;
    const plainLocation = await prisma.location.create({ data: { name: 'فرع بدون شعار', type: 'BRANCH' } });
    plainLocationId = plainLocation.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unsupported logo format', async () => {
    const res = await request(app.getHttpServer())
      .post(`/locations/${locationId}/logo`)
      .set(auth(adminToken))
      .attach('file', Buffer.from('not really a gif'), { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(400);
  });

  it('uploads a real logo and lists it with hasLogo: true, never leaking raw bytes into the list', async () => {
    const uploadRes = await request(app.getHttpServer())
      .post(`/locations/${locationId}/logo`)
      .set(auth(adminToken))
      .attach('file', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.hasLogo).toBe(true);

    const listRes = await request(app.getHttpServer()).get('/locations').set(auth(adminToken));
    const row = listRes.body.find((r: { id: string }) => r.id === locationId);
    expect(row.hasLogo).toBe(true);
    expect(row.logoMimeType).toBeUndefined();

    const otherRow = listRes.body.find((r: { id: string }) => r.id === plainLocationId);
    expect(otherRow.hasLogo).toBe(false);
  });

  it('serves back the exact logo bytes that were uploaded', async () => {
    const res = await request(app.getHttpServer())
      .get(`/locations/${locationId}/logo`)
      .set(auth(adminToken))
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

  it('returns 404 for a branch with no logo', async () => {
    const res = await request(app.getHttpServer()).get(`/locations/${plainLocationId}/logo`).set(auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('removes the logo, after which it 404s again', async () => {
    const del = await request(app.getHttpServer()).delete(`/locations/${locationId}/logo`).set(auth(adminToken));
    expect(del.status).toBe(200);
    expect(del.body.hasLogo).toBe(false);

    const res = await request(app.getHttpServer()).get(`/locations/${locationId}/logo`).set(auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('saves and returns invoiceHeaderNote/invoiceFooterNote via PATCH', async () => {
    const patchRes = await request(app.getHttpServer())
      .patch(`/locations/${locationId}`)
      .set(auth(adminToken))
      .send({ invoiceHeaderNote: 'أهلًا بكم في فرعنا', invoiceFooterNote: 'شكرًا لزيارتكم -- لا يُسترد المبلغ إلا خلال 3 أيام' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.invoiceHeaderNote).toBe('أهلًا بكم في فرعنا');
    expect(patchRes.body.invoiceFooterNote).toBe('شكرًا لزيارتكم -- لا يُسترد المبلغ إلا خلال 3 أيام');

    const getRes = await request(app.getHttpServer()).get(`/locations/${locationId}`).set(auth(adminToken));
    expect(getRes.body.invoiceHeaderNote).toBe('أهلًا بكم في فرعنا');
  });
});
