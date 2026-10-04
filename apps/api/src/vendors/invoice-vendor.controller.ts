import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  type InvoiceDetail,
  type LinkInvoiceVendorRequest,
  linkInvoiceVendorRequestSchema,
  uuidSchema,
} from '@camex/shared';
import { Auth, type AuthContext } from '../auth/auth-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { InvoiceVendorService } from './invoice-vendor.service.js';

/** Vendor actions on one invoice. Both return the re-evaluated invoice. */
@Controller('invoices')
export class InvoiceVendorController {
  constructor(private readonly invoiceVendor: InvoiceVendorService) {}

  @Post(':id/vendor')
  @HttpCode(200)
  link(
    @Auth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(linkInvoiceVendorRequestSchema)) body: LinkInvoiceVendorRequest,
  ): Promise<InvoiceDetail> {
    return this.invoiceVendor.link(id, body, auth.user.id);
  }

  @Post(':id/trust-bank-details')
  @HttpCode(200)
  trustBankDetails(
    @Auth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<InvoiceDetail> {
    return this.invoiceVendor.trustBankDetails(id, auth.user.id);
  }
}
