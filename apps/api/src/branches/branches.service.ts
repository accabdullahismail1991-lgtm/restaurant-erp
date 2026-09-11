import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { bulkImportRows } from '../common/bulk-import.util';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

// Excludes logoData -- same reasoning as items.service.ts's MENU_ITEM_SELECT:
// arbitrary binary data that shouldn't ride along on every ordinary branches
// list/detail read. hasLogo tells the UI whether GET /locations/:id/logo is
// worth calling at all.
const LOCATION_SELECT = {
  id: true,
  name: true,
  type: true,
  address: true,
  vatNumber: true,
  zatcaInvoiceCounter: true,
  requireCustomerForOrders: true,
  vatRate: true,
  allowNegativeStock: true,
  logoMimeType: true,
  invoiceHeaderNote: true,
  invoiceFooterNote: true,
  isActive: true,
  createdAt: true,
} as const;

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_LOGO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function withHasLogo<T extends { logoMimeType: string | null }>(location: T) {
  const { logoMimeType, ...rest } = location;
  return { ...rest, hasLogo: logoMimeType !== null };
}

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateLocationDto) {
    return this.prisma.location.create({ data: dto, select: LOCATION_SELECT }).then(withHasLogo);
  }

  bulkImport(rows: unknown[]) {
    return bulkImportRows(CreateLocationDto, rows, (dto) => this.create(dto));
  }

  async findAll(userId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    const locations = await this.prisma.location.findMany({
      where: allowedIds ? { id: { in: allowedIds } } : undefined,
      orderBy: { name: 'asc' },
      select: LOCATION_SELECT,
    });
    return locations.map(withHasLogo);
  }

  async findOne(id: string, userId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(id)) {
      throw new NotFoundException('الموقع غير موجود أو خارج نطاق صلاحيتك');
    }
    const location = await this.prisma.location.findUnique({ where: { id }, select: LOCATION_SELECT });
    if (!location) throw new NotFoundException('الموقع غير موجود');
    return withHasLogo(location);
  }

  async update(id: string, dto: UpdateLocationDto) {
    const existing = await this.prisma.location.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('الموقع غير موجود');
    return this.prisma.location.update({ where: { id }, data: dto, select: LOCATION_SELECT }).then(withHasLogo);
  }

  async setLogo(id: string, file: { buffer: Buffer; mimetype: string; size: number }) {
    const existing = await this.prisma.location.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('الموقع غير موجود');
    if (!ALLOWED_LOGO_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('صيغة الشعار غير مدعومة -- JPG أو PNG أو WEBP فقط');
    }
    if (file.size > MAX_LOGO_BYTES) {
      throw new BadRequestException('حجم الشعار كبير جدًا -- الحد الأقصى 2 ميجابايت');
    }
    await this.prisma.location.update({ where: { id }, data: { logoData: file.buffer, logoMimeType: file.mimetype } });
    return { hasLogo: true };
  }

  async getLogo(id: string) {
    const location = await this.prisma.location.findUnique({ where: { id }, select: { logoData: true, logoMimeType: true } });
    if (!location || !location.logoData || !location.logoMimeType) throw new NotFoundException('لا يوجد شعار لهذا الفرع');
    return { data: location.logoData, mimeType: location.logoMimeType };
  }

  async removeLogo(id: string) {
    const existing = await this.prisma.location.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('الموقع غير موجود');
    await this.prisma.location.update({ where: { id }, data: { logoData: null, logoMimeType: null } });
    return { hasLogo: false };
  }
}
