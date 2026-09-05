import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Open CORS -- this is an API meant to be called from a browser-based POS
  // (and, for now, the standalone demo login page in prototypes/), not a
  // server-to-server-only service. Tighten this to an explicit origin list
  // once there's a real deployed frontend origin to allow instead.
  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip any body field not declared on the DTO
      forbidNonWhitelisted: true, // ...and reject the request if one was sent
      transform: true,
    }),
  );
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`restaurant-erp API listening on :${port}`);
}
bootstrap();
