import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';

@Module({
  providers: [JournalService],
  exports: [JournalService],
})
export class AccountingModule {}
