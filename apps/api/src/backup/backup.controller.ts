import { BadRequestException, Body, Controller, Get, Param, Post, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { BackupService } from './backup.service';
import { ConfirmRestoreDto, CreateBackupDto } from './dto/confirm-restore.dto';

// One narrow permission gates the whole module, same posture as
// AdminController's system.reset_data -- a restore is at least as
// destructive as full-wipe (it also replaces Users/Roles/Permissions), and
// even just downloading a backup exposes every row in the database,
// including password hashes and every customer's phone number.
@Controller('backups')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('system.backup_manage')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Post()
  create(@Body() dto: CreateBackupDto, @CurrentUser() user: { userId: string }) {
    return this.backups.createBackup(user.userId, dto.note);
  }

  @Get()
  list() {
    return this.backups.listBackups();
  }

  @Get(':id/download')
  async download(@Param('id') id: string) {
    const { buffer, fileName } = await this.backups.downloadBackup(id);
    return new StreamableFile(buffer, {
      type: 'application/json',
      disposition: `attachment; filename="${fileName}"`,
    });
  }

  @Post(':id/restore')
  restore(@Param('id') id: string, @Body() _dto: ConfirmRestoreDto) {
    return this.backups.restoreBackup(id);
  }

  // Restore from a file the caller uploads (a backup downloaded earlier,
  // from THIS system or another one) instead of one already stored here --
  // this is what makes cross-environment migration possible (e.g. export a
  // backup from a local/sandbox instance, upload it into a freshly
  // deployed one) without needing both databases reachable from the same
  // place at once.
  @Post('restore-from-upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  restoreFromUpload(@UploadedFile() file: Express.Multer.File | undefined, @Body() _dto: ConfirmRestoreDto) {
    if (!file) throw new BadRequestException('لم يتم إرفاق ملف النسخة الاحتياطية');
    return this.backups.restoreFromUpload(file.buffer);
  }
}
