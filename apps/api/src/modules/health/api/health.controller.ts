import { Controller, Get } from '@nestjs/common';
import {
  GetLivenessService,
  type LivenessReport,
} from '../application/get-liveness.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly getLiveness: GetLivenessService) {}

  @Get('live')
  live(): LivenessReport {
    return this.getLiveness.execute();
  }
}
