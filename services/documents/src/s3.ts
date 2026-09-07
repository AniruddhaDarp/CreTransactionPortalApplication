import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';

let cached: S3Client | undefined;
function client(): S3Client {
  if (!cached) cached = new S3Client({});
  return cached;
}

/** Test seam. */
export function setS3Client(c: S3Client | undefined): void {
  cached = c;
}

function bucket(): string {
  const b = process.env.DOCS_BUCKET;
  if (!b) throw new Error('DOCS_BUCKET env var is not set');
  return b;
}

const PRESIGN_TTL = 300; // 5 minutes

export const s3Key = (dealId: string, docId: string, n: number, filename: string) =>
  `${dealId}/${docId}/v${n}/${filename}`;

export function presignPut(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn: PRESIGN_TTL },
  );
}

/** Direct write from the Lambda (used for the signed-copy version write-back). */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await client().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

/** Direct read from the Lambda (the DocuSign provider needs the source PDF bytes). */
export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const stream = r.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return new Uint8Array(Buffer.concat(chunks));
}

export function presignGet(key: string, opts: { download?: boolean; filename?: string } = {}): Promise<string> {
  const disposition = opts.download
    ? `attachment${opts.filename ? `; filename="${opts.filename}"` : ''}`
    : 'inline';
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: disposition,
    }),
    { expiresIn: PRESIGN_TTL },
  );
}
