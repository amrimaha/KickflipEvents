
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { initSupabase, isBackendConfigured, clearSupabaseConfig, checkConnection } from '../services/supabaseClient';

interface BackendConfigModalProps {
  onClose: () => void;
  onConfigSaved: () => void;
}

export const BackendConfigModal: React.FC<BackendConfigModalProps> = ({ onClose, onConfigSaved }) => {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<'idle' | 'verifying' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    setIsConnected(isBackendConfigured());
    // Load existing values if available
    const saved = localStorage.getItem('kickflip_backend_config');
    if (saved) {
        const parsed = JSON.parse(saved);
        setUrl(parsed.url);
        setKey(parsed.key);
    }
  }, []);

  const handleConnect = async () => {
    setErrorMessage('');
    const cleanUrl = url.trim();
    const cleanKey = key.trim();

    if (!cleanUrl || !cleanKey) {
        setStatus('error');
        setErrorMessage('Both URL and Key are required.');
        return;
    }
    
    setStatus('verifying');

    // 1. Initialize Client
    const initSuccess = initSupabase(cleanUrl, cleanKey);
    if (!initSuccess) {
        setStatus('error');
        setErrorMessage('Invalid URL format.');
        return;
    }

    // 2. Verify Connection (Network Request)
    const verification = await checkConnection();
    
    if (verification.success) {
        setStatus('success');
        setTimeout(() => {
            onConfigSaved();
            onClose();
        }, 1200);
    } else {
        setStatus('error');
        setErrorMessage(verification.message || 'Connection refused. Check credentials.');
    }
  };

  const handleDisconnect = () => {
      clearSupabaseConfig();
      setIsConnected(false);
      setUrl('');
      setKey('');
      setStatus('idle');
      onConfigSaved();
  };

  const copySQL = () => {
      const sql = `create table if not exists kickflip_events (
  id text primary key,
  title text,
  category text,
  payload jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table kickflip_events enable row level security;

-- Policies (Reset to Permissive for Demo)
drop policy if exists "Public Access" on kickflip_events;
drop policy if exists "Public Insert" on kickflip_events;
drop policy if exists "Public Update" on kickflip_events;
drop policy if exists "Public Delete" on kickflip_events;

-- Allow universal read/write for this demo
create policy "Public Access" on kickflip_events for select using (true);
create policy "Public Insert" on kickflip_events for insert with check (true);
create policy "Public Update" on kickflip_events for update using (true);
create policy "Public Delete" on kickflip_events for delete using (true);

-- Enable Realtime for instant updates
alter publication supabase_realtime add table kickflip_events;`;
      navigator.clipboard.writeText(sql);
      alert("SQL copied to clipboard! Paste this in your Supabase SQL Editor.");
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/90 backdrop-blur-xl animate-in fade-in duration-300" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[#0a0a0a] border border-white/20 rounded-3xl p-8 shadow-2xl animate-in zoom-in-95 duration-300">
        
        <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-black text-white uppercase tracking-tighter">System Settings</h2>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors text-white">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>

        <div className="space-y-6">
            <div className="bg-blue-900/20 border border-blue-500/30 rounded-xl p-4">
                <h3 className="text-blue-400 font-bold text-xs uppercase tracking-widest mb-2">Sync Across Devices</h3>
                <p className="text-blue-100/70 text-sm leading-relaxed mb-3">
                    Kickflip uses <strong>Supabase</strong> for real-time global syncing. 
                </p>
                <div className="flex flex-col gap-1 text-[10px] text-blue-200/60 uppercase font-bold tracking-widest">
                    <span>1. Go to Supabase Project Settings &gt; API</span>
                    <span>2. Copy "Project URL" and "anon public" Key</span>
                    <span>3. Paste below to connect</span>
                </div>
            </div>

            <div>
                <label className="block text-[10px] font-black uppercase text-white/40 tracking-widest mb-2">Project URL</label>
                <input 
                    type="text" 
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://xyz.supabase.co"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:border-white/50 focus:outline-none transition-colors"
                />
            </div>

            <div>
                <label className="block text-[10px] font-black uppercase text-white/40 tracking-widest mb-2">Anon Public Key</label>
                <input 
                    type="password" 
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5..."
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:border-white/50 focus:outline-none transition-colors"
                />
            </div>

            {status === 'error' && (
                <div className="p-3 rounded-lg bg-red-500/20 border border-red-500/30">
                    <p className="text-xs text-red-300 font-bold">{errorMessage}</p>
                </div>
            )}

            <div className="flex gap-3 pt-2">
                <button 
                    onClick={handleConnect}
                    disabled={status === 'verifying' || status === 'success'}
                    className={`flex-1 py-4 rounded-xl font-black text-xs uppercase tracking-widest transition-all ${
                        status === 'success' 
                            ? 'bg-green-500 text-black' 
                            : status === 'error'
                                ? 'bg-red-500 text-white'
                                : 'bg-white text-black hover:scale-[1.02]'
                    } disabled:opacity-70 disabled:cursor-not-allowed`}
                >
                    {status === 'verifying' ? 'Verifying...' : status === 'success' ? 'Connected!' : status === 'error' ? 'Retry Connection' : 'Connect Database'}
                </button>
                {isConnected && (
                    <button 
                        onClick={handleDisconnect}
                        className="px-6 py-4 rounded-xl font-black text-xs uppercase tracking-widest bg-red-900/20 text-red-400 border border-red-500/20 hover:bg-red-900/40 transition-all"
                    >
                        Disconnect
                    </button>
                )}
            </div>

            <div className="border-t border-white/10 pt-6 mt-2">
                <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-white/50">Database Schema</span>
                    <button onClick={copySQL} className="text-[10px] font-bold uppercase text-indigo-400 hover:text-indigo-300 transition-colors">Copy SQL</button>
                </div>
                <div className="bg-black border border-white/10 rounded-lg p-3 overflow-hidden relative group">
                    <pre className="text-[10px] text-white/60 font-mono overflow-x-auto whitespace-pre">{`create table if not exists kickflip_events (
  id text primary key,
  ...
  -- Realtime Enabled
);`}</pre>
                </div>
            </div>
        </div>

      </div>
    </div>,
    document.body
  );
};
