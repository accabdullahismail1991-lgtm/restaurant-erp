import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'requiredPermission';

// Declares which Permission.code a route requires. PermissionsGuard reads
// this via Reflector and checks it against the CURRENT DB state of the
// caller's roles -- not anything baked into their JWT.
export const RequirePermission = (code: string) => SetMetadata(PERMISSION_KEY, code);
