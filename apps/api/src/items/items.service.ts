import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SetRecipeDto } from '../ingredients/dto/set-recipe.dto';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';

// Every ordinary list/detail read excludes imageData -- it's arbitrary
// binary data (up to MAX_IMAGE_BYTES), and JSON-serializing it as base64
// into every /items response (even for items with no image) would bloat
// every single list call. hasImage lets the UI know whether GET
// /items/:id/image is worth calling at all, without shipping the bytes
// themselves until that dedicated endpoint is actually hit.
const MENU_ITEM_SELECT = {
  id: true,
  name: true,
  category: true,
  price: true,
  isActive: true,
  imageMimeType: true,
} as const;

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function withHasImage<T extends { imageMimeType: string | null }>(item: T) {
  const { imageMimeType, ...rest } = item;
  return { ...rest, hasImage: imageMimeType !== null };
}

@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateMenuItemDto) {
    return this.prisma.menuItem.create({ data: dto, select: MENU_ITEM_SELECT }).then(withHasImage);
  }

  async findAll() {
    const items = await this.prisma.menuItem.findMany({ orderBy: { name: 'asc' }, select: MENU_ITEM_SELECT });
    return items.map(withHasImage);
  }

  async findOne(id: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id }, select: MENU_ITEM_SELECT });
    if (!item) throw new NotFoundException('صنف المنيو غير موجود');
    return withHasImage(item);
  }

  async update(id: string, dto: UpdateMenuItemDto) {
    await this.findOne(id);
    return this.prisma.menuItem.update({ where: { id }, data: dto, select: MENU_ITEM_SELECT }).then(withHasImage);
  }

  async setImage(id: string, file: { buffer: Buffer; mimetype: string; size: number }) {
    await this.findOne(id);
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('صيغة الصورة غير مدعومة -- JPG أو PNG أو WEBP فقط');
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new BadRequestException('حجم الصورة كبير جدًا -- الحد الأقصى 2 ميجابايت');
    }
    await this.prisma.menuItem.update({ where: { id }, data: { imageData: file.buffer, imageMimeType: file.mimetype } });
    return { hasImage: true };
  }

  async getImage(id: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id }, select: { imageData: true, imageMimeType: true } });
    if (!item || !item.imageData || !item.imageMimeType) throw new NotFoundException('لا توجد صورة لهذا الصنف');
    return { data: item.imageData, mimeType: item.imageMimeType };
  }

  async removeImage(id: string) {
    await this.findOne(id);
    await this.prisma.menuItem.update({ where: { id }, data: { imageData: null, imageMimeType: null } });
    return { hasImage: false };
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
