import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { SetRecipeDto } from '../ingredients/dto/set-recipe.dto';
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
}
