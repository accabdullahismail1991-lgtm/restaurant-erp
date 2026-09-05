import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SetRecipeDto } from '../ingredients/dto/set-recipe.dto';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';

@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateMenuItemDto) {
    return this.prisma.menuItem.create({ data: dto });
  }

  findAll() {
    return this.prisma.menuItem.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('صنف المنيو غير موجود');
    return item;
  }

  async update(id: string, dto: UpdateMenuItemDto) {
    await this.findOne(id);
    return this.prisma.menuItem.update({ where: { id }, data: dto });
  }

  async getRecipe(id: string) {
    await this.findOne(id);
    const lines = await this.prisma.recipeLine.findMany({
      where: { menuItemId: id },
      include: { ingredient: { select: { id: true, name: true, unit: true, kind: true } } },
    });
    return lines.map((l) => ({ id: l.id, quantity: l.quantity, ingredient: l.ingredient }));
  }

  // A MenuItem is only ever the TOP of a recipe tree -- nothing else can
  // reference a MenuItem as ITS component -- so unlike Ingredient.ownRecipe
  // there's no cycle risk here, only "does every referenced ingredient exist".
  async setRecipe(id: string, dto: SetRecipeDto) {
    await this.findOne(id);
    const componentIds = dto.lines.map((l) => l.ingredientId);
    const components = await this.prisma.ingredient.findMany({ where: { id: { in: componentIds } } });
    if (components.length !== new Set(componentIds).size) {
      throw new BadRequestException('أحد المكوّنات المذكورة غير موجود');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.recipeLine.deleteMany({ where: { menuItemId: id } });
      if (dto.lines.length) {
        await tx.recipeLine.createMany({
          data: dto.lines.map((l) => ({ menuItemId: id, ingredientId: l.ingredientId, quantity: l.quantity })),
        });
      }
      return tx.recipeLine.findMany({
        where: { menuItemId: id },
        include: { ingredient: { select: { id: true, name: true, unit: true, kind: true } } },
      });
    });
  }
}
