import { BadRequestException, Body, Controller, Get, Param, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { GenerateAllReportsDto } from './dto/generate-all-reports.dto';
import { GenerateReportDto } from './dto/generate-report.dto';
import { DashboardKind, ReportsService } from './reports.service';

const CONTENT_TYPE: Record<string, string> = {
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
};

// Same sensitivity as /analytics -- generating or downloading a report
// exposes the exact same revenue/margin numbers, so it's gated behind the
// same analytics.view permission rather than "just logged in".
@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('analytics.view')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('generate')
  generate(@Body() dto: GenerateReportDto, @CurrentUser() user: { userId: string }) {
    return this.reports.generateNow(user.userId, dto.locationId, dto.from, dto.to, dto.format);
  }

  // Runs the exact same system-level generation the daily @Cron job runs
  // (every active location + one org-wide bundle, both formats) without
  // waiting for the schedule -- lets an admin trigger "today's batch" on
  // demand instead of only ever seeing it appear at 1am server time.
  @Post('generate-all')
  generateAll(@Body() dto: GenerateAllReportsDto) {
    return this.reports.generateForAllLocations(dto.from, dto.to);
  }

  @Get()
  list(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.reports.list(user.userId, locationId);
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    const report = await this.reports.download(user.userId, id);
    return new StreamableFile(report.fileData, {
      type: CONTENT_TYPE[report.format] ?? 'application/octet-stream',
      disposition: `attachment; filename="${report.fileName}"`,
    });
  }

  // On-demand export of the on-screen dashboard the user is already
  // looking at (Sales/Production/Purchasing/Items/Inventory) -- streamed
  // straight back, no GeneratedReport row persisted (see the service
  // method's own comment for why).
  private static readonly DASHBOARD_KINDS: DashboardKind[] = ['sales', 'production', 'purchasing', 'items', 'inventory'];
  @Get('dashboard-export')
  async dashboardExport(
    @CurrentUser() user: { userId: string },
    @Query('kind') kind: string,
    @Query('format') format: string,
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!ReportsController.DASHBOARD_KINDS.includes(kind as DashboardKind)) throw new BadRequestException('kind غير صالح');
    if (format !== 'XLSX' && format !== 'PDF') throw new BadRequestException('format يجب أن يكون XLSX أو PDF');
    const { buffer, fileName } = await this.reports.buildDashboardExport(user.userId, kind as DashboardKind, format, locationId, from, to);
    return new StreamableFile(buffer, {
      type: CONTENT_TYPE[format],
      disposition: `attachment; filename="${fileName}"`,
    });
  }
}
