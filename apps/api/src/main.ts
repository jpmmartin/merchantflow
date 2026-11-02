import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const PORT = 3000;
// Listening on all interfaces lets Docker publish the port to the host.
const HOST = '0.0.0.0';

const app = await NestFactory.create(AppModule);
await app.listen(PORT, HOST);
