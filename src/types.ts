/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface UserProfile {
  uid: string;
  username: string;
  email: string;
  balance: number;
  isBanned: boolean;
  isAdmin: boolean;
  createdAt: number;
}

export type BetColor = 'red' | 'green' | 'violet';

export interface GameRound {
  id: string; // Dynamic ID, e.g. "R-20260531-0145" or numeric timestamp index
  startTime: number;
  endTime: number;
  status: 'active' | 'completed';
  resultColor?: BetColor | 'red-violet' | 'green-violet' | null;
  resultNumber?: number | null;
  totalBetsRed?: number;
  totalBetsGreen?: number;
  totalBetsViolet?: number;
  createdAt: number;
}

export interface UserBet {
  id: string;
  userId: string;
  username: string;
  roundId: string;
  color: BetColor;
  amount: number;
  winAmount: number | null; // null if pending, >0 if won, 0 if lost
  resultStatus: 'pending' | 'won' | 'lost';
  timestamp: number;
}

export interface Transaction {
  id: string;
  userId: string;
  type: 'deposit' | 'withdraw' | 'bet' | 'win';
  amount: number;
  status: 'completed' | 'pending';
  timestamp: number;
  description?: string;
}

export interface AdminStats {
  totalUsers: number;
  totalBets: number;
  totalVolume: number;
  houseProfit: number;
}
