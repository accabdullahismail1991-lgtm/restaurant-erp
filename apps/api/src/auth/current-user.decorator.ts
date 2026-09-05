import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Reads the {userId} JwtStrategy.validate() attached to the request --
// use in any controller method guarded by JwtAuthGuard.
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.user as { userId: string };
});
