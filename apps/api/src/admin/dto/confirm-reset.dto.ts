import { Equals } from 'class-validator';

// Requires the caller to echo back the exact phrase shown in the admin
// panel's confirmation dialog -- a lightweight guard against a destructive
// action firing from a stray double-click or an automated retry, on top of
// the system.reset_data permission check the controller already requires.
export class ConfirmResetMasterDataDto {
  @Equals('RESET-MASTER-DATA')
  confirm: string;
}

export class ConfirmFullWipeDto {
  @Equals('FULL-WIPE-EVERYTHING')
  confirm: string;
}

export class ConfirmResetTransactionsDto {
  @Equals('RESET-TRANSACTIONS')
  confirm: string;
}
