import type { ServerResponse } from 'node:http';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  GetLivenessService,
  type LivenessReport,
} from '../application/get-liveness.service.js';
import {
  GetReadinessService,
  type ReadinessReport,
} from '../application/get-readiness.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly getLiveness: GetLivenessService,
    private readonly getReadiness: GetReadinessService,
  ) {}

  @Get('live')
  live(): LivenessReport {
    return this.getLiveness.execute();
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<ReadinessReport> {
    const report = await this.getReadiness.execute();
    switch (report.status) {
      case 'ready':
        return report;
      case 'unavailable':
        // Probes read the status and this fixed body, which is not the API
        // error shape, so the report is returned with a 503 instead of thrown.
        response.statusCode = HttpStatus.SERVICE_UNAVAILABLE;
        return report;
    }
  }
}
