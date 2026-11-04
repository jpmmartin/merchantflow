import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { decodeMasterKey } from '../../config/master-key.js';
import { SECRET_CIPHER, SecretCipher } from './secret-cipher.js';

/**
 * Builds the cipher from `CREDENTIALS_MASTER_KEY`, which the configuration
 * module has already checked to be 32 bytes of canonical base64 (an invalid
 * value stops startup there). Without the variable, production refuses to
 * start, and development and test start without a cipher: connecting a
 * processor account then answers 503 `CREDENTIALS_KEY_NOT_CONFIGURED`.
 */
export const secretCipherProvider: Provider = {
  provide: SECRET_CIPHER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): SecretCipher | null => {
    const encoded = config.get('CREDENTIALS_MASTER_KEY', { infer: true });
    if (encoded === undefined) {
      if (config.get('NODE_ENV', { infer: true }) === 'production') {
        throw new Error(
          'CREDENTIALS_MASTER_KEY is required in production: set it to 32 random bytes in base64',
        );
      }
      new Logger('SecretCipher').warn(
        'CREDENTIALS_MASTER_KEY is not set; processor accounts cannot be connected',
      );
      return null;
    }
    return new SecretCipher(decodeMasterKey(encoded));
  },
};
