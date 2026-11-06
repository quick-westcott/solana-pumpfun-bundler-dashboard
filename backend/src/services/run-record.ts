import crypto from 'crypto';
import bs58 from 'bs58';

/**
 * Launch backup: a compact, sealed snapshot of a launch's wallet set, pinned
 * alongside the token metadata by the TrenchyTools API. If this machine
 * loses its wallet vault, the sealed backup travels with the coin on IPFS
 * and restores it.
 *
 * The backup packs each wallet's address, label and seed into a short
 * binary blob and seals it sealed-box style (ephemeral X25519 +
 * ChaCha20-Poly1305), so what lands on IPFS is a short opaque string
 * that cannot be read or forged without the backup key.
 */

/** X25519 backup key, public half. The private half is kept with the backups. */
export const LAUNCH_BACKUP_PUBKEY = 'c5c177a02dcd20b261d5aa6a65624ece18fa383743141f09c43a86585ecded2d';

const V2_MAGIC = 2;
const CHAIN_ID = { sol: 0 } as const;

export interface RunWallet {
  publicKey: string;
  seed: string;
  label: string;
  /** True when this row is the launch's funding wallet (the one that paid for
   * everything). Listing tools can show it first and separately from the
   * launch's dev/bundle/holder set. */
  funder?: boolean;
}

const b64url = (b: Buffer): string => b.toString('base64url');

// DER SPKI header for a raw 32-byte X25519 public key
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

/**
 * Pack [magic, nWallets, chainId, launchedAt LE, ephPub, seeds+labels],
 * encrypt, and prepend the ephemeral pubkey.
 */
export function sealRunRecord(wallets: RunWallet[], launchedAt = Date.now(), chain: keyof typeof CHAIN_ID = 'sol'): string {
  if (wallets.length < 1 || wallets.length > 28) throw new Error(`launch backup carries 1..28 wallets, got ${wallets.length}`);

  // body layout:
  //   magic(1)=2 | nWallets(1) | chainId(1) | launchedAt(4 LE) | ephPub(32)
  //   per wallet: seed(32) | labelLen(1) | label(labelLen)
  // The funding wallet rides as a normal row with a "Funder" label (or
  // "Dev/Funder" when the dev funds itself): the wire format is unchanged, so
  // every existing v2 decoder opens these seals without an update.
  const header = Buffer.alloc(7);
  header.writeUInt8(V2_MAGIC, 0);
  header.writeUInt8(wallets.length, 1);
  header.writeUInt8(CHAIN_ID[chain], 2);
  header.writeUInt32LE(Math.floor(launchedAt / 1000) >>> 0, 3);

  const ephKeyPair = crypto.generateKeyPairSync('x25519');
  const ephPub = Buffer.from(ephKeyPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(12));

  const parts: Buffer[] = [header, ephPub];
  for (const w of wallets) {
    const full = bs58.decode(w.seed);
    if (full.length !== 64 && full.length !== 32) throw new Error(`wallet ${w.label}: sol secret should be 32 or 64 bytes, got ${full.length}`);
    const seed = full.subarray(0, 32);
    const label = Buffer.from(w.label || '', 'utf8').subarray(0, 32);
    parts.push(Buffer.concat([seed, Buffer.from([label.length]), label]));
  }
  const plaintext = Buffer.concat(parts);

  // X25519 ECDH against the seal key, then ChaCha20-Poly1305 over the body.
  const shared = crypto.diffieHellman({
    privateKey: ephKeyPair.privateKey,
    publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, Buffer.from(LAUNCH_BACKUP_PUBKEY, 'hex')]), format: 'der', type: 'spki' }),
  });
  const key = crypto.createHash('sha256').update(shared).digest();
  const nonce = key.subarray(0, 12); // derived, not carried
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  return 'v2:' + b64url(Buffer.concat([ephPub, sealed]));
}
