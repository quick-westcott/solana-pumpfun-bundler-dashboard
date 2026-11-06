/**
 * Vanity mint pool. The grinding happens on the TrenchyTools API (POST /api/sol/vanity, GET /api/sol/vanity/:jobId):
 * common suffixes (`pump`, `bonk`) come from the API's warm pool and arrive at once, other patterns up to 4
 * characters are ground by its workers. Every keypair the API hands back is written to data/vanity-pool.json the
 * moment it arrives (wallet backup rule: a key that only lives in memory is a launch you cannot repeat), and the
 * launch executor reads the keypair from that file (getKeypairFromPool).
 *
 * "Generating" runs one API job at a time (the API allows one running job per key) and keeps starting the next one
 * until stopGenerator() is called, so the pool fills up like the old local grinder did. A stop lets the job that is
 * running finish and saves its key: abandoning it would waste the work and block our key for up to 10 minutes.
 */
import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { trenchy, TrenchyError, type Trenchy, type VanityJobStatus } from './trenchy';
import { VANITY_POOL_FILE } from '../paths';

export const POOL_FILE = VANITY_POOL_FILE;

export interface VanityAddress {
  publicKey: string;
  secretKey: string; // base58
  suffix: string;
  prefix?: string;
  status: 'available' | 'used';
  createdAt: string;
  usedAt?: string;
  /** where the key came from: the API's warm pool or a ground job */
  source?: 'api-pool' | 'api-job';
}

function ensureDir() {
  const dir = path.dirname(POOL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readPool(): VanityAddress[] {
  ensureDir();
  if (!fs.existsSync(POOL_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); } catch { return []; }
}

function writePool(pool: VanityAddress[]) {
  ensureDir();
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
}

/** The next unused key: a `…pump` one first (what the Launch page advertises), else any. */
export function getNextAvailable(): VanityAddress | null {
  const pool = readPool().filter(a => a.status === 'available');
  return pool.find(a => a.suffix === 'pump') || pool[0] || null;
}

export function markUsed(publicKey: string) {
  const pool = readPool();
  const addr = pool.find(a => a.publicKey === publicKey);
  if (addr) {
    addr.status = 'used';
    addr.usedAt = new Date().toISOString();
    writePool(pool);
  }
}

export function getKeypairFromPool(publicKey: string): Keypair | null {
  const pool = readPool();
  const addr = pool.find(a => a.publicKey === publicKey);
  if (!addr) return null;
  return Keypair.fromSecretKey(bs58.decode(addr.secretKey));
}

export function getPool(): VanityAddress[] {
  return readPool();
}

// ── generation (API jobs) ──────────────────────────────────────────────────

export type GeneratorOptions = { suffix?: string; prefix?: string; caseSensitive?: boolean };

/** Progress of the job running on the API right now, plus totals for this generating run. */
export interface GenerationStats {
  /** attempts of the current job (the API reports them; a pooled key needs none). `checked` is the old name. */
  checked: number;
  attempts: number;
  expectedAttempts: number;
  /** attempts / expectedAttempts, capped at 1: a 4-char suffix averages 11 M tries, so this is a rough guide */
  progress: number;
  found: number;
  /** seconds since this generating run started */
  elapsed: number;
  /** attempts per second of the current job */
  rate: number;
  jobId: string | null;
  pooled: boolean;
  /** how many keys the API has warm for the common suffixes (from the last job start) */
  poolReady: Record<string, number>;
  suffix: string;
  prefix: string;
  caseSensitive: boolean;
  source: 'api';
  lastError: string | null;
}

type Current = { jobId: string | null; attempts: number; expectedAttempts: number; elapsedMs: number; pooled: boolean };

let generating = false;        // keep starting jobs
let loopRunning = false;       // a loop is polling (it may outlive `generating` to collect the last job)
let totalFound = 0;
let generationStartedAt = 0;
let current: Current = { jobId: null, attempts: 0, expectedAttempts: 0, elapsedMs: 0, pooled: false };
let poolReady: Record<string, number> = {};
let pattern = { suffix: 'pump', prefix: '', caseSensitive: true };
let lastError: string | null = null;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function isGenerating(): boolean {
  return generating;
}

export function getGenerationStats(): GenerationStats {
  const elapsed = generationStartedAt ? (Date.now() - generationStartedAt) / 1000 : 0;
  const rate = current.elapsedMs > 0 ? Math.round(current.attempts / (current.elapsedMs / 1000)) : 0;
  return {
    checked: current.attempts,
    attempts: current.attempts,
    expectedAttempts: current.expectedAttempts,
    progress: current.expectedAttempts > 0 ? Math.min(1, current.attempts / current.expectedAttempts) : 0,
    found: totalFound,
    elapsed: Math.round(elapsed),
    rate,
    jobId: current.jobId,
    pooled: current.pooled,
    poolReady,
    suffix: pattern.suffix,
    prefix: pattern.prefix,
    caseSensitive: pattern.caseSensitive,
    source: 'api',
    lastError,
  };
}

export function getPoolStatus() {
  const pool = readPool();
  const available = pool.filter(a => a.status === 'available').length;
  const used = pool.filter(a => a.status === 'used').length;
  // Stats stay visible while the last job is being collected and after a failure (so the UI can show why).
  const stats = generating || loopRunning || lastError ? getGenerationStats() : null;
  return { available, used, total: pool.length, generating, collecting: loopRunning && !generating, stats, poolFile: POOL_FILE };
}

/** Save a finished job's keypair to the pool file (before anything else happens with it) and return the entry. */
function storeFound(job: VanityJobStatus): VanityAddress | null {
  if (!job.publicKey || !job.secretKey) return null;
  // Sanity: the secret must reproduce the public key the API claims.
  const kp = Keypair.fromSecretKey(bs58.decode(job.secretKey));
  if (kp.publicKey.toBase58() !== job.publicKey) throw new Error('vanity keypair from the API does not match its public key');
  const addr: VanityAddress = {
    publicKey: job.publicKey,
    secretKey: job.secretKey,
    suffix: job.suffix ?? '',
    ...(job.prefix ? { prefix: job.prefix } : {}),
    status: 'available',
    createdAt: new Date().toISOString(),
    source: job.pooled ? 'api-pool' : 'api-job',
  };
  const pool = readPool();
  if (!pool.some(a => a.publicKey === addr.publicKey)) {
    pool.push(addr);
    writePool(pool);
  }
  totalFound++;
  console.log(`[Vanity] Saved ${addr.publicKey} → ${POOL_FILE} (${job.pooled ? 'API warm pool' : `API job, ${job.attempts.toLocaleString()} attempts`}; pool size ${pool.length})`);
  return addr;
}

export type StartResult = { started: boolean; jobId: string | null; pooled: boolean; expectedAttempts: number; poolReady: Record<string, number>; found: number; note?: string };

/**
 * Start generating: one API job after another until stopGenerator(). The first call returns once the first job has
 * been started (or, for a pooled suffix, once the first key is already saved), so the caller sees refusals such as
 * vanity_too_long or a missing API key at once.
 */
export async function startGenerator(opts: GeneratorOptions = {}): Promise<StartResult> {
  const summary = (started: boolean, note?: string): StartResult => ({ started, jobId: current.jobId, pooled: current.pooled, expectedAttempts: current.expectedAttempts, poolReady, found: totalFound, ...(note ? { note } : {}) });
  if (generating) return summary(false);

  const suffix = String(opts.suffix ?? '').trim();
  const prefix = String(opts.prefix ?? '').trim();
  pattern = { suffix: suffix || (prefix ? '' : 'pump'), prefix, caseSensitive: opts.caseSensitive !== false };
  lastError = null;

  // A loop is still collecting the previous run's job: hand over to it rather than racing it (409 vanity_busy).
  if (loopRunning) {
    generating = true;
    return summary(true, 'finishing the previous job first, then grinding the new pattern');
  }

  const api = trenchy();
  totalFound = 0;
  generationStartedAt = Date.now();
  current = { jobId: null, attempts: 0, expectedAttempts: 0, elapsedMs: 0, pooled: false };

  // First job synchronously, so the route can report a refusal instead of a silent start.
  const first = await startOne(api);
  generating = true;
  if (first.status === 'done') storeFound(first);
  else if (first.status === 'failed') lastError = first.reason ?? 'the API job failed';
  void loop(api, first.status === 'running' ? first : null);
  return summary(true);
}

async function startOne(api: Trenchy): Promise<VanityJobStatus> {
  const start = await api.vanityStart({ suffix: pattern.suffix || undefined, prefix: pattern.prefix || undefined, caseSensitive: pattern.caseSensitive });
  poolReady = start.limits?.pool?.ready ?? poolReady;
  current = { jobId: start.jobId, attempts: 0, expectedAttempts: start.expectedAttempts, elapsedMs: 0, pooled: false };
  // One read straight away: a pooled key is already done and is handed out here.
  const job = await api.vanityJob(start.jobId);
  current = { jobId: job.jobId, attempts: job.attempts, expectedAttempts: job.expectedAttempts, elapsedMs: job.elapsedMs, pooled: job.pooled };
  return job;
}

async function loop(api: Trenchy, running: VanityJobStatus | null): Promise<void> {
  loopRunning = true;
  let job = running;
  let retries = 0;
  try {
    for (;;) {
      try {
        if (!job) {
          if (!generating) break;
          await sleep(400);   // between jobs: the API's warm pool refills, and we stay under its per-key limit
          if (!generating) break;
          job = await startOne(api);
          retries = 0;
        }
        // Poll to the end even after a stop: the job is ours and the API hands its key out once.
        while (job.status === 'running') {
          await sleep(2500);
          job = await api.vanityJob(job.jobId);
          current = { jobId: job.jobId, attempts: job.attempts, expectedAttempts: job.expectedAttempts, elapsedMs: job.elapsedMs, pooled: job.pooled };
        }
        if (job.status === 'done') storeFound(job);
        else if (job.status === 'failed') { lastError = job.reason ?? 'the API job failed'; console.warn(`[Vanity] API job ${job.jobId} failed: ${lastError}`); }
        job = null;
      } catch (e) {
        const err = e instanceof TrenchyError ? e : null;
        lastError = e instanceof Error ? e.message : String(e);
        job = null;
        if (err?.code === 'vanity_too_long' || err?.status === 401 || err?.code === 'no_key' || err?.code === 'not_found') {
          // Not going to get better by retrying: stop and leave the reason in the status.
          console.warn(`[Vanity] stopped: ${lastError}`);
          generating = false;
          break;
        }
        // Busy workers (429 vanity_busy), a job of ours still running (409), network hiccups: wait and try again.
        if (++retries > 10) { console.warn(`[Vanity] giving up after repeated errors: ${lastError}`); generating = false; break; }
        console.warn(`[Vanity] ${lastError}; retrying in 30 s`);
        await sleep(30_000);
      }
    }
  } finally {
    loopRunning = false;
    current = { ...current, jobId: null };
  }
}

export function stopGenerator(): { stopped: boolean; collecting: boolean } {
  if (!generating) return { stopped: false, collecting: loopRunning };
  generating = false;
  console.log(`[Vanity] Generator stopped${current.jobId ? ` (collecting job ${current.jobId} first)` : ''}`);
  return { stopped: true, collecting: loopRunning && !!current.jobId };
}
