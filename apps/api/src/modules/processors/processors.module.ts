import { ProcessorAdapterRegistry } from '@merchantflow/processor-contracts';
import { StripeAdapter } from '@merchantflow/processor-stripe';
import { Module } from '@nestjs/common';
import { PROCESSOR_REGISTRY } from './application/processor-registry.js';

/**
 * Provides the registry of processor adapters. Adapters hold no credentials:
 * each call receives those of one merchant account, so registering an adapter
 * needs no configuration.
 */
@Module({
  providers: [
    {
      provide: PROCESSOR_REGISTRY,
      useFactory: () => new ProcessorAdapterRegistry([new StripeAdapter()]),
    },
  ],
  exports: [PROCESSOR_REGISTRY],
})
export class ProcessorsModule {}
