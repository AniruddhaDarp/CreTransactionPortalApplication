import { DocusignProvider } from './docusign.js';
import { FakeProvider } from './fake.js';
import type { ESignatureProvider } from './types.js';

export * from './types.js';

let cached: ESignatureProvider | undefined;

/** The configured provider. `ESIGN_PROVIDER=docusign` selects the real one; anything else is the fake. */
export function getProvider(): ESignatureProvider {
  if (!cached) {
    cached = process.env.ESIGN_PROVIDER === 'docusign' ? new DocusignProvider() : new FakeProvider();
  }
  return cached;
}

/** Test seam. */
export function setProvider(p: ESignatureProvider | undefined): void {
  cached = p;
}
