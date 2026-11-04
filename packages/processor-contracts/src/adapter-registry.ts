import type { ProcessorCapability } from './capability.js';
import { isProviderCode, type ProcessorAdapter } from './processor-adapter.js';

/**
 * The adapters available at runtime, by provider code. A provider without an
 * adapter here is not supported, whatever is stored in the database.
 */
export class ProcessorAdapterRegistry {
  private readonly adapters: ReadonlyMap<string, ProcessorAdapter>;

  /**
   * Fails on an adapter whose code has the wrong format and on two adapters
   * with the same code, so a misconfigured registry stops the application at
   * startup.
   */
  constructor(adapters: readonly ProcessorAdapter[]) {
    const byProvider = new Map<string, ProcessorAdapter>();
    for (const adapter of adapters) {
      if (!isProviderCode(adapter.provider)) {
        throw new Error(`invalid provider code: ${adapter.provider}`);
      }
      if (byProvider.has(adapter.provider)) {
        throw new Error(`duplicate adapter for provider: ${adapter.provider}`);
      }
      byProvider.set(adapter.provider, adapter);
    }
    this.adapters = byProvider;
  }

  /** The adapter of a provider, or `undefined` when none is registered. */
  find(provider: string): ProcessorAdapter | undefined {
    return this.adapters.get(provider);
  }

  /** The adapter of a provider when it declares the capability. */
  findWithCapability(
    provider: string,
    capability: ProcessorCapability,
  ): ProcessorAdapter | undefined {
    const adapter = this.adapters.get(provider);
    return adapter?.capabilities.has(capability) === true ? adapter : undefined;
  }

  /** The registered provider codes, sorted. */
  providers(): readonly string[] {
    return [...this.adapters.keys()].sort();
  }
}
