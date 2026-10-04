import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:isPublic';

/** Opts a route (or controller) out of the global session guard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
