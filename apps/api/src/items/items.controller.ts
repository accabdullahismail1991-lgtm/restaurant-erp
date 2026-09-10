import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { BulkImportBodyDto } from '../common/bulk-import.util';
import { SetRecipeDto } from '../ingredients/dto/set-recipe.dto';
import { SetChannelPriceDto } from '../sales-channels/dto/set-channel-price.dto';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { ItemsService } from './items.service';

@Controller('items')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Post()
  @RequirePermission('items.manage')
  create(@Body() dto: CreateMenuItemDto) {
    return this.items.create(dto);
  }

  @Post('bulk-import')
  @RequirePermission('items.manage')
  bulkImport(@Body() body: BulkImportBodyDto) {
    return this.items.bulkImport(body.rows);
  }

  @Get()
  findAll() {
    return this.items.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.items.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('items.manage')
  update(@Param('id') id: string, @Body() dto: UpdateMenuItemDto) {
    return this.items.update(id, dto);
  }

  @Get(':id/recipe')
  getRecipe(@Param('id') id: string) {
    return this.items.getRecipe(id);
  }

  @Put(':id/recipe')
  @RequirePermission('items.manage')
  setRecipe(@Param('id') id: string, @Body() dto: SetRecipeDto) {
    return this.items.setRecipe(id, dto);
  }

  // Not gated behind analytics.view like cost/margin -- a menu item photo
  // is display data (same visibility level as its name/price), not a
  // commercially sensitive number.
  @Get(':id/image')
  async getImage(@Param('id') id: string) {
    const { data, mimeType } = await this.items.getImage(id);
    return new StreamableFile(data, { type: mimeType });
  }

  @Post(':id/image')
  @RequirePermission('items.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadImage(@Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('لم يتم إرفاق أي صورة');
    return this.items.setImage(id, file);
  }

  @Delete(':id/image')
  @RequirePermission('items.manage')
  removeImage(@Param('id') id: string) {
    return this.items.removeImage(id);
  }

  // Not gated behind items.manage -- reading the effective per-channel
  // price list is display data (same visibility as the item's own base
  // price), only setting/removing an override is a management action.
  @Get(':id/channel-prices')
  getChannelPrices(@Param('id') id: string) {
    return this.items.getChannelPrices(id);
  }

  @Put(':id/channel-prices/:channelId')
  @RequirePermission('items.manage')
  setChannelPrice(@Param('id') id: string, @Param('channelId') channelId: string, @Body() dto: SetChannelPriceDto) {
    return this.items.setChannelPrice(id, channelId, dto.price);
  }

  @Delete(':id/channel-prices/:channelId')
  @RequirePermission('items.manage')
  removeChannelPrice(@Param('id') id: string, @Param('channelId') channelId: string) {
    return this.items.removeChannelPrice(id, channelId);
  }
}
