import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CombosController } from './combos.controller';
import { CombosService } from './combos.service';

@Module({
  imports: [AuthModule],
  controllers: [CombosController],
  providers: [CombosService],
  exports: [CombosService],
})
export class CombosModule {}
