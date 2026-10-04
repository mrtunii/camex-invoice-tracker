/**
 * Sends correctly signed Mailgun route-forward POSTs to the local API, using
 * MAILGUN_WEBHOOK_SIGNING_KEY and PORT from the root .env.
 *
 *   pnpm simulate:mailgun                                  # three emails, one per fixture
 *   pnpm simulate:mailgun --file a.pdf --file b.pdf        # one email with these attachments
 *   pnpm simulate:mailgun --message-id '<x@y>'             # run twice to see the duplicate reply
 *   pnpm simulate:mailgun --extra-attachment               # add a non-PDF (ignored by ingestion)
 *   pnpm simulate:mailgun --bad-signature                  # expect 401
 *
 * Like Mailgun, it posts multipart/form-data when there are attachments and
 * x-www-form-urlencoded when there are none.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRootEnvFile } from '../config/env.js';

const RECIPIENT = 'invoices@in.camex.aero';
const FIXTURES = resolve(import.meta.dirname, '../../../../fixtures/invoices');

interface SimulatedEmail {
  from: string;
  subject: string;
  body: string;
  files: string[];
}

/** Plausible senders for the three sample invoices (fictional addresses). */
const DEFAULT_EMAILS: SimulatedEmail[] = [
  {
    from: 'ASM Aviation Services <accounts@asm-aviation.example>',
    subject: 'Invoice SI-000218719',
    body: 'Dear Camex team,\n\nPlease find attached our invoice SI-000218719.\n\nKind regards,\nASM Aviation Services Accounts',
    files: [resolve(FIXTURES, 'asm.pdf')],
  },
  {
    from: '"Petrocas Fuel Services Georgia" <billing@petrocas-fuel.example>',
    subject: 'Invoice PFSG-CAM-00000000510',
    body: 'Hello,\n\nAttached is the fuel invoice for Camex Airlines.\n\nBest regards,\nPetrocas Fuel Services Georgia',
    files: [resolve(FIXTURES, 'petrocas.pdf')],
  },
  {
    from: 'AEG Fuels <ar@aegfuels.example>',
    subject: 'AEG Fuels Invoice 3110713',
    body: 'Please see the attached invoice.\n\nNote: our bank details never change by email.\n\nAEG Fuels Accounts Receivable',
    files: [resolve(FIXTURES, 'aeg.pdf')],
  },
];

const USAGE = `Usage: pnpm simulate:mailgun [--file <pdf>]... [--from <address>] [--subject <text>]
                             [--message-id <id>] [--extra-attachment] [--bad-signature]
Without --file, sends three emails (one per fixture in fixtures/invoices/).`;

function sign(signingKey: string): { timestamp: string; token: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = randomBytes(25).toString('hex'); // 50 characters, like Mailgun's
  const signature = createHmac('sha256', signingKey)
    .update(timestamp + token)
    .digest('hex');
  return { timestamp, token, signature };
}

async function send(
  url: string,
  signingKey: string,
  email: SimulatedEmail,
  options: { messageId: string; extraAttachment: boolean; badSignature: boolean },
): Promise<boolean> {
  const { timestamp, token, signature } = sign(signingKey);
  const date = new Date().toUTCString();
  const headers: [string, string][] = [
    ['Received', 'from mail.vendor.example by mxa.mailgun.org with ESMTP'],
    ['From', email.from],
    ['To', RECIPIENT],
    ['Subject', email.subject],
    ['Date', date],
    ['Message-Id', options.messageId],
    ['Mime-Version', '1.0'],
  ];
  const fields: Record<string, string> = {
    recipient: RECIPIENT,
    sender: /<([^>]+)>/.exec(email.from)?.[1] ?? email.from,
    from: email.from,
    subject: email.subject,
    'body-plain': email.body,
    'stripped-text': email.body,
    'message-headers': JSON.stringify(headers),
    'Message-Id': options.messageId,
    Date: date,
    timestamp,
    token,
    signature: options.badSignature
      ? signature.replace(/^./, (c) => (c === '0' ? '1' : '0'))
      : signature,
  };

  const attachments = await Promise.all(
    email.files.map(async (path) => ({
      name: basename(path),
      type: path.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      data: await readFile(path),
    })),
  );
  if (options.extraAttachment) {
    attachments.push({
      name: 'remittance-instructions.txt',
      type: 'text/plain',
      data: Buffer.from('Not a PDF: ingestion records this attachment as ignored.\n'),
    });
  }

  let body: FormData | URLSearchParams;
  if (attachments.length === 0) {
    body = new URLSearchParams(fields);
  } else {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('attachment-count', String(attachments.length));
    attachments.forEach((file, i) => {
      form.append(`attachment-${i + 1}`, new Blob([file.data], { type: file.type }), file.name);
    });
    body = form;
  }

  const res = await fetch(url, { method: 'POST', body });
  const text = await res.text();
  const files = attachments.map((a) => a.name).join(', ') || 'no attachments';
  console.log(`${res.status} ${email.subject} [${files}] → ${text}`);
  return res.ok;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string', multiple: true },
      from: { type: 'string' },
      subject: { type: 'string' },
      'message-id': { type: 'string' },
      'extra-attachment': { type: 'boolean', default: false },
      'bad-signature': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  loadRootEnvFile();
  const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!signingKey) throw new Error('MAILGUN_WEBHOOK_SIGNING_KEY is not set (see .env.example).');
  const url = `http://localhost:${process.env.PORT ?? '3180'}/api/inbound/mailgun`;

  // pnpm runs this from apps/api; resolve --file paths against where pnpm was invoked.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const emails: SimulatedEmail[] = values.file
    ? [
        {
          from: 'Vendor Accounts <accounts@vendor.example>',
          subject: 'Invoice',
          body: 'Please find our invoice attached.',
          files: values.file.map((path) => resolve(cwd, path)),
        },
      ]
    : DEFAULT_EMAILS;

  let ok = true;
  for (const email of emails) {
    ok =
      (await send(
        url,
        signingKey,
        {
          ...email,
          from: values.from ?? email.from,
          subject: values.subject ?? email.subject,
        },
        {
          // A fixed --message-id applies to every email sent in this run.
          messageId: values['message-id'] ?? `<sim-${randomUUID()}@simulate.camex.local>`,
          extraAttachment: values['extra-attachment'],
          badSignature: values['bad-signature'],
        },
      )) && ok;
  }
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
