import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

let cached: SESv2Client | undefined;
function client(): SESv2Client {
  if (!cached) cached = new SESv2Client({});
  return cached;
}
/** Test seam. */
export function setSesClient(c: SESv2Client | undefined): void {
  cached = c;
}

/** Email is off until an SES domain/sender is verified and `NOTIFY_EMAIL_FROM` is set. */
export function emailFrom(): string | undefined {
  return process.env.NOTIFY_EMAIL_FROM || undefined;
}
export const emailEnabled = (): boolean => Boolean(emailFrom());

export async function sendEmail(to: string, subject: string, body: string): Promise<boolean> {
  const from = emailFrom();
  if (!from) return false; // disabled — caller logs
  await client().send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: { Text: { Data: body } },
        },
      },
    }),
  );
  return true;
}
