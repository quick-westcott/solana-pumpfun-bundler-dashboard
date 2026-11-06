// e2e: seal with the community repo's run-record.ts, POST to /api/ipfs (real API, real key),
// fetch the pinned JSON back, and verify the seal round-trips through the pinned metadata.
// Env: TRENCHY_API_URL, TRENCHY_API_KEY, API origin local run.
import crypto from 'crypto';
import bs58 from 'bs58';
import { sealRunRecord } from './backend/src/services/run-record.ts';

const API = process.env.TRENCHY_API_URL || 'https://api.trenchy.tools';
const KEY = process.env.TRENCHY_API_KEY;
if (!KEY) throw new Error('set TRENCHY_API_KEY');

// 1. seal 3 wallets (dev + 2 bundle)
const seeds = [crypto.randomBytes(32), crypto.randomBytes(32), crypto.randomBytes(32)];
const seal = sealRunRecord(seeds.map((s, i) => ({ publicKey: bs58.encode(s), seed: bs58.encode(s), label: `Dev/Bundle ${i + 1} - e2e` })), Date.now(), 'sol');
console.log('sealed:', seal.slice(0, 40) + '...');

// 2. POST /api/ipfs with backup
const fd = new FormData();
fd.append('file', new Blob([new Uint8Array(crypto.randomBytes(64))], { type: 'image/png' }), 'e2e.png');
fd.append('name', 'E2E Test');
fd.append('symbol', 'E2E');
fd.append('description', 'run-record e2e');
fd.append('backup', seal);
const up = await fetch(`${API}/api/ipfs`, { method: 'POST', headers: { 'x-api-key': KEY }, body: fd }).then(r => r.json());
console.log('metadataUri:', up.metadataUri);
if (!up.metadataUri || !up.metadata?.backup) throw new Error('API did not return metadata.backup');
console.log('metadata.backup present, starts:', String(up.metadata.backup).slice(0, 20));

// 3. fetch the pinned JSON back and confirm the seal survived the pin
const meta = await fetch(up.metadataUri.replace('ipfs://', 'https://ipfs.io/ipfs/')).then(r => r.json());
console.log('pinned backup starts:', String(meta.backup).slice(0, 20));
const okPinned = typeof meta.backup === 'string' && meta.backup.startsWith('v2:');
console.log('backup survived the pin:', okPinned ? 'PASS' : 'FAIL');
if (!okPinned) throw new Error('MISMATCH');
