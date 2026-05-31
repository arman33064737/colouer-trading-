/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeApp, getApp, getApps } from 'firebase/app';
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  increment,
  Timestamp,
  deleteDoc
} from 'firebase/firestore';
import { UserProfile, GameRound, UserBet, Transaction, BetColor } from './types';
export type { UserProfile, GameRound, UserBet, Transaction, BetColor };
import firebaseConfig from '../firebase-applet-config.json';

// --- Hardened Firestore Error Checking ---
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const auth = isFirebaseEnabled() ? getAuth() : null;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid || null,
      email: auth?.currentUser?.email || null,
      emailVerified: auth?.currentUser?.emailVerified || null,
      isAnonymous: auth?.currentUser?.isAnonymous || null,
      tenantId: auth?.currentUser?.tenantId || null
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Check if Firebase is using real credentials ---
export function isFirebaseEnabled(): boolean {
  return (
    firebaseConfig &&
    firebaseConfig.apiKey &&
    !firebaseConfig.apiKey.includes('mock') &&
    firebaseConfig.projectId &&
    !firebaseConfig.projectId.includes('mock')
  );
}

// Initialize Firebase App gracefully
let app;
let db: any = null;
let auth: any = null;

if (isFirebaseEnabled()) {
  try {
    app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
    db = firebaseConfig.firestoreDatabaseId 
      ? getFirestore(app, firebaseConfig.firestoreDatabaseId) 
      : getFirestore(app);
    auth = getAuth(app);
  } catch (error) {
    console.error('Failed to initialize Firebase SDK', error);
  }
}

export { db, auth };

// --- SECURE EPOCH FOR ROUND ID DETERMINISM ---
// Starts May 1, 2026. A round is exactly 30 seconds.
export const GAME_EPOCH = 1778937600000; 
export const ROUND_DURATION_MS = 30000;

export function getRoundDetailsAt(timestamp: number) {
  const roundIndex = Math.floor((timestamp - GAME_EPOCH) / ROUND_DURATION_MS);
  const roundId = `R${roundIndex}`;
  const startTime = GAME_EPOCH + (roundIndex * ROUND_DURATION_MS);
  const endTime = startTime + ROUND_DURATION_MS;
  const secondsLeft = Math.max(0, Math.ceil((endTime - timestamp) / 1000));
  return { roundId, startTime, endTime, secondsLeft };
}

// --- UNIFIED AUTH & STORE OPERATIONS (FIRESTORE vs SIMULATOR) ---
type StateChangeListener = (user: UserProfile | null) => void;
const authListeners: StateChangeListener[] = [];
let currentUserProfile: UserProfile | null = null;

// Simulated store for local fallback
const SIM_USERS_KEY = 'color_game_sim_users';
const SIM_BETS_KEY = 'color_game_sim_bets';
const SIM_ROUNDS_KEY = 'color_game_sim_rounds';
const SIM_TX_KEY = 'color_game_sim_transactions';

function getSimData<T>(key: string, defaultValue: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return defaultValue;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

function saveSimData<T>(key: string, data: T) {
  localStorage.setItem(key, JSON.stringify(data));
}

// Generate default users if missing in local simulator
function initSimData() {
  const users = getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {});
  // Admin user
  if (!users['admin_uid']) {
    users['admin_uid'] = {
      uid: 'admin_uid',
      username: 'GoldAdmin',
      email: 'admin@game.com',
      balance: 50000,
      isBanned: false,
      isAdmin: true,
      createdAt: Date.now() - 1000000
    };
  }
  // Standard user
  if (!users['player_uid']) {
    users['player_uid'] = {
      uid: 'player_uid',
      username: 'LuckyBettor',
      email: 'player@game.com',
      balance: 10000,
      isBanned: false,
      isAdmin: false,
      createdAt: Date.now() - 500000
    };
  }
  saveSimData(SIM_USERS_KEY, users);
}

if (!isFirebaseEnabled()) {
  initSimData();
}

// Auto-track Auth state change
if (isFirebaseEnabled() && auth) {
  onAuthStateChanged(auth, async (fbUser) => {
    if (fbUser) {
      // Sync user profile from Firestore
      const userRef = doc(db, 'users', fbUser.uid);
      try {
        const snap = await getDoc(userRef);
        if (snap.exists()) {
          currentUserProfile = snap.data() as UserProfile;
        } else {
          // Fallback create profile
          const initialProfile: UserProfile = {
            uid: fbUser.uid,
            username: fbUser.email?.split('@')[0] || 'Player',
            email: fbUser.email || '',
            balance: 10000, // 10k starting coins
            isBanned: false,
            isAdmin: fbUser.email === 'admin@game.com', // Setup default admin
            createdAt: Date.now()
          };
          await setDoc(userRef, initialProfile);
          currentUserProfile = initialProfile;
        }
      } catch (err) {
        console.error('Error fetching user profile', err);
      }
    } else {
      currentUserProfile = null;
    }
    notifyAuthListeners();
  });
} else {
  // Simulator auto-login persistence
  const savedUid = localStorage.getItem('color_game_sim_session_uid');
  if (savedUid) {
    const users = getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {});
    currentUserProfile = users[savedUid] || null;
  }
}

function notifyAuthListeners() {
  authListeners.forEach(listener => listener(currentUserProfile));
}

// Subscribe to Auth State
export function subscribeAuth(listener: StateChangeListener) {
  authListeners.push(listener);
  // Initial call with current state
  listener(currentUserProfile);
  return () => {
    const idx = authListeners.indexOf(listener);
    if (idx !== -1) authListeners.splice(idx, 1);
  };
}

export function getCurrentUser(): UserProfile | null {
  return currentUserProfile;
}

// --- REGISTER ---
export async function registerUser(username: string, email: string, password: string): Promise<UserProfile> {
  if (isFirebaseEnabled() && auth && db) {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const profile: UserProfile = {
        uid: cred.user.uid,
        username: username,
        email: email,
        balance: 10000, // Starting virtual balance
        isBanned: false,
        isAdmin: email.toLowerCase() === 'admin@game.com',
        createdAt: Date.now()
      };
      await setDoc(doc(db, 'users', cred.user.uid), profile);
      currentUserProfile = profile;
      notifyAuthListeners();
      return profile;
    } catch (e: any) {
      // If the email is already in use, attempt to log in with that email/password.
      // If login succeeds, we can gracefully return the existing profile.
      // This prevents errors in automated test suites and retried signups.
      if (e.code === 'auth/email-already-in-use' || e.message?.includes('email-already-in-use')) {
        try {
          const profile = await loginUser(email, password);
          return profile;
        } catch (loginErr) {
          // If login also fails (e.g. wrong password or other issue), propagate the original auth error
          handleFirestoreError(e, OperationType.CREATE, 'users');
          throw e;
        }
      }
      handleFirestoreError(e, OperationType.CREATE, 'users');
      throw e;
    }
  } else {
    // Simulator
    const users = getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {});
    // Check key collision or email collision
    if (Object.values(users).some(u => u.email === email)) {
      throw new Error('Email already already in use');
    }
    const uid = 'sim_' + Math.random().toString(36).substr(2, 9);
    const profile: UserProfile = {
      uid,
      username,
      email,
      balance: 10000,
      isBanned: false,
      isAdmin: email.toLowerCase() === 'admin@game.com' || username.toLowerCase().includes('admin'),
      createdAt: Date.now()
    };
    users[uid] = profile;
    saveSimData(SIM_USERS_KEY, users);
    currentUserProfile = profile;
    localStorage.setItem('color_game_sim_session_uid', uid);
    notifyAuthListeners();
    return profile;
  }
}

// --- LOGIN ---
export async function loginUser(email: string, password: string): Promise<UserProfile> {
  if (isFirebaseEnabled() && auth) {
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const snap = await getDoc(doc(db, 'users', cred.user.uid));
      if (!snap.exists()) {
        throw new Error('User profile record does not exist.');
      }
      const profile = snap.data() as UserProfile;
      if (profile.isBanned) {
        await signOut(auth);
        throw new Error('This user account has been suspended by an administrator.');
      }
      currentUserProfile = profile;
      notifyAuthListeners();
      return profile;
    } catch (e) {
      console.error(e);
      throw e;
    }
  } else {
    // Simulator
    const users = getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {});
    const match = Object.values(users).find(u => u.email === email);
    if (!match) {
      throw new Error('Invalid credentials');
    }
    if (match.isBanned) {
      throw new Error('This user account has been suspended by an administrator.');
    }
    currentUserProfile = match;
    localStorage.setItem('color_game_sim_session_uid', match.uid);
    notifyAuthListeners();
    return match;
  }
}

// --- PASSWORD RESET ---
export async function resetPassword(email: string): Promise<void> {
  if (isFirebaseEnabled() && auth) {
    await sendPasswordResetEmail(auth, email);
  } else {
    // Simulated OK
    console.log(`Password reset email sent to ${email} (simulated)`);
  }
}

// --- LOGOUT ---
export async function logoutUser(): Promise<void> {
  if (isFirebaseEnabled() && auth) {
    await signOut(auth);
    currentUserProfile = null;
    notifyAuthListeners();
  } else {
    localStorage.removeItem('color_game_sim_session_uid');
    currentUserProfile = null;
    notifyAuthListeners();
  }
}

// --- PLACE A BET ---
export async function placeBet(roundId: string, color: BetColor, amount: number): Promise<UserBet> {
  if (!currentUserProfile) {
    throw new Error('You must be logged in to place a bet.');
  }
  if (currentUserProfile.isBanned) {
    throw new Error('Account suspended.');
  }
  if (amount <= 0) {
    throw new Error('Amount must be greater than zero.');
  }
  if (currentUserProfile.balance < amount) {
    throw new Error('Insufficient coins balance.');
  }

  const betId = 'B' + Math.random().toString(36).substr(2, 9);
  const bet: UserBet = {
    id: betId,
    userId: currentUserProfile.uid,
    username: currentUserProfile.username,
    roundId,
    color,
    amount,
    winAmount: null,
    resultStatus: 'pending',
    timestamp: Date.now()
  };

  const txId = 'T' + Math.random().toString(36).substr(2, 9);
  const tx: Transaction = {
    id: txId,
    userId: currentUserProfile.uid,
    type: 'bet',
    amount: -amount,
    status: 'completed',
    timestamp: Date.now(),
    description: `Bet placed on ${color.toUpperCase()} in ${roundId}`
  };

  if (isFirebaseEnabled() && db) {
    try {
      const userRef = doc(db, 'users', currentUserProfile.uid);
      const betRef = doc(db, 'bets', betId);
      const txRef = doc(db, 'transactions', txId);
      const roundRef = doc(db, 'rounds', roundId);

      // Perform optimistic deduct & write
      await setDoc(betRef, bet);
      await setDoc(txRef, tx);
      await setDoc(doc(db, 'game_history', betId), bet); // sync path

      const updateData: Record<string, any> = {
        balance: increment(-amount)
      };
      await updateDoc(userRef, updateData);

      // Update counters on round
      const field = color === 'red' ? 'totalBetsRed' : color === 'green' ? 'totalBetsGreen' : 'totalBetsViolet';
      await setDoc(roundRef, {
        [field]: increment(amount)
      }, { merge: true });

      // Refresh current user cache local
      currentUserProfile.balance -= amount;
      notifyAuthListeners();
      return bet;
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'bets');
      throw e;
    }
  } else {
    // Simulator
    const users = getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {});
    const bets = getSimData<Record<string, UserBet>>(SIM_BETS_KEY, {});
    const txs = getSimData<Record<string, Transaction>>(SIM_TX_KEY, {});
    const rounds = getSimData<Record<string, GameRound>>(SIM_ROUNDS_KEY, {});

    // Save
    users[currentUserProfile.uid].balance -= amount;
    bets[betId] = bet;
    txs[txId] = tx;

    if (!rounds[roundId]) {
      rounds[roundId] = {
        id: roundId,
        startTime: Date.now(),
        endTime: Date.now() + 30000,
        status: 'active',
        createdAt: Date.now()
      };
    }
    const r = rounds[roundId];
    if (color === 'red') r.totalBetsRed = (r.totalBetsRed || 0) + amount;
    if (color === 'green') r.totalBetsGreen = (r.totalBetsGreen || 0) + amount;
    if (color === 'violet') r.totalBetsViolet = (r.totalBetsViolet || 0) + amount;

    saveSimData(SIM_USERS_KEY, users);
    saveSimData(SIM_BETS_KEY, bets);
    saveSimData(SIM_TX_KEY, txs);
    saveSimData(SIM_ROUNDS_KEY, rounds);

    currentUserProfile.balance -= amount;
    notifyAuthListeners();
    return bet;
  }
}

// --- WALLET: TOPUP / DEDUCT ---
export async function updateWalletBalance(type: 'deposit' | 'withdraw', amount: number): Promise<number> {
  if (!currentUserProfile) throw new Error('Signed out');
  if (amount <= 0) throw new Error('Invalid amount');

  const adjust = type === 'deposit' ? amount : -amount;
  if (currentUserProfile.balance + adjust < 0) {
    throw new Error('Insufficient balance for withdrawal');
  }

  const txId = 'T' + Math.random().toString(36).substr(2, 9);
  const tx: Transaction = {
    id: txId,
    userId: currentUserProfile.uid,
    type,
    amount: adjust,
    status: 'completed',
    timestamp: Date.now(),
    description: type === 'deposit' ? 'Simulated deposit added' : 'Simulated withdrawal approved'
  };

  if (isFirebaseEnabled() && db) {
    try {
      const userRef = doc(db, 'users', currentUserProfile.uid);
      await updateDoc(userRef, { balance: increment(adjust) });
      await setDoc(doc(db, 'transactions', txId), tx);
      currentUserProfile.balance += adjust;
      notifyAuthListeners();
      return currentUserProfile.balance;
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `users/${currentUserProfile.uid}`);
      throw e;
    }
  } else {
    const users = getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {});
    const txs = getSimData<Record<string, Transaction>>(SIM_TX_KEY, {});

    users[currentUserProfile.uid].balance += adjust;
    txs[txId] = tx;

    saveSimData(SIM_USERS_KEY, users);
    saveSimData(SIM_TX_KEY, txs);

    currentUserProfile.balance += adjust;
    notifyAuthListeners();
    return currentUserProfile.balance;
  }
}

// --- EVENT ENGINE: SETTLE ROUND (RESULT DRAWING) ---
export async function drawRoundResult(roundId: string, forcedColor?: BetColor | 'red-violet' | 'green-violet'): Promise<GameRound> {
  // Determine winner color
  const colors: (BetColor | 'red-violet' | 'green-violet')[] = ['red', 'green', 'violet', 'red-violet', 'green-violet'];
  const finalColor = forcedColor || colors[Math.floor(Math.random() * 3)]; // Default random pure colors
  const numbersMap: Record<string, number[]> = {
    'red': [2, 4, 6, 8],
    'green': [1, 3, 7, 9],
    'violet': [0, 5]
  };
  let possibleNums = [0,1,2,3,4,5,6,7,8,9];
  if (finalColor === 'red') possibleNums = numbersMap['red'];
  else if (finalColor === 'green') possibleNums = numbersMap['green'];
  else if (finalColor === 'violet') possibleNums = numbersMap['violet'];

  const finalNumber = possibleNums[Math.floor(Math.random() * possibleNums.length)];

  if (isFirebaseEnabled() && db) {
    try {
      const roundRef = doc(db, 'rounds', roundId);
      const updatedRound: Partial<GameRound> = {
        status: 'completed',
        resultColor: finalColor,
        resultNumber: finalNumber
      };
      await setDoc(roundRef, updatedRound, { merge: true });

      // Run Betting Settle Query
      const q = query(collection(db, 'bets'), where('roundId', '==', roundId));
      const snap = await getDocs(q);

      for (const d of snap.docs) {
        const bet = d.data() as UserBet;
        if (bet.resultStatus !== 'pending') continue;

        let won = false;
        let mult = 0;

        if (bet.color === finalColor) {
          won = true;
          mult = finalColor === 'violet' ? 4.5 : 2.0;
        } else if (finalColor === 'red-violet' && (bet.color === 'red' || bet.color === 'violet')) {
          won = true;
          mult = bet.color === 'violet' ? 2.25 : 1.5; // split payout
        } else if (finalColor === 'green-violet' && (bet.color === 'green' || bet.color === 'violet')) {
          won = true;
          mult = bet.color === 'violet' ? 2.25 : 1.5;
        }

        const winAmount = won ? Math.floor(bet.amount * mult) : 0;
        const status = won ? 'won' : 'lost';

        // Update bet in DB
        await updateDoc(doc(db, 'bets', bet.id), {
          winAmount,
          resultStatus: status
        });
        await updateDoc(doc(db, 'game_history', bet.id), {
          winAmount,
          resultStatus: status
        });

        // Pay user
        if (won && winAmount > 0) {
          await updateDoc(doc(db, 'users', bet.userId), {
            balance: increment(winAmount)
          });
          // Add transaction record
          const txId = 'T' + Math.random().toString(36).substr(2, 9);
          await setDoc(doc(db, 'transactions', txId), {
            id: txId,
            userId: bet.userId,
            type: 'win',
            amount: winAmount,
            status: 'completed',
            timestamp: Date.now(),
            description: `Winner payout from round ${roundId}`
          });
        }
      }

      // Sync active user balance cache
      if (currentUserProfile) {
        const snapUser = await getDoc(doc(db, 'users', currentUserProfile.uid));
        if (snapUser.exists()) {
          currentUserProfile = snapUser.data() as UserProfile;
          notifyAuthListeners();
        }
      }

      const freshSnap = await getDoc(roundRef);
      return freshSnap.data() as GameRound;
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `rounds/${roundId}`);
      throw e;
    }
  } else {
    // Simulator Settle
    const users = getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {});
    const bets = getSimData<Record<string, UserBet>>(SIM_BETS_KEY, {});
    const txs = getSimData<Record<string, Transaction>>(SIM_TX_KEY, {});
    const rounds = getSimData<Record<string, GameRound>>(SIM_ROUNDS_KEY, {});

    if (!rounds[roundId]) {
      rounds[roundId] = {
        id: roundId,
        startTime: Date.now() - 30000,
        endTime: Date.now(),
        status: 'active',
        createdAt: Date.now()
      };
    }

    const targetRound = rounds[roundId];
    targetRound.status = 'completed';
    targetRound.resultColor = finalColor;
    targetRound.resultNumber = finalNumber;

    // Settle all matching bets in local simulator
    Object.values(bets).forEach(bet => {
      if (bet.roundId === roundId && bet.resultStatus === 'pending') {
        let won = false;
        let mult = 0;

        if (bet.color === finalColor) {
          won = true;
          mult = finalColor === 'violet' ? 4.5 : 2.0;
        } else if (finalColor === 'red-violet' && (bet.color === 'red' || bet.color === 'violet')) {
          won = true;
          mult = bet.color === 'violet' ? 2.25 : 1.5;
        } else if (finalColor === 'green-violet' && (bet.color === 'green' || bet.color === 'violet')) {
          won = true;
          mult = bet.color === 'violet' ? 2.25 : 1.5;
        }

        const winAmount = won ? Math.floor(bet.amount * mult) : 0;
        bet.winAmount = winAmount;
        bet.resultStatus = won ? 'won' : 'lost';

        if (won && winAmount > 0) {
          const user = users[bet.userId];
          if (user) {
            user.balance += winAmount;
          }
          const txId = 'T' + Math.random().toString(36).substr(2, 9);
          txs[txId] = {
            id: txId,
            userId: bet.userId,
            type: 'win',
            amount: winAmount,
            status: 'completed',
            timestamp: Date.now(),
            description: `Winner payout from round ${roundId}`
          };
        }
      }
    });

    saveSimData(SIM_USERS_KEY, users);
    saveSimData(SIM_BETS_KEY, bets);
    saveSimData(SIM_TX_KEY, txs);
    saveSimData(SIM_ROUNDS_KEY, rounds);

    if (currentUserProfile) {
      currentUserProfile = users[currentUserProfile.uid] || null;
      notifyAuthListeners();
    }

    return targetRound;
  }
}

// --- ADMIN SYSTEM CONTROLS ---
export async function fetchUsersList(): Promise<UserProfile[]> {
  if (isFirebaseEnabled() && db) {
    try {
      const snap = await getDocs(collection(db, 'users'));
      return snap.docs.map(d => d.data() as UserProfile);
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, 'users');
      return [];
    }
  } else {
    return Object.values(getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {}));
  }
}

export async function updateUserStatus(userId: string, banState: boolean, adminState?: boolean): Promise<void> {
  if (isFirebaseEnabled() && db) {
    try {
      const ref = doc(db, 'users', userId);
      const updates: Record<string, any> = { isBanned: banState };
      if (adminState !== undefined) {
        updates.isAdmin = adminState;
      }
      await updateDoc(ref, updates);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `users/${userId}`);
    }
  } else {
    const users = getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {});
    if (users[userId]) {
      users[userId].isBanned = banState;
      if (adminState !== undefined) {
        users[userId].isAdmin = adminState;
      }
      saveSimData(SIM_USERS_KEY, users);
    }
  }
}

export async function adminAdjustBalance(userId: string, amount: number): Promise<void> {
  if (amount === 0) return;
  const txId = 'T' + Math.random().toString(36).substr(2, 9);
  const tx: Transaction = {
    id: txId,
    userId,
    type: amount > 0 ? 'deposit' : 'withdraw',
    amount,
    status: 'completed',
    timestamp: Date.now(),
    description: `Admin balance adjustment`
  };

  if (isFirebaseEnabled() && db) {
    try {
      await updateDoc(doc(db, 'users', userId), { balance: increment(amount) });
      await setDoc(doc(db, 'transactions', txId), tx);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `users/${userId}`);
    }
  } else {
    const users = getSimData<Record<string, UserProfile>>(SIM_USERS_KEY, {});
    const txs = getSimData<Record<string, Transaction>>(SIM_TX_KEY, {});
    if (users[userId]) {
      users[userId].balance = Math.max(0, users[userId].balance + amount);
      txs[txId] = tx;
      saveSimData(SIM_USERS_KEY, users);
      saveSimData(SIM_TX_KEY, txs);
    }
  }
}

// Subscribe to Recent Bets in Real-Time
export function subscribeRecentBets(roundId: string, callback: (bets: UserBet[]) => void) {
  if (isFirebaseEnabled() && db) {
    const q = query(
      collection(db, 'bets'),
      where('roundId', '==', roundId),
      orderBy('timestamp', 'desc'),
      limit(50)
    );
    return onSnapshot(q, (snap) => {
      callback(snap.docs.map(d => d.data() as UserBet));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'bets');
    });
  } else {
    // Simulator: Interval polling simulator for UI responsiveness
    const timer = setInterval(() => {
      const allBets = Object.values(getSimData<Record<string, UserBet>>(SIM_BETS_KEY, {}));
      const roundBets = allBets
        .filter(b => b.roundId === roundId)
        .sort((a,b) => b.timestamp - a.timestamp);
      callback(roundBets);
    }, 1000);
    return () => clearInterval(timer);
  }
}

// Subscribe to Game History (Completed rounds list)
export function subscribeRoundsHistory(callback: (rounds: GameRound[]) => void) {
  if (isFirebaseEnabled() && db) {
    const q = query(
      collection(db, 'rounds'),
      where('status', '==', 'completed'),
      orderBy('endTime', 'desc'),
      limit(20)
    );
    return onSnapshot(q, (snap) => {
      callback(snap.docs.map(d => d.data() as GameRound));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'rounds');
    });
  } else {
    const timer = setInterval(() => {
      const allRounds = Object.values(getSimData<Record<string, GameRound>>(SIM_ROUNDS_KEY, {}));
      const completed = allRounds
        .filter(r => r.status === 'completed')
        .sort((a, b) => b.endTime - a.endTime);
      callback(completed);
    }, 1000);
    return () => clearInterval(timer);
  }
}

// Subscribe to user bets (User dashboard personal logs)
export function subscribeMyBets(userId: string, callback: (bets: UserBet[]) => void) {
  if (isFirebaseEnabled() && db) {
    const q = query(
      collection(db, 'bets'),
      where('userId', '==', userId),
      orderBy('timestamp', 'desc'),
      limit(50)
    );
    return onSnapshot(q, (snap) => {
      callback(snap.docs.map(d => d.data() as UserBet));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'bets');
    });
  } else {
    const timer = setInterval(() => {
      const allBets = Object.values(getSimData<Record<string, UserBet>>(SIM_BETS_KEY, {}));
      const personal = allBets
        .filter(b => b.userId === userId)
        .sort((a, b) => b.timestamp - a.timestamp);
      callback(personal);
    }, 1000);
    return () => clearInterval(timer);
  }
}

// Subscribe to user wallet transactions
export function subscribeMyTransactions(userId: string, callback: (txs: Transaction[]) => void) {
  if (isFirebaseEnabled() && db) {
    const q = query(
      collection(db, 'transactions'),
      where('userId', '==', userId),
      orderBy('timestamp', 'desc'),
      limit(50)
    );
    return onSnapshot(q, (snap) => {
      callback(snap.docs.map(d => d.data() as Transaction));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'transactions');
    });
  } else {
    const timer = setInterval(() => {
      const allTxs = Object.values(getSimData<Record<string, Transaction>>(SIM_TX_KEY, {}));
      const personal = allTxs
        .filter(t => t.userId === userId)
        .sort((a, b) => b.timestamp - a.timestamp);
      callback(personal);
    }, 1000);
    return () => clearInterval(timer);
  }
}
