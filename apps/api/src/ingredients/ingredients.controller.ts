import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { BulkImportBodyDto } from '../common/bulk-import.util';
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
  findAll() {
    return this.ingredients.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ingredients.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('ingredients.manage')
  update(@Param('id') id: string, @Body() dto: UpdateIngredientDto) {
    return this.ingredients.update(id, dto);
  }

  @Get(':id/recipe')
  getRecipe(@Param('id') id: string) {
    return this.ingredients.getRecipe(id);
  }

  @Put(':id/recipe')
  @RequirePermission('ingredients.manage')
  setRecipe(@Param('id') id: string, @Body() dto: SetRecipeDto) {
    return this.ingredients.setRecipe(id, dto);
  }
}
