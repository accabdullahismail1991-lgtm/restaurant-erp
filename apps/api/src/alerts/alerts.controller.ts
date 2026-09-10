import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AlertsService } from './alerts.service';

@Controller('alerts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  getAlerts(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.alerts.getAlerts(user.userId, locationId);
  }
}
