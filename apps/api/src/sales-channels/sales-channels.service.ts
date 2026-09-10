import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSalesChannelDto } from './dto/create-sales-channel.dto';
import { UpdateSalesChannelDto } from './dto/update-sales-channel.dto';

@Injectable()
export class SalesChannelsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.salesChannel.findMany({ orderBy: { name: 'asc' } });
  }

  async create(dto: CreateSalesChannelDto) {
    const existing = await this.prisma.salesChannel.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException('توجد قناة بنفس الاسم بالفعل');
    return this.prisma.salesChannel.create({ data: { name: dto.name } });
  }

  async findOne(id: string) {
    const channel = await this.prisma.salesChannel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('قناة البيع غير موجودة');
    return channel;
  }

  async update(id: string, dto: UpdateSalesChannelDto) {
    await this.findOne(id);
    if (dto.name) {
      const existing = await this.prisma.salesChannel.findUnique({ where: { name: dto.name } });
      if (existing && existing.id !== id) throw new ConflictException('توجد قناة بنفس الاسم بالفعل');
    }
    return this.prisma.salesChannel.update({ where: { id }, data: dto });
  }

  // Deactivating (isActive:false) is the recommended way to retire a
  // channel that already has priced items or past orders against it --
  // hard delete only works while nothing references it yet, and the FK
  // constraint (not a pre-check here, to avoid a TOCTOU race) enforces
  // that; a violation is translated into a message that says so instead
  // of leaking the raw Prisma error code.
  async remove(id: string) {
    await this.findOne(id);
    try {
      await this.prisma.salesChannel.delete({ where: { id } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2003') {
        throw new BadRequestException('لا يمكن حذف هذه القناة لوجود أسعار أصناف أو طلبات مرتبطة بها -- عطّلها بدلًا من ذلك');
      }
      throw e;
    }
    return { deleted: true };
  }

  // One call for the whole grid instead of one round-trip per item -- this
  // is exactly what the Sales popup's tile grid needs to show
  // channel-specific prices without an N+1 fetch per tile.
  async itemPrices(channelId: string) {
    await this.findOne(channelId);
    const [items, overrides] = await Promise.all([
      this.prisma.menuItem.findMany({ where: { isActive: true }, select: { id: true, price: true } }),
      this.prisma.menuItemChannelPrice.findMany({ where: { channelId } }),
    ]);
    const overrideMap = new Map(overrides.map((o) => [o.menuItemId, o.price]));
    return items.map((item) => ({
      menuItemId: item.id,
      price: overrideMap.get(item.id) ?? item.price,
      isOverridden: overrideMap.has(item.id),
    }));
  }
}
