import { Module } from '@nestjs/common';
import { ZatcaService } from './zatca.service';

@Module({
  providers: [ZatcaService],
  exports: [ZatcaService],
})
export class ZatcaModule {}
