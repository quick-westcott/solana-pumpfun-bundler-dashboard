/** Launch records: backend/data/launches.json. */
import fs from 'fs';
import path from 'path';
import { LAUNCHES_FILE } from '../paths';
import type { LaunchRecord } from '../types';
import type { StoredWallet } from './vault';

export function readLaunches(): LaunchRecord[] {
  if (!fs.existsSync(LAUNCHES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LAUNCHES_FILE, 'utf8') || '[]'); } catch { return []; }
}

export function saveLaunch(launch: LaunchRecord): void {
  const launches = readLaunches();
  const idx = launches.findIndex(l => l.id === launch.id);
  if (idx >= 0) launches[idx] = launch; else launches.push(launch);
  fs.mkdirSync(path.dirname(LAUNCHES_FILE), { recursive: true });
  fs.writeFileSync(LAUNCHES_FILE, JSON.stringify(launches, null, 2));
}

export function deleteLaunch(id: string): LaunchRecord | null {
  const launches = readLaunches();
  const idx = launches.findIndex(l => l.id === id);
  if (idx === -1) return null;
  const [removed] = launches.splice(idx, 1);
  fs.writeFileSync(LAUNCHES_FILE, JSON.stringify(launches, null, 2));
  return removed;
}

export const findLaunch = (id: string): LaunchRecord | null => readLaunches().find(l => l.id === id) ?? null;
export const findLaunchByMint = (mint: string): LaunchRecord | null => readLaunches().find(l => l.mintAddress === mint) ?? null;

export type LaunchRole = 'dev' | 'bundle' | 'holder';

/**
 * The slot a wallet filled in a launch. Generated wallets carry it as their type; a wallet picked from the vault
 * (imported, or the funding wallet used as dev) keeps its own type and the slot lives in the launch params.
 */
export function launchRole(w: StoredWallet, launch?: LaunchRecord | null): LaunchRole | null {
  if (w.type === 'dev' || w.type === 'bundle' || w.type === 'holder') return w.type;
  if (!launch || w.launchId !== launch.id || !launch.params) return null;
  const p = launch.params;
  if (p.devWalletId === w.id) return 'dev';
  if (p.bundleWalletIds?.includes(w.id)) return 'bundle';
  if (p.holderWalletIds?.includes(w.id)) return 'holder';
  return null;
}
