import { Injectable, NotFoundException } from '@nestjs/common';
import { bulkImportRows } from '../common/bulk-import.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateSupplierDto) {
    return this.prisma.supplier.create({ data: dto });
  }

  bulkImport(rows: unknown[]) {
    return bulkImportRows(CreateSupplierDto, rows, (dto) => this.create(dto));
  }

  findAll() {
    return this.prisma.supplier.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('المورد غير موجود');
    return supplier;
  }
}
