import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  type CreateUserRequest,
  type ResetPasswordRequest,
  type UpdateUserRequest,
  type User,
  type UserListResponse,
  createUserRequestSchema,
  resetPasswordRequestSchema,
  updateUserRequestSchema,
  userIdParamSchema,
} from '@camex/shared';
import { Auth, type AuthContext } from '../auth/auth-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(): Promise<UserListResponse> {
    return { users: await this.users.list() };
  }

  @Post()
  create(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(createUserRequestSchema)) body: CreateUserRequest,
  ): Promise<User> {
    return this.users.create(body, auth.user.id);
  }

  @Patch(':id')
  update(
    @Auth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(userIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateUserRequestSchema)) body: UpdateUserRequest,
  ): Promise<User> {
    return this.users.update(id, body, auth.user.id);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @Auth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(userIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(resetPasswordRequestSchema)) body: ResetPasswordRequest,
  ): Promise<User> {
    return this.users.resetPassword(id, body, auth.user.id);
  }
}
