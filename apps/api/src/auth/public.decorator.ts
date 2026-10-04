import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:isPublic';

/** Opts a route (or controller) out of the global session guard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_DURING_PASSWORD_CHANGE = 'auth:allowDuringPasswordChange';

/**
 * Keeps a route reachable while the user must change their password (must_change_password).
 * Everything else answers 403 PASSWORD_CHANGE_REQUIRED until they do.
 */
export const AllowDuringPasswordChange = () => SetMetadata(ALLOW_DURING_PASSWORD_CHANGE, true);
