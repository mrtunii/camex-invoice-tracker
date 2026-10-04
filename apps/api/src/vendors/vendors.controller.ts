import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type CreateVendorRequest,
  type UpdateVendorRequest,
  type VendorDetail,
  type VendorListQuery,
  type VendorListResponse,
  createVendorRequestSchema,
  updateVendorRequestSchema,
  uuidSchema,
  vendorListQuerySchema,
} from '@camex/shared';
import { Auth, type AuthContext } from '../auth/auth-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { VendorsService } from './vendors.service.js';

@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(vendorListQuerySchema)) query: VendorListQuery,
  ): Promise<VendorListResponse> {
    return { vendors: await this.vendors.list(query) };
  }

  @Get(':id')
  get(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<VendorDetail> {
    return this.vendors.get(id);
  }

  @Post()
  create(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(createVendorRequestSchema)) body: CreateVendorRequest,
  ): Promise<VendorDetail> {
    return this.vendors.create(body, auth.user.id);
  }

  @Patch(':id')
  update(
    @Auth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(updateVendorRequestSchema)) body: UpdateVendorRequest,
  ): Promise<VendorDetail> {
    return this.vendors.update(id, body, auth.user.id);
  }

  /** Soft removal; idempotent. Returns the vendor with the account marked removed. */
  @Delete(':id/bank-accounts/:accountId')
  @HttpCode(200)
  removeBankAccount(
    @Auth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('accountId', new ZodValidationPipe(uuidSchema)) accountId: string,
  ): Promise<VendorDetail> {
    return this.vendors.removeBankAccount(id, accountId, auth.user.id);
  }
}
