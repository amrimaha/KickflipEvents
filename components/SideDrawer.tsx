
import React from 'react';
import { ChatSession, User } from '../types';
import { VibemojiRenderer } from './Vibemojis';
import { ADMIN_EMAILS } from '../constants';
import { isBackendConfigured } from '../services/supabaseClient';

interface SideDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  chatHistory: ChatSession[];
  onSelectSession: (session: ChatSession) => void;
  onLogin: () => void;
  onLogout: () => void;
  accentColor: string;
  vibemoji: string;
  onNavigateCreate: () => void;
  onNavigateDashboard: () => void;
  onNavigateProfile?: () => void;
  onNavigateAdmin?: () => void;
  onOpenSettings: () => void; // New prop
  hasEvents: boolean;
}

export const SideDrawer: React.FC<SideDrawerProps> = ({
  isOpen,
  onClose,
  user,
  chatHistory,
  onSelectSession,
  onLogin,
  onLogout,
  accentColor,
  vibemoji,
  onNavigateCreate,
  onNavigateDashboard,
  onNavigateProfile,
  onNavigateAdmin,
  onOpenSettings,
  hasEvents
}) => {
  // Show Login button if user is null (Guest)
  const showLogin = !user;
  const isAdmin = user && ADMIN_EMAILS.includes(user.email);
  const isOnline = isBackendConfigured();
  // Strict check for system owner to show DB settings
  const isSystemOwner = user?.email === 'bryceanderson551@gmail.com';

  return (
    <>
      {/* Backdrop */}
      <div 
        className={`fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] transition-opacity duration-300 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      {/* Drawer Panel */}
      <div 
        className={`fixed top-0 left-0 h-full w-[80%] max-w-xs bg-[#111] border-r border-white/10 z-[70] transform transition-transform duration-300 ease-out flex flex-col shadow-2xl ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header / User Profile */}
        <div className="p-8 border-b border-white/10 bg-white/5">
          {!showLogin ? (
            <div 
               className="flex flex-col gap-4 cursor-pointer hover:bg-white/5 -m-4 p-4 rounded-xl transition-colors group"
               onClick={onNavigateProfile}
            >
              <div 
                className="relative w-16 h-16 rounded-full border-2 bg-white/10 flex items-center justify-center overflow-hidden shadow-lg transition-colors group-hover:border-white/40"
                style={{ borderColor: accentColor }}
              >
                 {/* Only use Vibemoji for profile for now per previous instruction */}
                 <VibemojiRenderer 
                    id={vibemoji} 
                    className="w-10 h-10 drop-shadow-md group-hover:scale-110 transition-transform"
                 />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-white text-xl font-bold truncate group-hover:text-pink-400 transition-colors">{user!.name}</h3>
                <p className="text-white/40 text-sm truncate">{user!.email}</p>
                <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/10 text-xs font-medium text-white/70">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"/>
                    Kickflip Insider
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-4">
              <h3 className="text-white font-bold text-lg mb-2">Guest Mode</h3>
              <p className="text-white/50 text-sm mb-6">Sign in to save your history and get personalized drops.</p>
              <button
                onClick={onLogin}
                className="w-full py-3 rounded-xl font-bold text-black transition-all hover:brightness-110 hover:scale-[1.02] shadow-lg"
                style={{ backgroundColor: accentColor }}
              >
                Log In / Sign Up
              </button>
            </div>
          )}
        </div>

        {/* Navigation Actions */}
        <div className="p-4 border-b border-white/10 space-y-2">
           <button 
             onClick={onNavigateCreate}
             className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-white/5 hover:bg-white/10 text-white transition-all group"
           >
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-pink-500 to-purple-500 flex items-center justify-center text-white font-bold text-lg group-hover:scale-110 transition-transform">
                +
              </div>
              <div className="text-left">
                <span className="block font-bold text-sm">Create Event</span>
                <span className="block text-xs text-white/50">Launch a drop instantly</span>
              </div>
           </button>

           {user && hasEvents && (
              <button 
                onClick={onNavigateDashboard}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-white/5 hover:bg-white/10 text-white transition-all group"
              >
                <div 
                  className="w-8 h-8 rounded-full flex items-center justify-center transition-transform group-hover:scale-110"
                  style={{ backgroundColor: accentColor }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                </div>
                <div className="text-left">
                  <span className="block font-bold text-sm">Dashboard</span>
                  <span className="block text-xs text-white/50">Your events, all in one place</span>
                </div>
              </button>
           )}

           {/* ADMIN CONSOLE LINK */}
           {isAdmin && onNavigateAdmin && (
              <button 
                onClick={onNavigateAdmin}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-white transition-all group border border-indigo-500/20"
              >
                <div className="w-8 h-8 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 bg-indigo-500 shadow-lg">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                </div>
                <div className="text-left">
                  <span className="block font-bold text-sm text-indigo-300">Admin Console</span>
                  <span className="block text-xs text-white/50">Restricted Access</span>
                </div>
              </button>
           )}
        </div>

        {/* Chat History List */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
          <h4 className="text-xs font-bold text-white/30 uppercase tracking-widest mb-2 px-2 mt-2">
            Recent Chats
          </h4>
          
          {chatHistory.length > 0 ? (
            <div className="flex flex-col gap-1">
              {chatHistory.map((session) => (
                <button
                  key={session.id}
                  onClick={() => onSelectSession(session)}
                  className="text-left px-4 py-3 rounded-lg hover:bg-white/5 transition-all group border border-transparent hover:border-white/5"
                >
                  <p 
                    className="font-medium text-sm line-clamp-1 transition-colors hover:brightness-125"
                    style={{ color: accentColor }}
                  >
                    {session.preview}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-10 text-white/20 italic text-sm px-8">
              No history yet. Start exploring Seattle to build your journal.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/10 bg-black/20 space-y-2">
           {isSystemOwner && (
             <button 
               onClick={onOpenSettings}
               className="w-full flex items-center justify-between px-4 py-3 rounded-lg text-white/60 hover:text-white hover:bg-white/5 transition-all text-xs font-bold uppercase tracking-widest border border-white/5"
             >
               <span className="flex items-center gap-2">
                   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                   System Settings
               </span>
               <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`} />
             </button>
           )}

           {!showLogin && user && (
             <button 
               onClick={onLogout}
               className="w-full flex items-center justify-center gap-2 py-3 rounded-lg text-white/40 hover:bg-red-500/10 hover:text-red-400 transition-all text-xs font-bold uppercase tracking-widest border border-transparent hover:border-red-500/20"
             >
               Log Out
             </button>
           )}
        </div>
      </div>
    </>
  );
};
