/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import Navbar from './components/Navbar';
import AuthView from './components/AuthView';
import GameView from './components/GameView';
import WalletView from './components/WalletView';
import HistoryView from './components/HistoryView';
import AdminView from './components/AdminView';
import ToastContainer, { ToastMessage, ToastType } from './components/Toast';
import { subscribeAuth, logoutUser, UserProfile, isFirebaseEnabled } from './firebase';
import { ShieldCheck, Database, RefreshCw, Sparkles, LogOut, Info } from 'lucide-react';

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [currentView, setCurrentView] = useState<string>('dashboard');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isInitializing, setIsInitializing] = useState(true);

  // --- STATE TOASTS LIST HANDLERS ---
  const addToast = (text: string, type: ToastType) => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, text, type }]);
    
    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // --- RUNTIME AUTH SUBSCRIPTION ---
  useEffect(() => {
    const unsubscribe = subscribeAuth((profile) => {
      setUser(profile);
      setIsInitializing(false);
      
      // Auto-route on auth status shifts
      if (!profile) {
        setCurrentView('login');
      } else if (currentView === 'login') {
        setCurrentView('dashboard');
      }
    });

    return () => unsubscribe();
  }, [currentView]);

  const handleLogout = async () => {
    try {
      await logoutUser();
      addToast('Successfully signed out of the arena.', 'info');
    } catch {
      addToast('Logout error occurred.', 'error');
    }
  };

  if (isInitializing) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-dark-bg p-4 text-center">
        <div className="w-16 h-16 rounded-full border-2 border-dashed border-gold flex items-center justify-center animate-spin">
          <div className="w-8 h-8 rounded-full bg-dark-bg border border-solid border-gold-light"></div>
        </div>
        <p className="mt-6 text-sm font-mono gold-gradient-text font-bold uppercase tracking-widest animate-pulse">
          CP-Gold Engine Loading...
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col relative pb-16">
      {/* Toast Alert Provider overlays */}
      <ToastContainer toasts={toasts} onClose={removeToast} />

      {/* Global Application Navbar wrapper */}
      <Navbar 
        user={user} 
        onLogout={handleLogout} 
        onNavigate={setCurrentView} 
        currentView={currentView} 
      />

      <main className="flex-1 w-full max-w-7xl mx-auto py-2">
        {!user ? (
          <AuthView onAuthSuccess={() => setCurrentView('dashboard')} addToast={addToast} />
        ) : (
          <div>
            {currentView === 'dashboard' && <GameView user={user} addToast={addToast} />}
            {currentView === 'wallet' && <WalletView user={user} addToast={addToast} />}
            {currentView === 'history' && <HistoryView user={user} addToast={addToast} />}
            {currentView === 'admin' && user.isAdmin && <AdminView user={user} addToast={addToast} />}
          </div>
        )}
      </main>

      {/* FOOTER METRICS INFO BANNER */}
      <footer className="w-full absolute bottom-4 left-0 text-center text-zinc-550 text-[10px] font-mono select-none px-4 flex justify-center items-center gap-1.5 pointer-events-none">
        <span>© 2026 CP-Gold Predictions. All rights reserved.</span>
        <span>•</span>
        <span className="uppercase text-gold/60 font-semibold">Virtual Points Only</span>
      </footer>
    </div>
  );
}
