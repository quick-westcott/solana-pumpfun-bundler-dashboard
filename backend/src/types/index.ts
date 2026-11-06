export interface LaunchParams {
  tokenName: string;
  tokenSymbol: string;
  description: string;
  imageUrl: string;
  website: string;
  twitter: string;
  telegram: string;
  devBuyAmount: number;
  bundleWalletCount: number;
  bundleSwapAmounts: number[];
  holderWalletCount: number;
  holderSwapAmounts: number[];
  holderAutoBuy: boolean;
  holderAutoBuyDelay: number;
  useJito: boolean;
  strictBundle: boolean;
  autoSellAfterLaunch: boolean;
  mintAddressMode: 'random' | 'vanity';
  devWalletId?: string;
  bundleWalletIds?: (string | null)[];
  holderWalletIds?: (string | null)[];
}

export interface LaunchRecord {
  id: string;
  tokenName: string;
  tokenSymbol: string;
  mintAddress?: string;
  imageUrl?: string;
  status: 'pending' | 'running' | 'confirmed' | 'error';
  signature?: string;
  error?: string;
  createdAt: string;
  params?: LaunchParams;
}

export type StageEvent = { stage: string; message: string; [k: string]: unknown };
