// Generates small, valid, visually-distinct one-page PDFs for the walkthrough's
// document-upload steps. Output: scripts/fixtures/*.pdf
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** One-page Helvetica PDF from `lines`, with a correct xref table. */
function pdf(lines) {
  const content =
    `BT /F1 20 Tf 72 720 Td (${esc(lines[0])}) Tj /F1 12 Tf 0 -28 TL\n` +
    lines
      .slice(1)
      .map((l) => `T* (${esc(l)}) Tj`)
      .join('\n') +
    `\nET`;
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`,
  ];
  let out = `%PDF-1.4\n`;
  const offs = [];
  objs.forEach((b, i) => {
    offs.push(Buffer.byteLength(out, 'utf8'));
    out += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'utf8');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'utf8');
}

const now = new Date().toISOString().slice(0, 10);
const FIXTURES = {
  'psa-draft.pdf': ['PURCHASE & SALE AGREEMENT — DRAFT', '1200 Congress Ave, Austin TX', `Prepared ${now}`, 'DRAFT — not for execution.'],
  'psa-redline.pdf': ['PURCHASE & SALE AGREEMENT — REDLINE v2', 'Buyer counsel comments in the margins.', `Prepared ${now}`],
  'psa-final.pdf': ['PURCHASE & SALE AGREEMENT — FINAL v3', 'Ready for signature.', `Prepared ${now}`],
  'disclosure-addendum.pdf': ['SELLER DISCLOSURE ADDENDUM', 'Known conditions and material facts.', `Prepared ${now}`],
  'seller-disclosures.pdf': ['SELLER PROPERTY DISCLOSURES', 'Roof, HVAC, environmental, litigation.', `Prepared ${now}`],
  'rent-roll.pdf': ['RENT ROLL + TRAILING-12 OPERATING STATEMENT', 'Suite / tenant / SF / base rent / expiry.', `As of ${now}`],
  'phase-i-esa.pdf': ['PHASE I ENVIRONMENTAL SITE ASSESSMENT', 'No recognized environmental conditions identified.', `Report date ${now}`],
  'loan-commitment.pdf': ['LOAN COMMITMENT LETTER', 'Acquisition financing — terms and conditions.', `Issued ${now}`],
  'title-commitment.pdf': ['TITLE COMMITMENT (ALTA)', 'Schedule A / Schedule B exceptions.', `Effective ${now}`],
  'alta-survey.pdf': ['ALTA / NSPS LAND TITLE SURVEY', 'Boundary, easements, improvements.', `Field work ${now}`],
  'title-curative.pdf': ['TITLE CURATIVE — RELEASE OF LIEN', 'Clears Schedule B item 7.', `Recorded ${now}`],
  'settlement-statement.pdf': ['SETTLEMENT STATEMENT (CLOSING)', 'Debits, credits, prorations, net to seller.', `Closing ${now}`],
  'deed.pdf': ['SPECIAL WARRANTY DEED', 'Grantor conveys to Grantee. To be executed at closing.', `Prepared ${now}`],
  'scratch.pdf': ['SCRATCH / WRONG FILE', 'Use this one for the "add a version" and "delete" steps.', `Created ${now}`],
};

mkdirSync(OUT, { recursive: true });
for (const [name, lines] of Object.entries(FIXTURES)) {
  writeFileSync(join(OUT, name), pdf(lines));
}
console.log(`Wrote ${Object.keys(FIXTURES).length} PDFs to ${OUT}`);
for (const n of Object.keys(FIXTURES)) console.log(`  ${n}`);
