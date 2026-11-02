import { Injectable } from '@nestjs/common';

export interface LivenessReport {
  readonly status: 'ok';
}

/** Reports that the process is running and able to serve requests. */
@Injectable()
export class GetLivenessService {
  execute(): LivenessReport {
    return { status: 'ok' };
  }
}
