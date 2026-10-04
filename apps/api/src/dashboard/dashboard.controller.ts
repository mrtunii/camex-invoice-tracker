import { Controller, Get, Query } from '@nestjs/common';
import { type Dashboard, type DashboardQuery, dashboardQuerySchema } from '@camex/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DashboardService } from './dashboard.service.js';

/** Home (T05b): what needs attention and what was spent. */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(
    @Query(new ZodValidationPipe(dashboardQuerySchema)) query: DashboardQuery,
  ): Promise<Dashboard> {
    return this.dashboard.get(query);
  }
}
