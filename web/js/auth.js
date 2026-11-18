// Unlock methods: WebAuthn passkey with the PRF extension (biometrics / device screen lock) and passphrase.
// The PRF output is secret key material that only the authenticator can produce after user verification,
// so the biometric check is a real cryptographic gate, not only a UI prompt.
import { randomBytes } from './core.js';

export const webauthnPossible = () => !!(window.PublicKeyCredential && navigator.credentials);

function rpId() { return location.hostname; }

/** Creates a platform passkey and returns its PRF output for a fresh salt. Throws a readable Error. */
export async function enrollPrf() {
  if (!webauthnPossible()) throw new Error('This browser does not support passkeys.');
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: 'My-Safe', id: rpId() },
        user: { id: randomBytes(16), name: 'my-safe', displayName: 'My-Safe vault' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        extensions: { prf: {} },
        timeout: 60000,
      },
    });
  } catch (e) {
    throw new Error(e && e.name === 'NotAllowedError' ? 'Cancelled.' : `Could not create the passkey (${e && e.message}).`);
  }
  if (!cred.getClientExtensionResults().prf?.enabled) {
    throw new Error('This device or browser cannot derive keys from passkeys (PRF). Use a passphrase instead.');
  }
  const credId = new Uint8Array(cred.rawId);
  const prfSalt = randomBytes(32);
  const prfOutput = await prfAssert(credId, prfSalt);
  return { credId, prfSalt, prfOutput };
}

/** Prompts for biometrics / screen lock and returns the 32-byte PRF output. */
export async function prfAssert(credId, prfSalt) {
  let a;
  try {
    a = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: rpId(),
        allowCredentials: [{ type: 'public-key', id: credId }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: prfSalt } } },
        timeout: 60000,
      },
    });
  } catch (e) {
    throw new Error(e && e.name === 'NotAllowedError' ? 'Cancelled.' : `Authentication failed (${e && e.message}).`);
  }
  const out = a.getClientExtensionResults().prf?.results?.first;
  if (!out) throw new Error('The passkey did not return key material.');
  return new Uint8Array(out);
}
