// Deliberately minimal: just enough to identify the user and the token's
// purpose. Roles/permissions are NOT baked in here -- PermissionsGuard
// re-reads them from the DB on every request, so revoking a role or
// permission takes effect immediately instead of only after the token
// expires or the user logs in again. That's a real correctness property
// for anything gating money (purchase-order approval, cash reconciliation).
export interface JwtPayload {
  sub: string; // User.id
  type: 'access' | 'refresh';
}
