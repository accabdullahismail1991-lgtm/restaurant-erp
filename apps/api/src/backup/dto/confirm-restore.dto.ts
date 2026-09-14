import { Equals, IsOptional, IsString } from 'class-validator';

// Same "echo back the exact phrase" guard AdminController's full-wipe/
// reset-master-data DTOs already use -- restore is strictly more
// destructive than either of those (it also wipes Users/Roles/Permissions,
// which fullWipe deliberately preserves), so it needs the same guard, not
// a weaker one.
export class ConfirmRestoreDto {
  @Equals('RESTORE-BACKUP-OVERWRITE-EVERYTHING')
  confirm: string;
}

export class CreateBackupDto {
  @IsOptional()
  @IsString()
  note?: string;
}
