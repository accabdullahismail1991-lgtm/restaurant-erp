import { Injectable, NotFoundException } from '@nestjs/common';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateLocationDto) {
    return this.prisma.location.create({ data: dto });
  }

  async findAll(userId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    return this.prisma.location.findMany({
      where: allowedIds ? { id: { in: allowedIds } } : undefined,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, userId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(id)) {
      throw new NotFoundException('الموقع غير موجود أو خارج نطاق صلاحيتك');
    }
    const location = await this.prisma.location.findUnique({ where: { id } });
    if (!location) throw new NotFoundException('الموقع غير موجود');
    return location;
  }

  async update(id: string, dto: UpdateLocationDto) {
    const existing = await this.prisma.location.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('الموقع غير موجود');
    return this.prisma.location.update({ where: { id }, data: dto });
  }
}
