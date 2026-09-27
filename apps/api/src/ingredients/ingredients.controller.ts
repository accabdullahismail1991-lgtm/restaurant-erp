import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { BulkImportBodyDto } from '../common/bulk-import.util';
import { ConvertUnitDto } from './dto/convert-unit.dto';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { SetRecipeDto } from './dto/set-recipe.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { IngredientsService } from './ingredients.service';

@Controller('ingredients')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class IngredientsController {
  constructor(private readonly ingredients: IngredientsService) {}

  @Post()
  @RequirePermission('ingredients.manage')
  create(@Body() dto: CreateIngredientDto) {
    return this.ingredients.create(dto);
  }

  @Post('bulk-import')
  @RequirePermission('ingredients.manage')
  bulkImport(@Body() body: BulkImportBodyDto) {
    return this.ingredients.bulkImport(body.rows);
  }

  @Get()
  @RequirePermission('ingredients.view')
  findAll() {
    return this.ingredients.findAll();
  }

  @Get(':id')
  @RequirePermission('ingredients.view')
  findOne(@Param('id') id: string) {
    return this.ingredients.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('ingredients.manage')
  update(@Param('id') id: string, @Body() dto: UpdateIngredientDto) {
    return this.ingredients.update(id, dto);
  }

  // Unlike update() above (which just refuses a unit change once there's
  // movement), this rescales every stored quantity/cost that depends on
  // the unit -- see IngredientsService.convertUnit()'s comment for the
  // exact math and what it deliberately won't touch.
  @Patch(':id/convert-unit')
  @RequirePermission('ingredients.manage')
  convertUnit(@Param('id') id: string, @Body() dto: ConvertUnitDto) {
    return this.ingredients.convertUnit(id, dto);
  }

  @Get(':id/recipe')
  @RequirePermission('ingredients.view')
  getRecipe(@Param('id') id: string) {
    return this.ingredients.getRecipe(id);
  }

  @Put(':id/recipe')
  @RequirePermission('ingredients.manage')
  setRecipe(@Param('id') id: string, @Body() dto: SetRecipeDto) {
    return this.ingredients.setRecipe(id, dto);
  }

  // Same permission as /inventory/cost-adjustments -- this is exactly that
  // action, just computed and applied across every ingredient at once
  // instead of one at a time. See IngredientsService.recomputeCosts.
  @Post('recompute-costs')
  @HttpCode(200)
  @RequirePermission('inventory.adjust')
  recomputeCosts(@CurrentUser() user: { userId: string }) {
    return this.ingredients.recomputeCosts(user.userId);
  }
}
