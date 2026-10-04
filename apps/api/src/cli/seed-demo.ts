/**
 * Fills an empty development database with a realistic demo dataset (T05b visual QA): the three
 * sample invoices plus 25 generated ones over the last 12 months, 8 vendors, USD and GEL.
 *
 *   pnpm seed:demo
 *   DATABASE_URL=… S3_BUCKET=… pnpm seed:demo   # another database and bucket (the environment wins over .env)
 *
 * Dev only: refuses NODE_ENV=production, and refuses a database that already has invoices or
 * vendors (it never deletes anything). Dates are relative to today in Asia/Tbilisi, so the data
 * stays current; the same day gives the same data.
 *
 * Each invoice gets its own PDF in the bucket (a sample PDF with a few bytes appended, so the
 * hashes differ) and its own inbound email. Rows go through the production steps: stored as
 * `processing`, the extraction write (wire output → normalizeExtraction → columns), then the real
 * InvoiceEvaluator (vendor matching, derived dates, flags), all in one transaction, so nothing is
 * ever committed as `processing` (the recovery sweep would send it to the extractor). Approval,
 * payment and rejection fields are set afterwards and every invoice is evaluated once more.
 *
 * The services are constructed directly rather than through a Nest application context: tsx
 * (esbuild) emits no decorator metadata, so Nest can't resolve class-typed constructor params.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type BankDetails,
  type ExtractedInvoice,
  type ExtractedLineItem,
  type ExtractionOutputV1,
  type InvoiceCategory,
  type InvoiceStatus,
  addDays,
  businessToday,
  extractedInvoiceSchema,
  systemClock,
} from '@camex/shared';
import { type Env, EnvValidationError, loadRootEnvFile, parseEnv } from '../config/env.js';
import { InvoiceEvaluator } from '../evaluation/invoice-evaluator.js';
import { toJsonColumn } from '../extraction/extraction-failure.js';
import { normalizeExtraction } from '../extraction/normalize.js';
import { PROMPT_VERSION } from '../extraction/prompts/extract-v1.js';
import { Prisma, type RejectionReason } from '../generated/prisma/client.js';
import { countPdfPages, sha256Hex } from '../ingestion/files.js';
import { parseEmailAddress } from '../ingestion/mailgun.js';
import { extractedInvoiceColumns, toDateColumn } from '../invoices/invoice-columns.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService, invoicePdfKey } from '../storage/storage.service.js';
import { bankAccountsToJson, trustedAccountFrom } from '../vendors/bank-accounts.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../fixtures/invoices');
const RECIPIENT = 'invoices@in.camex.aero';
const BILL_TO = 'Camex Airlines LLC';

class SeedRefused extends Error {}

// ─── Dates ────────────────────────────────────────────────────────────────────

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Day `day` (clamped to the month's length) of the month `monthsAgo` months before today's. */
function monthDay(today: string, monthsAgo: number, day: number): string {
  const [year = 0, month = 1] = today.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 - monthsAgo, 1));
  const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return `${pad(first.getUTCFullYear(), 4)}-${pad(first.getUTCMonth() + 1)}-${pad(Math.min(day, length.getUTCDate()))}`;
}

/** A Tbilisi wall-clock time (UTC+4 all year, no DST since 2005). */
function tbilisi(date: string, minutesAfterNine: number): Date {
  const minutes = 9 * 60 + minutesAfterNine;
  return new Date(`${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00+04:00`);
}

const minutes = (date: Date, n: number) => new Date(date.getTime() + n * 60_000);
const earliest = (...dates: Date[]) => new Date(Math.min(...dates.map((d) => d.getTime())));

// ─── Vendors ──────────────────────────────────────────────────────────────────

type FixtureName = 'asm' | 'petrocas' | 'aeg';

type VendorKey = 'asm' | 'aeg' | 'petrocas' | 'skyway' | 'cas' | 'anco' | 'skychef' | 'aerotech';

interface VendorSeed {
  name: string;
  aliases: string[];
  emailDomains: string[];
  defaultPaymentTermsDays: number | null;
  /** Bank details printed on its invoices (null: none). */
  bank: BankDetails | null;
  /** Its bank details were trusted on approval of its first invoice. */
  trusted: boolean;
  /** How its invoices arrive. */
  from: string;
  subject: (invoiceNumber: string) => string;
  body: string;
}

function fixtureExtraction(name: FixtureName): ExtractedInvoice {
  return extractedInvoiceSchema.parse(
    JSON.parse(readFileSync(resolve(FIXTURES, 'expected', `${name}.json`), 'utf8')),
  );
}

const FIXTURE_DATA: Record<FixtureName, ExtractedInvoice> = {
  asm: fixtureExtraction('asm'),
  petrocas: fixtureExtraction('petrocas'),
  aeg: fixtureExtraction('aeg'),
};

// Fictional addresses (.example) and accounts; the three sample vendors use their invoices' bank details.
const VENDORS: Record<VendorKey, VendorSeed> = {
  asm: {
    name: 'Aviation Services Management',
    aliases: ['ASM Aviation Services'],
    emailDomains: ['asm-aviation.example'],
    defaultPaymentTermsDays: null,
    bank: FIXTURE_DATA.asm.bankDetails,
    trusted: true,
    from: 'ASM Aviation Services <accounts@asm-aviation.example>',
    subject: (number) => `Invoice ${number}`,
    body: 'Dear Camex team,\n\nPlease find attached our invoice.\n\nKind regards,\nASM Aviation Services Accounts',
  },
  aeg: {
    name: 'AEG Fuels',
    aliases: ['AEG Fuels Ireland Limited', 'Associated Energy Group'],
    emailDomains: ['aegfuels.example'],
    defaultPaymentTermsDays: 7,
    bank: FIXTURE_DATA.aeg.bankDetails,
    trusted: true,
    from: 'AEG Fuels <ar@aegfuels.example>',
    subject: (number) => `AEG Fuels Invoice ${number}`,
    body: 'Please see the attached invoice.\n\nNote: our bank details never change by email.\n\nAEG Fuels Accounts Receivable',
  },
  petrocas: {
    name: 'Petrocas Fuel Services Georgia',
    aliases: ['Petrocas'],
    emailDomains: ['petrocas-fuel.example'],
    defaultPaymentTermsDays: null,
    bank: FIXTURE_DATA.petrocas.bankDetails,
    trusted: false,
    from: '"Petrocas Fuel Services Georgia" <billing@petrocas-fuel.example>',
    subject: (number) => `Invoice ${number}`,
    body: 'Hello,\n\nAttached is the fuel invoice for Camex Airlines.\n\nBest regards,\nPetrocas Fuel Services Georgia',
  },
  skyway: {
    name: 'Skyway Ground Handling',
    aliases: ['შპს სქაივეი გრაუნდ ჰენდლინგი'],
    emailDomains: ['skyway-handling.example'],
    defaultPaymentTermsDays: 30,
    bank: {
      beneficiary: 'SKYWAY GROUND HANDLING LLC',
      bankName: 'Bank of Georgia',
      iban: 'GE29BG0000000101465987',
      accountNumber: null,
      swift: 'BAGAGE22',
      routingNumber: null,
      currency: 'GEL',
    },
    trusted: true,
    from: 'Skyway Ground Handling <finance@skyway-handling.example>',
    subject: (number) => `Ground handling invoice ${number}`,
    body: 'Dear colleagues,\n\nPlease find attached the handling invoice for last month’s turnarounds at TBS.\n\nSkyway Ground Handling, Finance',
  },
  cas: {
    name: 'Caucasus Airport Services',
    aliases: [],
    emailDomains: ['caucasus-airports.example'],
    defaultPaymentTermsDays: 15,
    bank: null,
    trusted: false,
    from: 'Caucasus Airport Services <billing@caucasus-airports.example>',
    subject: (number) => `Airport charges ${number}`,
    body: 'Airport charges for Camex Airlines are attached. Payment within 15 days, please.\n\nBilling department',
  },
  anco: {
    name: 'Air Navigation Charges Office',
    aliases: ['ANCO'],
    emailDomains: ['anco-charges.example'],
    defaultPaymentTermsDays: 30,
    bank: null,
    trusted: false,
    from: 'ANCO Billing <no-reply@anco-charges.example>',
    subject: (number) => `Route charges invoice ${number}`,
    body: 'This is an automated message. Your route and terminal charges invoice is attached.\n\nDo not reply to this address.',
  },
  skychef: {
    name: 'SkyChef Catering',
    aliases: ['SkyChef Catering Tbilisi LLC'],
    emailDomains: ['skychef-catering.example'],
    defaultPaymentTermsDays: 14,
    bank: null,
    trusted: false,
    from: 'SkyChef Catering <accounts@skychef-catering.example>',
    subject: (number) => `Catering invoice ${number}`,
    body: 'Hello,\n\nAttached please find our catering invoice.\n\nThank you,\nSkyChef Catering Accounts',
  },
  aerotech: {
    name: 'AeroTech MRO',
    aliases: ['AeroTech Engineering & MRO'],
    emailDomains: ['aerotech-mro.example'],
    defaultPaymentTermsDays: 30,
    bank: {
      beneficiary: 'AEROTECH MRO LTD',
      bankName: 'Example Bank AB',
      iban: 'LT121000011101001000',
      accountNumber: null,
      swift: 'EXLTLT2X',
      routingNumber: null,
      currency: 'USD',
    },
    trusted: true,
    from: 'AeroTech MRO <invoicing@aerotech-mro.example>',
    subject: (number) => `Invoice ${number} – Camex Airlines`,
    body: 'Dear customer,\n\nThe invoice for the completed work package is attached.\n\nAeroTech MRO Invoicing',
  },
};

// ─── Invoices ─────────────────────────────────────────────────────────────────

type Outcome =
  | { status: 'needs_review' }
  | { status: 'unpaid' }
  | { status: 'paid'; paidAt: string; reference: string }
  | { status: 'rejected'; reason: RejectionReason; note: string };

interface EmailSeed {
  from: string;
  subject: string;
  body: string;
}

/** One invoice to create, fully resolved for today. */
interface PlannedInvoice {
  /** The vendor it should match (null: none on file). */
  vendor: VendorKey | null;
  pdf: FixtureName;
  fileName: string;
  /** Null: the extraction failed. */
  extracted: ExtractedInvoice | null;
  /** Null: a manual upload. */
  email: EmailSeed | null;
  receivedAt: Date;
  outcome: Outcome;
  /** The same PDF file (same bytes) as the planned invoice with this file name. */
  sameFileAs?: string;
}

/** A line: `quantity × price` when a quantity is given, else a fee of `price`. */
interface LineSeed {
  text: string;
  quantity?: string;
  uom?: string;
  price: string;
}

type DateSeed = { daysAgo: number } | { monthsAgo: number; day: number };

interface GeneratedSeed {
  vendor: VendorKey | null;
  vendorName: string;
  number: string;
  date: DateSeed;
  category: InvoiceCategory;
  description: string;
  currency: 'USD' | 'GEL';
  lines: LineSeed[];
  /** [ICAO, IATA, location as printed] */
  airport: [string, string, string];
  registration?: string;
  flights?: string[];
  /** Printed payment terms (null: none, the vendor's default applies). */
  termsDays: number | null;
  /** The due date is printed (else derived from the terms). */
  printedDue: boolean;
  disputeWindowDays?: number;
  documentType?: ExtractedInvoice['documentType'];
  outcome:
    | { status: 'needs_review' | 'unpaid' }
    | { status: 'paid'; paid: { afterDays: number } | { daysAgo: number } }
    | { status: 'rejected'; reason: RejectionReason; note: string };
  pdf: FixtureName;
  manual?: boolean;
  /** Sender other than the vendor's usual one. */
  email?: EmailSeed;
  /** Bank details printed on this invoice (default: its vendor's). */
  bank?: BankDetails;
}

const OTP: GeneratedSeed['airport'] = ['LROP', 'OTP', 'LROP - Bucharest, RO'];
const BUD: GeneratedSeed['airport'] = ['LHBP', 'BUD', 'LHBP/BUD Ferihegy'];
const TBS: GeneratedSeed['airport'] = ['UGTB', 'TBS', 'Tbilisi International Airport'];
const KUT: GeneratedSeed['airport'] = ['UGKO', 'KUT', 'Kutaisi International Airport'];

const aegFuel = (usg: string, price: string, throughput: string): LineSeed[] => [
  { text: `Jet A-1, ${usg} USG`, quantity: usg, uom: 'USG', price },
  { text: 'Into-plane fee', price: '185.00' },
  { text: 'Airport fuel throughput fee', price: throughput },
];

const asmFuel = (tonnes: string, price: string, fee: string): LineSeed[] => [
  { text: 'Jet A-1 uplift', quantity: tonnes, uom: 'MT', price },
  { text: 'Into-plane service', price: '410.00' },
  { text: 'Airport fuel fee', price: fee },
];

const routeCharges = (route: string, terminal: string): LineSeed[] => [
  { text: 'Route charges', price: route },
  { text: 'Terminal navigation charges', price: terminal },
];

const handling = (turns: string, price: string, extra: string, extraPrice: string): LineSeed[] => [
  { text: 'Turnaround handling A320', quantity: turns, uom: 'turn', price },
  { text: extra, price: extraPrice },
];

const landing = (landings: string, price: string, passengers: string): LineSeed[] => [
  { text: 'Landing charges', quantity: landings, uom: 'landing', price },
  { text: 'Passenger service charge', price: passengers },
];

const catering = (trays: string, boxes: string): LineSeed[] => [
  { text: 'Crew meals', quantity: trays, uom: 'tray', price: '18.50' },
  { text: 'Passenger snack boxes', quantity: boxes, uom: 'box', price: '6.45' },
];

/** About two invoices a month over the last 12 months; the recent ones still open. */
const GENERATED: GeneratedSeed[] = [
  // AEG Fuels: fuel at OTP, NET7, 10-day dispute window.
  ...(
    [
      ['3098412', { monthsAgo: 11, day: 8 }, aegFuel('5742', '0.9876', '56.60'), 9],
      ['3104950', { monthsAgo: 6, day: 20 }, aegFuel('6120', '0.9512', '61.20'), 12],
      ['3107302', { monthsAgo: 3, day: 17 }, aegFuel('5488', '0.9634', '54.88'), 8],
      ['3112264', { daysAgo: 3 }, aegFuel('6034', '0.9721', '60.34'), null],
    ] as const
  ).map(([number, date, lines, paidAfter]): GeneratedSeed => ({
    vendor: 'aeg',
    vendorName: 'AEG Fuels Ireland Limited',
    number,
    date,
    category: 'fuel',
    description: 'Jet fuel uplift, OTP, 4L-CMX, CMS624',
    currency: 'USD',
    lines,
    airport: OTP,
    registration: '4L-CMX',
    flights: ['CMS624'],
    termsDays: 7,
    printedDue: true,
    disputeWindowDays: 10,
    outcome:
      paidAfter === null
        ? { status: 'unpaid' }
        : { status: 'paid', paid: { afterDays: paidAfter } },
    pdf: 'aeg',
  })),
  // ASM: fuel at BUD, due on receipt, 14-day dispute window.
  ...(
    [
      ['SI-000201344', { monthsAgo: 10, day: 22 }, asmFuel('14.120', '958.40', '265.72'), 5],
      ['SI-000207815', { monthsAgo: 7, day: 5 }, asmFuel('12.870', '962.15', '147.19'), 3],
      ['SI-000213090', { monthsAgo: 4, day: 26 }, asmFuel('15.940', '975.30', '146.19'), 9],
      ['SI-000221402', { daysAgo: 2 }, asmFuel('13.660', '981.75', '180.12'), null],
    ] as const
  ).map(([number, date, lines, paidAfter]): GeneratedSeed => ({
    vendor: 'asm',
    vendorName: 'Aviation Services Management FZE',
    number,
    date,
    category: 'fuel',
    description: 'Jet fuel uplift, BUD, 4L-CME, CMS503/4',
    currency: 'USD',
    lines,
    airport: BUD,
    registration: '4L-CME',
    flights: ['CMS503', 'CMS504'],
    termsDays: 0,
    printedDue: true,
    disputeWindowDays: 14,
    outcome:
      paidAfter === null
        ? { status: 'unpaid' }
        : { status: 'paid', paid: { afterDays: paidAfter } },
    pdf: 'asm',
  })),
  // ANCO: monthly route charges, 30 days from the terms (no printed due date).
  ...(
    [
      [
        'RC-0041387',
        { monthsAgo: 5, day: 4 },
        routeCharges('2911.40', '287.15'),
        { afterDays: 29 },
      ],
      [
        'RC-0042795',
        { monthsAgo: 2, day: 2 },
        routeCharges('3312.70', '342.40'),
        { afterDays: 25 },
      ],
      ['RC-0043516', { daysAgo: 31 }, routeCharges('3214.12', '326.50'), { daysAgo: 1 }],
    ] as const
  ).map(([number, date, lines, paid]): GeneratedSeed => ({
    vendor: 'anco',
    vendorName: 'Air Navigation Charges Office',
    number,
    date,
    category: 'navigation',
    description: 'Route and terminal navigation charges',
    currency: 'USD',
    lines,
    airport: TBS,
    termsDays: 30,
    printedDue: false,
    outcome: { status: 'paid', paid },
    pdf: 'aeg',
  })),
  // AeroTech MRO: maintenance at TBS, net 30.
  {
    vendor: 'aerotech',
    vendorName: 'AeroTech MRO Ltd',
    number: 'MRO-24-0871',
    date: { monthsAgo: 9, day: 25 },
    category: 'maintenance',
    description: 'A-check, 4L-CME',
    currency: 'USD',
    lines: [
      { text: 'A-check labour', quantity: '96', uom: 'h', price: '78.50' },
      { text: 'Parts and consumables', price: '10214.00' },
      { text: 'Hangar slot', price: '1000.00' },
    ],
    airport: TBS,
    registration: '4L-CME',
    termsDays: 30,
    printedDue: true,
    outcome: { status: 'paid', paid: { afterDays: 30 } },
    pdf: 'asm',
    manual: true,
  },
  {
    vendor: 'aerotech',
    vendorName: 'AeroTech MRO Ltd',
    number: 'MRO-24-0954',
    date: { daysAgo: 18 },
    category: 'maintenance',
    description: 'Main wheel and brake change, 4L-CMX',
    currency: 'USD',
    lines: [
      { text: 'Wheel and brake change labour', quantity: '14', uom: 'h', price: '78.50' },
      { text: 'Main wheel assembly (exchange)', quantity: '2', uom: 'EA', price: '2875.00' },
      { text: 'Shipping', price: '312.40' },
    ],
    airport: TBS,
    registration: '4L-CMX',
    termsDays: 30,
    printedDue: true,
    outcome: { status: 'unpaid' },
    pdf: 'asm',
  },
  // Skyway: ground handling at TBS in GEL; no terms printed, the vendor's 30 days apply.
  ...(
    [
      [
        'GH-1187',
        { monthsAgo: 11, day: 28 },
        handling('22', '198.00', 'De-icing standby', '456.60'),
        28,
      ],
      [
        'GH-1244',
        { monthsAgo: 5, day: 29 },
        handling('23', '198.00', 'GPU and air start', '413.80'),
        30,
      ],
      ['GH-1301', { monthsAgo: 2, day: 28 }, handling('24', '205.00', 'Pushback', '320.15'), 27],
      ['GH-1329', { daysAgo: 27 }, handling('22', '205.00', 'GPU', '386.40'), null],
    ] as const
  ).map(([number, date, lines, paidAfter]): GeneratedSeed => ({
    vendor: 'skyway',
    vendorName: 'Skyway Ground Handling LLC',
    number,
    date,
    category: 'ground_handling',
    description: 'Ground handling, TBS, monthly turnarounds',
    currency: 'GEL',
    lines,
    airport: TBS,
    termsDays: null,
    printedDue: false,
    outcome:
      paidAfter === null
        ? { status: 'unpaid' }
        : { status: 'paid', paid: { afterDays: paidAfter } },
    pdf: 'petrocas',
  })),
  // Caucasus Airport Services: landing and passenger charges in GEL, net 15.
  ...(
    [
      ['CAS-118342', { monthsAgo: 10, day: 5 }, landing('31', '52.80', '681.60'), 14],
      ['CAS-121907', { monthsAgo: 3, day: 4 }, landing('33', '52.80', '665.35'), 13],
      ['CAS-123561', { daysAgo: 20 }, landing('30', '54.10', '702.85'), null],
    ] as const
  ).map(([number, date, lines, paidAfter], index): GeneratedSeed => ({
    vendor: 'cas',
    vendorName: 'Caucasus Airport Services',
    number,
    date,
    category: 'airport_charges',
    description: 'Landing and passenger service charges, TBS',
    currency: 'GEL',
    lines,
    airport: TBS,
    termsDays: 15,
    printedDue: true,
    outcome:
      paidAfter === null
        ? { status: 'unpaid' }
        : { status: 'paid', paid: { afterDays: paidAfter } },
    pdf: 'petrocas',
    manual: index === 1,
  })),
  // SkyChef: catering in GEL, net 14, 14-day dispute window.
  {
    vendor: 'skychef',
    vendorName: 'SkyChef Catering Tbilisi LLC',
    number: 'SCT-5521',
    date: { monthsAgo: 1, day: 14 },
    category: 'catering',
    description: 'Crew meals and snack boxes, TBS',
    currency: 'GEL',
    lines: catering('64', '210'),
    airport: TBS,
    termsDays: 14,
    printedDue: true,
    disputeWindowDays: 14,
    outcome: { status: 'paid', paid: { daysAgo: 3 } },
    pdf: 'petrocas',
  },
  {
    vendor: 'skychef',
    vendorName: 'SkyChef Catering Tbilisi LLC',
    number: 'SCT-5588',
    date: { daysAgo: 12 },
    category: 'catering',
    description: 'Crew meals and snack boxes, TBS',
    currency: 'GEL',
    lines: catering('58', '190'),
    airport: TBS,
    termsDays: 14,
    printedDue: true,
    // Dispute window closes in two days: DISPUTE_SOON.
    disputeWindowDays: 14,
    outcome: { status: 'needs_review' },
    pdf: 'petrocas',
  },
  // A vendor not on file: NEW_VENDOR.
  {
    vendor: null,
    vendorName: 'Kolkhi Aviation Services LLC',
    number: 'KAS-0193',
    date: { daysAgo: 3 },
    category: 'ground_handling',
    description: 'Charter turnaround handling, KUT',
    currency: 'GEL',
    lines: [{ text: 'Charter turnaround handling', quantity: '2', uom: 'turn', price: '390.00' }],
    airport: KUT,
    registration: '4L-CMX',
    flights: ['CMS9011'],
    termsDays: 30,
    printedDue: true,
    outcome: { status: 'needs_review' },
    pdf: 'aeg',
    // Approving it (T06) creates the vendor and can trust these: BANK_FIRST_SEEN once linked.
    bank: {
      beneficiary: 'KOLKHI AVIATION SERVICES LLC',
      bankName: 'TBC Bank',
      iban: 'GE47TB0000000367812945',
      accountNumber: null,
      swift: 'TBCBGE22',
      routingNumber: null,
      currency: 'GEL',
    },
    email: {
      from: 'Kolkhi Aviation Services <accounts@kolkhi-aviation.example>',
      subject: 'Invoice KAS-0193 for your charter flight',
      body: 'Good day,\n\nPlease find attached our invoice for handling your charter at Kutaisi.\n\nKolkhi Aviation Services',
    },
  },
  // A statement of account, rejected as not an invoice.
  {
    vendor: 'skyway',
    vendorName: 'Skyway Ground Handling LLC',
    number: 'SOA-0907',
    date: { daysAgo: 9 },
    category: 'ground_handling',
    description: 'Statement of account',
    currency: 'GEL',
    lines: [{ text: 'Open items as of the statement date', price: '4896.40' }],
    airport: TBS,
    termsDays: null,
    printedDue: false,
    documentType: 'statement',
    outcome: {
      status: 'rejected',
      reason: 'not_invoice',
      note: 'Statement of account, not an invoice: GH-1329 is already in To pay.',
    },
    pdf: 'petrocas',
  },
];

function lineItem(line: LineSeed): ExtractedLineItem {
  if (line.quantity === undefined) {
    return {
      kind: 'fee',
      description: line.text,
      quantity: null,
      uom: null,
      unitPrice: null,
      amount: line.price,
    };
  }
  const amount = new Prisma.Decimal(line.quantity)
    .times(line.price)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return {
    kind: 'item',
    description: line.text,
    quantity: line.quantity,
    uom: line.uom ?? null,
    unitPrice: line.price,
    amount: amount.toFixed(2),
  };
}

function termsText(days: number | null): string | null {
  if (days === null) return null;
  return days === 0 ? 'Due on receipt' : `Net ${String(days)} days`;
}

/** What the model would have extracted from a generated invoice. */
function generatedExtraction(seed: GeneratedSeed, invoiceDate: string): ExtractedInvoice {
  const lineItems = seed.lines.map(lineItem);
  const total = lineItems
    .reduce((sum, line) => sum.plus(line.amount ?? '0'), new Prisma.Decimal(0))
    .toFixed(2);
  const [airportIcao, airportIata, locationText] = seed.airport;
  return {
    documentType: seed.documentType ?? 'invoice',
    vendorName: seed.vendorName,
    vendorTaxId: null,
    billToName: BILL_TO,
    invoiceNumber: seed.number,
    invoiceDate,
    serviceDate: addDays(invoiceDate, -1),
    dueDate:
      seed.printedDue && seed.termsDays !== null ? addDays(invoiceDate, seed.termsDays) : null,
    paymentTermsText: termsText(seed.termsDays),
    paymentTermsDays: seed.termsDays,
    disputeWindowDays: seed.disputeWindowDays ?? null,
    category: seed.category,
    description: seed.description,
    airportIcao,
    airportIata,
    locationText,
    aircraftRegistration: seed.registration ?? null,
    flightNumbers: seed.flights ?? [],
    currency: seed.currency,
    subtotalAmount: total,
    taxAmount: '0',
    totalAmount: total,
    amountDue: total,
    amountDueCurrency: seed.currency,
    lineItems,
    bankDetails: seed.bank ?? (seed.vendor === null ? null : VENDORS[seed.vendor].bank),
    notes: null,
  };
}

function paymentReference(paidAt: string, index: number): string {
  return `TT${paidAt.replaceAll('-', '')}-${pad(index, 3)}`;
}

/** A payment date on or after receipt and no later than today. */
function paymentDate(wanted: string, received: Date, today: string): string {
  const receivedDay = businessToday({ now: () => received });
  if (wanted < receivedDay) return receivedDay;
  return wanted > today ? today : wanted;
}

function plan(today: string, now: Date): PlannedInvoice[] {
  /** During office hours (Tbilisi), never in the future. */
  const received = (date: string, minutesAfterNine: number) =>
    earliest(tbilisi(date, minutesAfterNine), minutes(now, -5));

  // The sample invoices keep their printed dates: ASM is overdue, AEG was paid 18 days after its
  // 14 Sep invoice date, Petrocas has no due date (MISSING_REQUIRED) and waits for review.
  const aegReceived = received('2026-09-15', 20);
  const aegPaid = paymentDate(addDays('2026-09-14', 18), aegReceived, today);
  const fixtures: PlannedInvoice[] = [
    {
      vendor: 'asm',
      pdf: 'asm',
      fileName: 'SI-000218719.pdf',
      extracted: FIXTURE_DATA.asm,
      email: emailOf('asm', 'SI-000218719'),
      receivedAt: received('2026-09-16', 75),
      outcome: { status: 'unpaid' },
    },
    {
      vendor: 'aeg',
      pdf: 'aeg',
      fileName: 'Invoice_3110713.pdf',
      extracted: FIXTURE_DATA.aeg,
      email: emailOf('aeg', '3110713'),
      receivedAt: aegReceived,
      outcome: { status: 'paid', paidAt: aegPaid, reference: paymentReference(aegPaid, 0) },
    },
    // ASM sends the unpaid invoice again as a reminder: the same file, so DUPLICATE_FILE and
    // DUPLICATE_NUMBER on both copies until the reminder is rejected as a duplicate (T06).
    {
      vendor: 'asm',
      pdf: 'asm',
      fileName: 'SI-000218719.pdf',
      extracted: FIXTURE_DATA.asm,
      email: {
        from: VENDORS.asm.from,
        subject: 'Reminder: invoice SI-000218719 is overdue',
        body: 'Dear customer,\n\nOur records show invoice SI-000218719 as unpaid. A copy is attached for your convenience.\n\nASM Accounts Receivable',
      },
      receivedAt: received(addDays(today, -2), 100),
      outcome: { status: 'needs_review' },
      sameFileAs: 'SI-000218719.pdf',
    },
    {
      vendor: 'petrocas',
      pdf: 'petrocas',
      fileName: 'PFSG-CAM-00000000510.pdf',
      extracted: FIXTURE_DATA.petrocas,
      email: emailOf('petrocas', 'PFSG-CAM-00000000510'),
      receivedAt: received('2026-10-02', 190),
      outcome: { status: 'needs_review' },
    },
  ];

  const generated = GENERATED.map((seed, i): PlannedInvoice => {
    const index = i + 1;
    const invoiceDate =
      'daysAgo' in seed.date
        ? addDays(today, -seed.date.daysAgo)
        : monthDay(today, seed.date.monthsAgo, seed.date.day);
    // The invoice day or the next.
    const receivedAt = received(addDays(invoiceDate, index % 2), (index * 37) % 420);
    let outcome: Outcome;
    if (seed.outcome.status === 'paid') {
      const { paid } = seed.outcome;
      const wanted =
        'afterDays' in paid ? addDays(invoiceDate, paid.afterDays) : addDays(today, -paid.daysAgo);
      const paidAt = paymentDate(wanted, receivedAt, today);
      outcome = { status: 'paid', paidAt, reference: paymentReference(paidAt, index) };
    } else {
      outcome = seed.outcome;
    }
    return {
      vendor: seed.vendor,
      pdf: seed.pdf,
      fileName: `${seed.number}.pdf`,
      extracted: generatedExtraction(seed, invoiceDate),
      email: seed.manual
        ? null
        : (seed.email ?? (seed.vendor === null ? null : emailOf(seed.vendor, seed.number))),
      receivedAt,
      outcome,
    };
  });

  // The extraction failed on this one; its sender's domain still links SkyChef.
  const failed: PlannedInvoice = {
    vendor: 'skychef',
    pdf: 'asm',
    fileName: 'scan_0412.pdf',
    extracted: null,
    email: {
      from: VENDORS.skychef.from,
      subject: 'Invoice (scanned copy)',
      body: 'Hello,\n\nSending the scanned copy of our latest invoice as requested.\n\nSkyChef Catering Accounts',
    },
    receivedAt: received(addDays(today, -1), 300),
    outcome: { status: 'needs_review' },
  };

  return [...fixtures, ...generated, failed].sort(
    (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
  );
}

function emailOf(vendor: VendorKey, invoiceNumber: string): EmailSeed {
  const { from, subject, body } = VENDORS[vendor];
  return { from, subject: subject(invoiceNumber), body };
}

/** An extraction output as the model returns it: "" for null, strings for numbers. */
function toWire(invoice: ExtractedInvoice): ExtractionOutputV1 {
  const s = (value: string | number | null) => (value === null ? '' : String(value));
  const bank = invoice.bankDetails;
  return {
    documentType: invoice.documentType,
    vendorName: s(invoice.vendorName),
    vendorTaxId: s(invoice.vendorTaxId),
    billToName: s(invoice.billToName),
    invoiceNumber: s(invoice.invoiceNumber),
    invoiceDate: s(invoice.invoiceDate),
    serviceDate: s(invoice.serviceDate),
    dueDate: s(invoice.dueDate),
    paymentTermsText: s(invoice.paymentTermsText),
    paymentTermsDays: s(invoice.paymentTermsDays),
    disputeWindowDays: s(invoice.disputeWindowDays),
    category: invoice.category,
    description: s(invoice.description),
    airportIcao: s(invoice.airportIcao),
    airportIata: s(invoice.airportIata),
    locationText: s(invoice.locationText),
    aircraftRegistration: s(invoice.aircraftRegistration),
    flightNumbers: [...invoice.flightNumbers],
    currency: s(invoice.currency),
    subtotalAmount: s(invoice.subtotalAmount),
    taxAmount: s(invoice.taxAmount),
    totalAmount: s(invoice.totalAmount),
    amountDue: s(invoice.amountDue),
    amountDueCurrency: s(invoice.amountDueCurrency),
    lineItems: invoice.lineItems.map((line) => ({
      kind: line.kind,
      description: s(line.description),
      quantity: s(line.quantity),
      uom: s(line.uom),
      unitPrice: s(line.unitPrice),
      amount: s(line.amount),
    })),
    bankDetails: {
      beneficiary: s(bank?.beneficiary ?? null),
      bankName: s(bank?.bankName ?? null),
      iban: s(bank?.iban ?? null),
      accountNumber: s(bank?.accountNumber ?? null),
      swift: s(bank?.swift ?? null),
      routingNumber: s(bank?.routingNumber ?? null),
      currency: s(bank?.currency ?? null),
    },
    notes: s(invoice.notes),
  };
}

// ─── Writing ──────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

interface StoredPdf {
  invoiceId: string;
  key: string;
  sha256: string;
  size: number;
  pageCount: number | null;
}

/** Creates the email and the invoice as ingestion and extraction would, then evaluates it. */
async function insertInvoice(
  tx: Tx,
  evaluator: InvoiceEvaluator,
  env: Env,
  today: string,
  invoice: PlannedInvoice,
  pdf: StoredPdf,
  index: number,
  uploadedById: string | null,
): Promise<void> {
  const inboundEmailId = randomUUID();
  const { email, receivedAt } = invoice;
  const fromAddress = email === null ? null : parseEmailAddress(email.from);
  const domain = fromAddress?.split('@')[1] ?? 'mail.example';
  await tx.inboundEmail.create({
    data: {
      id: inboundEmailId,
      provider: email === null ? 'manual' : 'mailgun',
      messageId:
        email === null ? null : `<demo-${pad(index, 3)}.${pdf.sha256.slice(0, 12)}@${domain}>`,
      fromAddress,
      sender: fromAddress,
      recipient: email === null ? null : RECIPIENT,
      subject: email?.subject ?? null,
      bodyText: email?.body ?? null,
      headers:
        email === null
          ? undefined
          : [
              ['Received', `from mail.${domain} by mxa.mailgun.org with ESMTP`],
              ['From', email.from],
              ['To', RECIPIENT],
              ['Subject', email.subject],
              ['Date', receivedAt.toUTCString()],
              ['Mime-Version', '1.0'],
            ],
      attachments: [
        {
          filename: invoice.fileName,
          content_type: 'application/pdf',
          size: pdf.size,
          processed: true,
        },
      ],
      receivedAt,
      uploadedById: email === null ? uploadedById : null,
      createdAt: receivedAt,
    },
  });
  await tx.invoice.create({
    data: {
      id: pdf.invoiceId,
      inboundEmailId,
      fileKey: pdf.key,
      fileName: invoice.fileName,
      fileSha256: pdf.sha256,
      fileSize: pdf.size,
      pageCount: pdf.pageCount,
      status: 'processing',
      extractionStatus: 'pending',
      createdAt: receivedAt,
    },
  });
  await tx.invoiceEvent.create({
    data: {
      invoiceId: pdf.invoiceId,
      type: 'received',
      data: { source: email === null ? 'manual' : 'mailgun', inboundEmailId },
      createdAt: receivedAt,
    },
  });

  const extractedAt = minutes(receivedAt, 1);
  if (invoice.extracted === null) {
    const error = 'Request timed out.';
    await tx.invoice.update({
      where: { id: pdf.invoiceId },
      data: { extractionStatus: 'failed', extractionError: error, status: 'needs_review' },
    });
    await tx.invoiceEvent.create({
      data: {
        invoiceId: pdf.invoiceId,
        type: 'extraction_failed',
        data: { error, attempts: 3 },
        createdAt: minutes(receivedAt, 4),
      },
    });
  } else {
    const wire = toWire(invoice.extracted);
    await tx.invoice.update({
      where: { id: pdf.invoiceId },
      data: {
        ...extractedInvoiceColumns(normalizeExtraction(wire)),
        extractionRaw: toJsonColumn(wire),
        extractionModel: env.EXTRACTION_MODEL,
        extractionPromptVersion: PROMPT_VERSION,
        extractedAt,
        extractionStatus: 'succeeded',
        extractionError: null,
        status: 'needs_review',
      },
    });
    await tx.invoiceEvent.create({
      data: {
        invoiceId: pdf.invoiceId,
        type: 'extracted',
        data: {
          model: env.EXTRACTION_MODEL,
          promptVersion: PROMPT_VERSION,
          inputTokens: 3800 + index * 41,
          outputTokens: 900 + index * 13,
          durationMs: 21_000 + index * 517,
        },
        createdAt: extractedAt,
      },
    });
  }
  await evaluator.evaluate(tx, pdf.invoiceId, today);
}

/** Approval, payment or rejection, by the first user when there is one. */
async function finish(
  tx: Tx,
  invoice: PlannedInvoice,
  invoiceId: string,
  userId: string | null,
  now: Date,
): Promise<void> {
  const { outcome } = invoice;
  if (outcome.status === 'needs_review') return;
  const decidedAt = earliest(minutes(invoice.receivedAt, 240), minutes(now, -1));
  const data: Prisma.InvoiceUncheckedUpdateInput =
    outcome.status === 'rejected'
      ? {
          status: 'rejected',
          rejectedAt: decidedAt,
          rejectedById: userId,
          rejectionReason: outcome.reason,
          rejectionNote: outcome.note,
        }
      : {
          status: outcome.status,
          approvedAt: decidedAt,
          approvedById: userId,
          ...(outcome.status === 'paid'
            ? {
                paidAt: toDateColumn(outcome.paidAt),
                paidById: userId,
                paymentReference: outcome.reference,
              }
            : {}),
        };
  await tx.invoice.update({ where: { id: invoiceId }, data });
}

async function seed(env: Env): Promise<void> {
  const prisma = new PrismaService(env);
  const storage = new StorageService(env);
  const evaluator = new InvoiceEvaluator(prisma, env, systemClock);
  try {
    const [invoiceCount, vendorCount] = await Promise.all([
      prisma.invoice.count(),
      prisma.vendor.count(),
    ]);
    if (invoiceCount > 0 || vendorCount > 0) {
      throw new SeedRefused(
        `The database already has ${String(invoiceCount)} invoice(s) and ${String(vendorCount)} vendor(s). ` +
          'seed:demo only fills an empty database and never deletes data.',
      );
    }

    const now = new Date();
    const today = businessToday();
    const invoices = plan(today, now);
    const user = await prisma.user.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const userId = user?.id ?? null;

    // Files first, like ingestion: a failed run leaves orphan files at worst, never rows without files.
    const pdfs: StoredPdf[] = [];
    const bytesByFile = new Map<string, Buffer>();
    for (const [index, invoice] of invoices.entries()) {
      const invoiceId = randomUUID();
      const copied =
        invoice.sameFileAs === undefined ? undefined : bytesByFile.get(invoice.sameFileAs);
      if (invoice.sameFileAs !== undefined && copied === undefined) {
        throw new Error(`${invoice.fileName}: the file it copies must come first`);
      }
      const bytes =
        copied ??
        Buffer.concat([
          readFileSync(resolve(FIXTURES, `${invoice.pdf}.pdf`)),
          Buffer.from(`\n% camex demo seed ${String(index)} ${invoiceId}\n`),
        ]);
      if (!bytesByFile.has(invoice.fileName)) bytesByFile.set(invoice.fileName, bytes);
      const key = invoicePdfKey(invoiceId, invoice.receivedAt);
      await storage.put(key, bytes, 'application/pdf');
      pdfs.push({
        invoiceId,
        key,
        sha256: sha256Hex(bytes),
        size: bytes.length,
        pageCount: await countPdfPages(bytes),
      });
    }

    // One transaction: the dataset is complete or absent.
    const counts = await prisma.$transaction(
      async (tx) => {
        const vendorIds = new Map<VendorKey, string>();
        for (const [key, vendor] of Object.entries(VENDORS) as [VendorKey, VendorSeed][]) {
          const row = await tx.vendor.create({
            data: {
              name: vendor.name,
              aliases: vendor.aliases,
              emailDomains: vendor.emailDomains,
              defaultPaymentTermsDays: vendor.defaultPaymentTermsDays,
            },
          });
          vendorIds.set(key, row.id);
        }

        for (const [index, invoice] of invoices.entries()) {
          const pdf = pdfs[index];
          if (pdf === undefined) throw new Error('missing stored PDF');
          await insertInvoice(tx, evaluator, env, today, invoice, pdf, index, userId);
          const linked = await tx.invoice.findUniqueOrThrow({
            where: { id: pdf.invoiceId },
            select: { vendorId: true },
          });
          const expected = invoice.vendor === null ? null : (vendorIds.get(invoice.vendor) ?? null);
          if (linked.vendorId !== expected) {
            throw new Error(`${invoice.fileName}: vendor matching linked an unexpected vendor`);
          }
        }

        // Trusted on approval of each vendor's first invoice that carries bank details.
        for (const [key, vendor] of Object.entries(VENDORS) as [VendorKey, VendorSeed][]) {
          if (!vendor.trusted || vendor.bank === null) continue;
          const index = invoices.findIndex((i) => i.vendor === key && i.extracted !== null);
          const source = invoices[index];
          const invoiceId = pdfs[index]?.invoiceId;
          const vendorId = vendorIds.get(key);
          if (source === undefined || invoiceId === undefined || vendorId === undefined) continue;
          const at = earliest(minutes(source.receivedAt, 235), minutes(now, -2));
          const account = trustedAccountFrom(vendor.bank, { invoiceId, userId, at });
          await tx.vendor.update({
            where: { id: vendorId },
            data: { bankAccounts: bankAccountsToJson([account]) },
          });
          await tx.invoiceEvent.create({
            data: {
              invoiceId,
              userId,
              type: 'bank_account_trusted',
              data: { vendorId, accountId: account.id },
              createdAt: at,
            },
          });
        }

        const byStatus: Partial<Record<InvoiceStatus, number>> = {};
        for (const [index, invoice] of invoices.entries()) {
          const invoiceId = pdfs[index]?.invoiceId;
          if (invoiceId === undefined) continue;
          await finish(tx, invoice, invoiceId, userId, now);
          byStatus[invoice.outcome.status] = (byStatus[invoice.outcome.status] ?? 0) + 1;
        }
        // Flags for the final state, as the daily re-evaluation would leave them.
        for (const pdf of pdfs) await evaluator.evaluate(tx, pdf.invoiceId, today);
        return byStatus;
      },
      { timeout: 120_000 },
    );

    const database = new URL(env.DATABASE_URL).pathname.slice(1);
    console.log(
      `Seeded database "${database}" and bucket "${env.S3_BUCKET}" for ${today} (Asia/Tbilisi):`,
    );
    console.log(
      `  ${String(Object.keys(VENDORS).length)} vendors, ${String(invoices.length)} invoices: ` +
        `${String(counts.needs_review ?? 0)} to review, ${String(counts.unpaid ?? 0)} to pay, ` +
        `${String(counts.paid ?? 0)} paid, ${String(counts.rejected ?? 0)} rejected`,
    );
  } finally {
    await prisma.$disconnect();
    storage.client.destroy();
  }
}

async function main(): Promise<void> {
  loadRootEnvFile();
  if (process.env.NODE_ENV === 'production') {
    throw new SeedRefused(
      'seed:demo is for development only: refusing to run with NODE_ENV=production.',
    );
  }
  // No job workers: nothing here enqueues work, and nothing must start extracting.
  await seed(parseEnv({ ...process.env, WORKERS_ENABLED: 'false' }));
}

main().catch((error: unknown) => {
  const known = error instanceof SeedRefused || error instanceof EnvValidationError;
  console.error(known ? error.message : error);
  process.exitCode = 1;
});
