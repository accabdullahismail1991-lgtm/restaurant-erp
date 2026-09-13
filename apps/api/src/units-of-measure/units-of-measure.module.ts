import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UnitsOfMeasureController } from './units-of-measure.controller';
import { UnitsOfMeasureService } from './units-of-measure.service';

@Module({
  imports: [AuthModule],
  controllers: [UnitsOfMeasureController],
  providers: [UnitsOfMeasureService],
})
export class UnitsOfMeasureModule {}
