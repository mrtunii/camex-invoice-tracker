import {
  type ExtractionOutputV1,
  vendorConflictSchema,
  vendorDetailSchema,
  vendorListResponseSchema,
} from '@camex/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestApp,
  createTestApp,
  createUser,
  expectedExtraction,
  flagCodes,
  ingestFixture,
  login,
  pdfVariant,
  resetDatabase,
  resetJobs,
  setToday,
  wireFromExpected,
} from './helpers.js';

describe('vendors API', () => {
  let t: TestApp;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    t = await createTestApp(); // workers off: tests run the extraction handler themselves
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
    userId = (await createUser(t.prisma, { email: 'clerk@camex.aero', name: 'Nino Clerk' })).id;
    cookie = await login(t, 'clerk@camex.aero');
    setToday(t, '2026-10-02');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const post = (path: string, body: object) => t.http().post(path).set('Cookie', cookie).send(body);
  const patch = (path: string, body: object) =>
    t.http().patch(path).set('Cookie', cookie).send(body);
  const get = (path: string) => t.http().get(path).set('Cookie', cookie);
  const del = (path: string) => t.http().delete(path).set('Cookie', cookie);

  async function createVendor(body: object): Promise<string> {
    const res = await post('/api/vendors', body).expect(201);
    return res.body.id as string;
  }

  async function invoiceRow(id: string) {
    return t.prisma.invoice.findUniqueOrThrow({ where: { id } });
  }

  describe('create, read, update, search', () => {
    it('creates a vendor; domains lowercased, repeated aliases and domains dropped', async () => {
      const res = await post('/api/vendors', {
        name: '  AEG Fuels Ireland Limited ',
        aliases: ['AEG Fuels', 'AEG FUELS IRELAND LTD', 'aeg fuels'],
        emailDomains: ['AEGFuels.com', 'aegfuels.com'],
        defaultPaymentTermsDays: 7,
      }).expect(201);
      expect(vendorDetailSchema.strict().parse(res.body)).toEqual({
        id: expect.any(String),
        name: 'AEG Fuels Ireland Limited',
        // "AEG FUELS IRELAND LTD" has the name's key; "aeg fuels" repeats "AEG Fuels".
        aliases: ['AEG Fuels'],
        emailDomains: ['aegfuels.com'],
        defaultPaymentTermsDays: 7,
        activeBankAccountCount: 0,
        openInvoiceCount: 0,
        bankAccounts: [],
      });
    });

    it('lists vendors sorted by name with counts; search matches name, alias or domain', async () => {
      await createVendor({
        name: 'petrocas Fuel Services Georgia LLC',
        emailDomains: ['petrocas.ge'],
      });
      await createVendor({
        name: 'AEG Fuels Ireland Limited',
        aliases: ['Associated Energy Group'],
      });
      await createVendor({ name: 'Aviation Services Management FZE' });

      const all = vendorListResponseSchema.parse((await get('/api/vendors').expect(200)).body);
      expect(all.vendors.map((v) => v.name)).toEqual([
        'AEG Fuels Ireland Limited',
        'Aviation Services Management FZE',
        'petrocas Fuel Services Georgia LLC',
      ]);
      expect(all.vendors[0]).toEqual({
        id: expect.any(String),
        name: 'AEG Fuels Ireland Limited',
        aliases: ['Associated Energy Group'],
        emailDomains: [],
        defaultPaymentTermsDays: null,
        activeBankAccountCount: 0,
        openInvoiceCount: 0,
      });

      const names = async (search: string) =>
        (
          (await get(`/api/vendors?search=${encodeURIComponent(search)}`).expect(200)).body
            .vendors as { name: string }[]
        ).map((v) => v.name);
      expect(await names('energy')).toEqual(['AEG Fuels Ireland Limited']);
      expect(await names('PETROCAS.GE')).toEqual(['petrocas Fuel Services Georgia LLC']);
      expect(await names('fuel')).toEqual([
        'AEG Fuels Ireland Limited',
        'petrocas Fuel Services Georgia LLC',
      ]);
      expect(await names('nothing')).toEqual([]);
    });

    it('openInvoiceCount counts needs_review and unpaid invoices', async () => {
      const vendorId = await createVendor({ name: 'Aviation Services Management FZE' });
      const a = await ingestFixture(t, 'asm');
      const b = await ingestFixture(t, 'asm', {
        pdf: pdfVariant('asm', 'b'),
        wire: { invoiceNumber: 'SI-2' },
      });
      const c = await ingestFixture(t, 'asm', {
        pdf: pdfVariant('asm', 'c'),
        wire: { invoiceNumber: 'SI-3' },
      });
      await t.prisma.invoice.update({ where: { id: b }, data: { status: 'unpaid' } });
      await t.prisma.invoice.update({ where: { id: c }, data: { status: 'paid' } });
      expect((await invoiceRow(a)).vendorId).toBe(vendorId);
      expect((await get(`/api/vendors/${vendorId}`).expect(200)).body.openInvoiceCount).toBe(2);
    });

    it('updates any field; terms can be cleared with null', async () => {
      const id = await createVendor({ name: 'ASM', defaultPaymentTermsDays: 30 });
      const res = await patch(`/api/vendors/${id}`, {
        name: 'Aviation Services Management FZE',
        aliases: ['ASM'],
        emailDomains: ['asm.aero'],
        defaultPaymentTermsDays: null,
      }).expect(200);
      expect(res.body).toMatchObject({
        name: 'Aviation Services Management FZE',
        aliases: ['ASM'],
        emailDomains: ['asm.aero'],
        defaultPaymentTermsDays: null,
      });
      // Untouched fields stay.
      const terms = await patch(`/api/vendors/${id}`, { defaultPaymentTermsDays: 0 }).expect(200);
      expect(terms.body).toMatchObject({
        aliases: ['ASM'],
        emailDomains: ['asm.aero'],
        defaultPaymentTermsDays: 0,
      });
    });

    it('validates input: 400 for bad names, terms, domains and empty updates', async () => {
      const issues = async (body: object) =>
        ((await post('/api/vendors', body).expect(400)).body.issues as { path: string }[]).map(
          (i) => i.path,
        );
      expect(await issues({ name: '' })).toEqual(['name']);
      expect(await issues({ name: 'LLC' })).toEqual(['name']);
      expect(await issues({ name: 'X', aliases: ['Ltd.'] })).toEqual(['aliases.0']);
      expect(await issues({ name: 'X', defaultPaymentTermsDays: 366 })).toEqual([
        'defaultPaymentTermsDays',
      ]);
      expect(await issues({ name: 'X', defaultPaymentTermsDays: -1 })).toEqual([
        'defaultPaymentTermsDays',
      ]);
      expect(await issues({ name: 'X', defaultPaymentTermsDays: 1.5 })).toEqual([
        'defaultPaymentTermsDays',
      ]);
      expect(await issues({ name: 'X', emailDomains: ['not a domain'] })).toEqual([
        'emailDomains.0',
      ]);
      expect(await issues({ name: 'X', emailDomains: ['ok.com', 'billing@aeg.com'] })).toEqual([
        'emailDomains.1',
      ]);
      expect(await issues({ name: 'X', emailDomains: ['localhost'] })).toEqual(['emailDomains.0']);
      expect(await issues({ name: 'X', extra: true })).toEqual(['']);
      await post('/api/vendors', { name: 'X', defaultPaymentTermsDays: 365 }).expect(201);

      const id = await createVendor({ name: 'Y' });
      await patch(`/api/vendors/${id}`, {}).expect(400);
      await get('/api/vendors/not-a-uuid').expect(400);
      await get('/api/vendors/00000000-0000-0000-0000-000000000000').expect(404);
      await patch('/api/vendors/00000000-0000-0000-0000-000000000000', { name: 'Z' }).expect(404);
    });

    it('rejects public mailbox domains and Camex domains (incl. subdomains) with 400', async () => {
      for (const domain of ['gmail.com', 'Outlook.com', 'proton.me', 'mail.ru']) {
        const res = await post('/api/vendors', { name: 'X', emailDomains: [domain] }).expect(400);
        expect(res.body.issues).toEqual([
          { path: 'emailDomains.0', message: "A public mailbox domain can't identify a vendor" },
        ]);
      }
      for (const domain of ['camex.aero', 'in.camex.aero']) {
        const res = await post('/api/vendors', {
          name: 'X',
          emailDomains: ['ok.example', domain],
        }).expect(400);
        expect(res.body.issues).toEqual([
          { path: 'emailDomains.1', message: `${domain} is a Camex domain` },
        ]);
      }
      const id = await createVendor({ name: 'X' });
      await patch(`/api/vendors/${id}`, { emailDomains: ['camex.aero'] }).expect(400);
    });
  });

  describe('409: names, aliases and domains are unique across vendors', () => {
    let aegId: string;

    beforeEach(async () => {
      aegId = await createVendor({
        name: 'AEG Fuels Ireland Limited',
        aliases: ['Associated Energy Group LLC'],
        emailDomains: ['aegfuels.com'],
      });
    });

    function conflict(res: { body: unknown }) {
      return vendorConflictSchema.parse(res.body);
    }

    it('a name equal (by key) to another vendor’s name', async () => {
      const res = await post('/api/vendors', { name: 'AEG FUELS IRELAND LTD.' }).expect(409);
      expect(conflict(res)).toEqual({
        statusCode: 409,
        message:
          'Vendor "AEG Fuels Ireland Limited" already uses the name "AEG FUELS IRELAND LTD."',
        field: 'name',
        vendor: { id: aegId, name: 'AEG Fuels Ireland Limited' },
      });
    });

    it('a name equal to another vendor’s alias', async () => {
      const res = await post('/api/vendors', { name: 'Associated Energy Group' }).expect(409);
      expect(conflict(res).field).toBe('name');
    });

    it('an alias equal to another vendor’s name or alias, with its index', async () => {
      const res = await post('/api/vendors', {
        name: 'Somebody',
        aliases: ['Fine', 'aeg fuels ireland'],
      }).expect(409);
      expect(conflict(res)).toMatchObject({ field: 'aliases.1', vendor: { id: aegId } });
      const viaAlias = await post('/api/vendors', {
        name: 'Somebody',
        aliases: ['ASSOCIATED ENERGY GROUP'],
      }).expect(409);
      expect(conflict(viaAlias).field).toBe('aliases.0');
    });

    it('a domain of another vendor', async () => {
      const res = await post('/api/vendors', {
        name: 'Somebody',
        emailDomains: ['x.example', 'AEGFUELS.COM'],
      }).expect(409);
      expect(conflict(res)).toEqual({
        statusCode: 409,
        message: 'Vendor "AEG Fuels Ireland Limited" already uses the domain aegfuels.com',
        field: 'emailDomains.1',
        vendor: { id: aegId, name: 'AEG Fuels Ireland Limited' },
      });
    });

    it('PATCH checks against the other vendors only', async () => {
      const other = await createVendor({ name: 'Petrocas Fuel Services Georgia LLC' });
      expect(
        conflict(await patch(`/api/vendors/${other}`, { name: 'AEG Fuels Ireland' }).expect(409))
          .field,
      ).toBe('name');
      expect(
        conflict(
          await patch(`/api/vendors/${other}`, { aliases: ['Associated Energy Group'] }).expect(
            409,
          ),
        ).field,
      ).toBe('aliases.0');
      expect(
        conflict(
          await patch(`/api/vendors/${other}`, { emailDomains: ['aegfuels.com'] }).expect(409),
        ).field,
      ).toBe('emailDomains.0');
      // Its own name, alias and domains are fine; renaming to its own alias drops that alias.
      const renamed = await patch(`/api/vendors/${aegId}`, {
        name: 'Associated Energy Group',
        emailDomains: ['aegfuels.com'],
      }).expect(200);
      expect(renamed.body).toMatchObject({
        name: 'Associated Energy Group',
        aliases: [],
        emailDomains: ['aegfuels.com'],
      });
    });
  });

  describe('creating or changing a vendor re-evaluates invoices', () => {
    it('creating a vendor links pending invoices by name and updates their flags', async () => {
      const asm = await ingestFixture(t, 'asm');
      expect(flagCodes((await invoiceRow(asm)).flags)).toEqual(['DISPUTE_SOON', 'NEW_VENDOR']);

      const vendorId = await createVendor({ name: 'Aviation Services Management' });
      const row = await invoiceRow(asm);
      expect(row.vendorId).toBe(vendorId);
      expect(flagCodes(row.flags)).toEqual(['BANK_FIRST_SEEN', 'DISPUTE_SOON']);
      const events = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: asm, type: 'vendor_linked' },
      });
      expect(events).toMatchObject([{ userId: null, data: { vendorId, method: 'name' } }]);
      expect((await get(`/api/vendors/${vendorId}`).expect(200)).body.openInvoiceCount).toBe(1);
    });

    it('a new alias or domain links on update; default terms re-derive due dates', async () => {
      const petrocas = await ingestFixture(t, 'petrocas');
      const vendorId = await createVendor({ name: 'Petrocas Georgia' });
      expect((await invoiceRow(petrocas)).vendorId).toBeNull();

      await patch(`/api/vendors/${vendorId}`, {
        aliases: ['Petrocas Fuel Services Georgia'],
      }).expect(200);
      let row = await invoiceRow(petrocas);
      expect(row.vendorId).toBe(vendorId);
      expect(row.dueDate).toBeNull();
      expect(flagCodes(row.flags)).toEqual([
        'MISSING_REQUIRED',
        'BANK_FIRST_SEEN',
        'PAY_IN_OTHER_CURRENCY',
      ]);

      await patch(`/api/vendors/${vendorId}`, { defaultPaymentTermsDays: 10 }).expect(200);
      row = await invoiceRow(petrocas);
      expect(row.dueDate?.toISOString().slice(0, 10)).toBe('2026-10-12');
      expect(row.dueDateSource).toBe('vendor_default');
      expect(flagCodes(row.flags)).toEqual([
        'BANK_FIRST_SEEN',
        'DUE_DATE_DERIVED',
        'PAY_IN_OTHER_CURRENCY',
      ]);

      await patch(`/api/vendors/${vendorId}`, { defaultPaymentTermsDays: null }).expect(200);
      row = await invoiceRow(petrocas);
      expect(row.dueDate).toBeNull();
      expect(row.dueDateSource).toBeNull();
    });
  });

  describe('POST /api/invoices/:id/vendor', () => {
    it('links an existing vendor and adds the extracted name as an alias', async () => {
      const aeg = await ingestFixture(t, 'aeg');
      const vendorId = await createVendor({ name: 'AEG Fuels', emailDomains: ['aegfuels.com'] });
      expect((await invoiceRow(aeg)).vendorId).toBeNull(); // "AEG Fuels Ireland" ≠ "AEG Fuels"

      const res = await post(`/api/invoices/${aeg}/vendor`, { vendorId }).expect(200);
      expect(res.body).toMatchObject({
        vendorId,
        vendor: { id: vendorId, name: 'AEG Fuels' },
      });
      expect(flagCodes(res.body.flags)).toEqual(['BANK_FIRST_SEEN', 'DISPUTE_SOON']);
      expect((await get(`/api/vendors/${vendorId}`).expect(200)).body.aliases).toEqual([
        'AEG Fuels Ireland Limited',
      ]);
      const events = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: aeg, type: 'vendor_linked' },
      });
      expect(events).toMatchObject([{ userId, data: { vendorId, method: 'manual' } }]);

      // The new alias matches the next AEG invoice automatically.
      const next = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', '2'),
        wire: { invoiceNumber: '3110714' },
      });
      expect((await invoiceRow(next)).vendorId).toBe(vendorId);
    });

    it('adds no alias when the vendor already answers to the extracted name', async () => {
      const asm = await ingestFixture(t, 'asm');
      const vendorId = await createVendor({ name: 'Aviation Services Management FZE' });
      // Already linked by name; linking again records the manual link, aliases unchanged.
      await post(`/api/invoices/${asm}/vendor`, { vendorId }).expect(200);
      expect((await get(`/api/vendors/${vendorId}`).expect(200)).body.aliases).toEqual([]);
    });

    it('creates a vendor and links it; the new vendor also links other pending invoices', async () => {
      const first = await ingestFixture(t, 'aeg');
      const second = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', '2'),
        wire: { invoiceNumber: '3110714' },
      });
      const res = await post(`/api/invoices/${first}/vendor`, {
        create: { name: 'AEG Fuels', defaultPaymentTermsDays: 7 },
      }).expect(200);
      const vendorId = res.body.vendorId as string;
      const vendor = (await get(`/api/vendors/${vendorId}`).expect(200)).body;
      expect(vendor).toMatchObject({
        name: 'AEG Fuels',
        aliases: ['AEG Fuels Ireland Limited'],
        defaultPaymentTermsDays: 7,
      });
      const linked = await invoiceRow(second);
      expect(linked.vendorId).toBe(vendorId);
      expect(flagCodes(linked.flags)).toEqual(['BANK_FIRST_SEEN', 'DISPUTE_SOON']);
    });

    it('corrects a wrong match: the extracted name stays with the vendor that owns it', async () => {
      const aeg = await ingestFixture(t, 'aeg');
      const owner = await createVendor({ name: 'Somebody', aliases: ['AEG Fuels Ireland Ltd'] });
      // The owner's alias matches by key, so the invoice was linked to it automatically.
      expect((await invoiceRow(aeg)).vendorId).toBe(owner);

      const vendorId = await createVendor({ name: 'AEG Fuels' });
      const res = await post(`/api/invoices/${aeg}/vendor`, { vendorId }).expect(200);
      expect(res.body.vendor).toEqual({ id: vendorId, name: 'AEG Fuels' });
      // No alias added: it would break uniqueness. The owner keeps its alias.
      expect((await get(`/api/vendors/${vendorId}`).expect(200)).body.aliases).toEqual([]);
      expect((await get(`/api/vendors/${owner}`).expect(200)).body.aliases).toEqual([
        'AEG Fuels Ireland Ltd',
      ]);

      // Creating a vendor whose own name is taken is still a 409.
      const create = await post(`/api/invoices/${aeg}/vendor`, {
        create: { name: 'AEG FUELS' },
      }).expect(409);
      expect(vendorConflictSchema.parse(create.body)).toMatchObject({
        field: 'create.name',
        vendor: { id: vendorId, name: 'AEG Fuels' },
      });
      // A new vendor whose name is free is linked, also without the owner's alias.
      const created = await post(`/api/invoices/${aeg}/vendor`, {
        create: { name: 'AEG Fuels Romania' },
      }).expect(200);
      expect(created.body.vendor.name).toBe('AEG Fuels Romania');
      const romania = (await get(`/api/vendors/${created.body.vendorId as string}`).expect(200))
        .body;
      expect(romania.aliases).toEqual([]);
    });

    it('409 outside needs_review', async () => {
      const aeg = await ingestFixture(t, 'aeg');
      const vendorId = await createVendor({ name: 'AEG Fuels' });
      for (const status of ['processing', 'unpaid', 'paid', 'rejected'] as const) {
        await t.prisma.invoice.update({ where: { id: aeg }, data: { status } });
        const blocked = await post(`/api/invoices/${aeg}/vendor`, { vendorId }).expect(409);
        expect(blocked.body.message).toBe(
          'A vendor can only be linked while the invoice needs review',
        );
        await post(`/api/invoices/${aeg}/vendor`, { create: { name: 'New One' } }).expect(409);
      }
      expect(await t.prisma.vendor.count()).toBe(1);
    });

    it('400 for a bad body, 404 for an unknown invoice or vendor', async () => {
      const aeg = await ingestFixture(t, 'aeg');
      await post(`/api/invoices/${aeg}/vendor`, {}).expect(400);
      await post(`/api/invoices/${aeg}/vendor`, { vendorId: 'x' }).expect(400);
      await post(`/api/invoices/${aeg}/vendor`, {
        vendorId: '00000000-0000-0000-0000-000000000000',
      }).expect(404);
      await post('/api/invoices/00000000-0000-0000-0000-000000000000/vendor', {
        create: { name: 'X' },
      }).expect(404);
    });
  });

  describe('trusted bank accounts', () => {
    const aegBank = expectedExtraction('aeg').bankDetails;
    const otherAccount = (): Partial<ExtractionOutputV1> => ({
      invoiceNumber: '3110999',
      bankDetails: {
        ...wireFromExpected(expectedExtraction('aeg')).bankDetails,
        accountNumber: '9999 999 999',
      },
    });

    async function aegWithVendor() {
      const vendorId = await createVendor({ name: 'AEG Fuels Ireland Limited' });
      const first = await ingestFixture(t, 'aeg');
      return { vendorId, first };
    }

    it('trusting adds the account (who, when, which invoice) and updates the vendor’s open invoices', async () => {
      const { vendorId, first } = await aegWithVendor();
      const second = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', '2'),
        wire: otherAccount(),
      });
      const sameAccount = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', '3'),
        wire: { invoiceNumber: '3110888' },
      });
      expect(flagCodes((await invoiceRow(second)).flags)).toEqual([
        'BANK_FIRST_SEEN',
        'DISPUTE_SOON',
      ]);

      const res = await post(`/api/invoices/${first}/trust-bank-details`, {}).expect(200);
      expect(flagCodes(res.body.flags)).toEqual(['DISPUTE_SOON']);
      expect(flagCodes((await invoiceRow(sameAccount)).flags)).toEqual(['DISPUTE_SOON']);
      const unknown = (await invoiceRow(second)).flags as { code: string; severity: string }[];
      expect(unknown[0]).toMatchObject({
        code: 'BANK_UNKNOWN',
        severity: 'error',
        field: 'bankDetails.accountNumber',
      });

      const vendor = vendorDetailSchema.parse(
        (await get(`/api/vendors/${vendorId}`).expect(200)).body,
      );
      expect(vendor.activeBankAccountCount).toBe(1);
      expect(vendor.bankAccounts).toEqual([
        {
          id: expect.any(String),
          beneficiary: aegBank?.beneficiary,
          bankName: aegBank?.bankName,
          iban: null,
          accountNumber: '4942312687',
          swift: 'WFBIUS6S',
          routingNumber: '121000248',
          currency: 'USD',
          addedAt: expect.any(String),
          addedBy: { id: userId, name: 'Nino Clerk' },
          sourceInvoiceId: first,
          removedAt: null,
          removedBy: null,
        },
      ]);

      // The event carries ids only.
      const [event] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: first, type: 'bank_account_trusted' },
      });
      expect(event).toMatchObject({
        userId,
        data: { vendorId, accountId: vendor.bankAccounts[0]?.id },
      });
      expect(JSON.stringify(event?.data)).not.toContain('4942312687');
    });

    it('trusting the same account again changes nothing and is 200', async () => {
      const { vendorId, first } = await aegWithVendor();
      await post(`/api/invoices/${first}/trust-bank-details`, {}).expect(200);
      const again = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', '2'),
        wire: { invoiceNumber: '3110714' },
      });
      await post(`/api/invoices/${again}/trust-bank-details`, {}).expect(200);
      await post(`/api/invoices/${first}/trust-bank-details`, {}).expect(200);
      expect((await get(`/api/vendors/${vendorId}`).expect(200)).body.bankAccounts).toHaveLength(1);
      expect(await t.prisma.invoiceEvent.count({ where: { type: 'bank_account_trusted' } })).toBe(
        1,
      );
    });

    it('works on unpaid invoices; 409 in other statuses, without a vendor or without bank details', async () => {
      const aeg = await ingestFixture(t, 'aeg'); // no vendor yet
      const res = await post(`/api/invoices/${aeg}/trust-bank-details`, {}).expect(409);
      expect(res.body.message).toBe(
        'Link the invoice to a vendor before trusting its bank details',
      );

      const vendorId = await createVendor({ name: 'AEG Fuels Ireland' });
      for (const status of ['processing', 'paid', 'rejected'] as const) {
        await t.prisma.invoice.update({ where: { id: aeg }, data: { status } });
        await post(`/api/invoices/${aeg}/trust-bank-details`, {}).expect(409);
      }
      await t.prisma.invoice.update({ where: { id: aeg }, data: { status: 'unpaid' } });
      await post(`/api/invoices/${aeg}/trust-bank-details`, {}).expect(200);
      expect((await get(`/api/vendors/${vendorId}`).expect(200)).body.activeBankAccountCount).toBe(
        1,
      );

      const noBank = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', 'nobank'),
        wire: {
          invoiceNumber: '3110777',
          bankDetails: {
            ...wireFromExpected(expectedExtraction('aeg')).bankDetails,
            accountNumber: '',
            iban: '',
          },
        },
      });
      const missing = await post(`/api/invoices/${noBank}/trust-bank-details`, {}).expect(409);
      expect(missing.body.message).toBe('The invoice has no IBAN or account number to trust');
      await post(
        '/api/invoices/00000000-0000-0000-0000-000000000000/trust-bank-details',
        {},
      ).expect(404);
    });

    it('removal is soft and idempotent; the flag comes back', async () => {
      const { vendorId, first } = await aegWithVendor();
      await post(`/api/invoices/${first}/trust-bank-details`, {}).expect(200);
      const accountId = (await get(`/api/vendors/${vendorId}`).expect(200)).body.bankAccounts[0]
        .id as string;

      const res = await del(`/api/vendors/${vendorId}/bank-accounts/${accountId}`).expect(200);
      expect(res.body.activeBankAccountCount).toBe(0);
      expect(res.body.bankAccounts).toEqual([
        expect.objectContaining({
          id: accountId,
          accountNumber: '4942312687',
          removedAt: expect.any(String),
          removedBy: { id: userId, name: 'Nino Clerk' },
        }),
      ]);
      expect(flagCodes((await invoiceRow(first)).flags)).toEqual([
        'BANK_FIRST_SEEN',
        'DISPUTE_SOON',
      ]);

      const removedAt = res.body.bankAccounts[0].removedAt as string;
      const again = await del(`/api/vendors/${vendorId}/bank-accounts/${accountId}`).expect(200);
      expect(again.body.bankAccounts[0].removedAt).toBe(removedAt);

      // Trusting again adds a new active entry; the removed one stays as history.
      await post(`/api/invoices/${first}/trust-bank-details`, {}).expect(200);
      const vendor = (await get(`/api/vendors/${vendorId}`).expect(200)).body;
      expect(vendor.bankAccounts).toHaveLength(2);
      expect(vendor.activeBankAccountCount).toBe(1);

      await del(
        `/api/vendors/${vendorId}/bank-accounts/00000000-0000-0000-0000-000000000000`,
      ).expect(404);
      await del(
        `/api/vendors/00000000-0000-0000-0000-000000000000/bank-accounts/${accountId}`,
      ).expect(404);
    });
  });
});
