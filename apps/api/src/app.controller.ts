import { Controller, Get } from '@nestjs/common';

// Render's health check hits this with a plain GET and expects a 2xx --
// unauthenticated and DB-free on purpose so a healthy process always
// answers it immediately, regardless of auth/DB state.
@Controller()
export class AppController {
  @Get()
  health() {
    return { status: 'ok' };
  }
}
