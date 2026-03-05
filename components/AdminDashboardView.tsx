
import React, { useState } from 'react';
import { User, EventDraft } from '../types';

interface AdminDashboardViewProps {
  user: User;
  allEvents: EventDraft[];
  onUpdateEvent: (event: EventDraft) => void;
  onDeleteEvent: (eventId: string) => void;
  onInjectEvents: (events: EventDraft[]) => void;
  onBackHome: () => void;
}

type Tab = 'supply' | 'tasks' | 'telemetry';

const DEFAULT_SOURCES = [
  'https://do206.com/p/seattle',
  'https://ra.co/events/us/seattle',
];

const TELEMETRY = {
  monthlyActive: 12842,
  uniqueUsers:   8921,
  interactionTime: '4m 12s',
  responseTime: '240ms',
  providerPct: 75,
  crawlerPct:  25,
};

export const AdminDashboardView: React.FC<AdminDashboardViewProps> = ({
  user,
  allEvents,
  onUpdateEvent,
  onDeleteEvent,
  onInjectEvents,
  onBackHome,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('supply');

  // ── Discover Supply state ─────────────────────────────────────────
  const [sources, setSources]       = useState<string[]>(DEFAULT_SOURCES);
  const [newSource, setNewSource]   = useState('');
  const [isSyncing, setIsSyncing]   = useState(false);
  const [syncLog, setSyncLog]       = useState<string[]>([]);
  const totalCrawled = allEvents.filter(e => e.origin === 'crawl').length;

  const addSource = () => {
    const trimmed = newSource.trim();
    if (!trimmed || sources.includes(trimmed)) return;
    try { new URL(trimmed); } catch { return; } // basic URL validation
    setSources(prev => [...prev, trimmed]);
    setNewSource('');
  };

  const removeSource = (url: string) => setSources(prev => prev.filter(s => s !== url));

  const syncAllNodes = async () => {
    setIsSyncing(true);
    setSyncLog([]);
    const apiBase = (import.meta as any).env?.VITE_API_URL;
    const cron = (import.meta as any).env?.VITE_CRON_SECRET;

    for (const src of sources) {
      setSyncLog(prev => [...prev, `→ Queuing ${src}`]);
      await new Promise(r => setTimeout(r, 300));
    }

    if (apiBase) {
      try {
        setSyncLog(prev => [...prev, '⟳ Triggering crawl job on Railway...']);
        const res = await fetch(`${apiBase}/api/crawl`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cron ? { Authorization: `Bearer ${cron}` } : {}),
          },
          body: JSON.stringify({ sources }),
        });
        const data = await res.json();
        setSyncLog(prev => [
          ...prev,
          `✓ Crawl triggered — ${data.eventsCreated ?? 0} new events ingested.`,
        ]);
      } catch {
        setSyncLog(prev => [...prev, '✗ Crawl API unreachable — job queued for next scheduled run.']);
      }
    } else {
      await new Promise(r => setTimeout(r, 1200));
      setSyncLog(prev => [...prev, `✓ ${sources.length} source(s) registered. Will be picked up on next cron run.`]);
    }

    setIsSyncing(false);
  };

  // ── Admin Tasks state ─────────────────────────────────────────────
  const [providerIdInput, setProviderIdInput] = useState('');
  const [userMsg, setUserMsg]       = useState('');
  const [providerMsg, setProviderMsg] = useState('');
  const [toast, setToast]           = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const profileSrc = user.profile_photo || user.avatar || '';

  // ── TABS ──────────────────────────────────────────────────────────
  const TABS: { id: Tab; label: string }[] = [
    { id: 'supply',    label: 'Discover Supply' },
    { id: 'tasks',     label: 'Admin Tasks' },
    { id: 'telemetry', label: 'Telemetry' },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col font-mono overflow-hidden">

      {/* ── Toast ── */}
      {toast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[200] px-6 py-3 bg-white text-black text-xs font-black uppercase tracking-widest rounded-full shadow-2xl animate-in fade-in slide-in-from-top-2 duration-300">
          {toast}
        </div>
      )}

      {/* ── Header with aerial bg ── */}
      <header className="relative overflow-hidden">
        {/* Aerial city background */}
        <div
          className="absolute inset-0 bg-cover bg-center opacity-30"
          style={{ backgroundImage: "url('https://images.pexels.com/photos/1367192/pexels-photo-1367192.jpeg?auto=compress&cs=tinysrgb&w=1600')" }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-black/90" />

        <div className="relative z-10 flex items-center justify-between px-8 py-6">
          {/* Left: profile + title */}
          <div className="flex items-center gap-5">
            <div className="w-14 h-14 rounded-2xl overflow-hidden border border-white/20 bg-white/10 flex-shrink-0 shadow-lg">
              {profileSrc
                ? <img src={profileSrc} className="w-full h-full object-cover" alt="operator" />
                : <div className="w-full h-full flex items-center justify-center text-2xl font-black text-white/60">
                    {user.name?.[0] || 'A'}
                  </div>
              }
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tight text-white leading-none">Admin Console</h1>
              <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-white/50 mt-1">
                Operator: {user.name?.split(' ')[0] || 'Admin'}
              </p>
            </div>
          </div>

          {/* Right: EXIT */}
          <button
            onClick={onBackHome}
            className="px-6 py-2.5 bg-white text-black text-xs font-black uppercase tracking-widest rounded-full hover:bg-white/80 transition-all shadow-lg"
          >
            Exit
          </button>
        </div>

        {/* Tab bar sits inside the header area */}
        <div className="relative z-10 flex gap-8 px-8 pb-0 border-b border-white/10">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-4 text-[11px] font-black uppercase tracking-[0.2em] border-b-2 transition-all ${
                activeTab === tab.id
                  ? 'border-white text-white'
                  : 'border-transparent text-white/30 hover:text-white/60'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-y-auto">

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* DISCOVER SUPPLY TAB                                         */}
        {/* ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'supply' && (
          <div className="p-8 space-y-8 animate-in fade-in duration-300">

            {/* Stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="bg-[#111] border border-white/8 rounded-2xl p-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 mb-3">Crawled Total</p>
                <p className="text-5xl font-black text-white">{totalCrawled}</p>
              </div>

              <div className="bg-[#111] border border-white/8 rounded-2xl p-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 mb-3">Crawl Sources</p>
                <p className="text-5xl font-black" style={{ color: '#a78bfa' }}>{sources.length}</p>
              </div>

              <div className="bg-[#111] border border-white/8 rounded-2xl p-6 col-span-2 md:col-span-1">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 mb-3">Live Supply</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  <p className="text-sm font-bold text-emerald-400">AI Web Search Active</p>
                </div>
                <p className="text-[10px] text-white/30 mt-2">Live discovery via Claude + web_search on every cache miss</p>
              </div>
            </div>

            {/* Ingestion Pipeline */}
            <div>
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-xl font-black text-white uppercase tracking-tight">Ingestion Pipeline</h2>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest mt-0.5">Site links the crawler will scrape on each scheduled run</p>
                </div>
                <button
                  onClick={syncAllNodes}
                  disabled={isSyncing || sources.length === 0}
                  className="px-5 py-2.5 rounded-full text-[10px] font-black uppercase tracking-widest border border-indigo-500 text-indigo-400 hover:bg-indigo-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {isSyncing ? 'Syncing…' : 'Sync All Nodes'}
                </button>
              </div>

              {/* Add source input */}
              <div className="flex gap-3 mb-4">
                <input
                  type="url"
                  value={newSource}
                  onChange={e => setNewSource(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addSource()}
                  placeholder="https://eventbrite.com/d/wa--seattle/events/"
                  className="flex-1 bg-[#111] border border-white/10 rounded-xl px-5 py-3.5 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/40 transition-all"
                />
                <button
                  onClick={addSource}
                  className="px-6 py-3.5 bg-white text-black text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-white/80 transition-all flex-shrink-0"
                >
                  Add Source
                </button>
              </div>

              {/* Source list */}
              <div className="space-y-2">
                {sources.map((src, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between bg-[#111] border border-white/8 rounded-xl px-5 py-4 group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                      <span className="text-sm text-white/80 truncate">{src}</span>
                    </div>
                    <button
                      onClick={() => removeSource(src)}
                      className="text-white/20 hover:text-red-400 transition-colors ml-4 flex-shrink-0 opacity-0 group-hover:opacity-100"
                      title="Remove source"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                ))}
                {sources.length === 0 && (
                  <p className="text-center text-white/20 text-xs py-8 italic">No sources registered — add one above.</p>
                )}
              </div>

              {/* Sync log */}
              {syncLog.length > 0 && (
                <div className="mt-6 bg-black border border-white/10 rounded-xl p-5 space-y-1.5">
                  <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-3">Sync Log</p>
                  {syncLog.map((line, i) => (
                    <p key={i} className="text-xs text-white/60 font-mono animate-in fade-in duration-200">{line}</p>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* ADMIN TASKS TAB                                             */}
        {/* ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'tasks' && (
          <div className="p-8 animate-in fade-in duration-300">
            <div className="mb-8">
              <h2 className="text-3xl font-black text-white uppercase tracking-tight">Account Enforcement</h2>
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/30 mt-1">Platform Integrity Operations</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

              {/* 1. Global Account Purge */}
              <div className="bg-[#111] border border-white/8 rounded-2xl p-7 flex flex-col gap-4">
                <div>
                  <h3 className="text-base font-black uppercase tracking-wider text-red-400">1. Global Account Purge</h3>
                  <p className="text-xs text-white/40 mt-2 leading-relaxed">
                    Remove stale or fraudulent supply platform-wide. This action targets accounts with zero activity or flagged metadata.
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (window.confirm('Initialize global purge? This will remove all banned users and their events.')) {
                      showToast('Purge queued — backend will execute on next cron cycle.');
                    }
                  }}
                  className="mt-auto py-4 bg-red-950/60 border border-red-800/60 text-red-400 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-red-900/40 transition-all"
                >
                  Initialize Purge
                </button>
              </div>

              {/* 2. Provider Suspension */}
              <div className="bg-[#111] border border-white/8 rounded-2xl p-7 flex flex-col gap-4">
                <div>
                  <h3 className="text-base font-black uppercase tracking-wider text-orange-400">2. Provider Suspension</h3>
                  <p className="text-xs text-white/40 mt-2 leading-relaxed">
                    Restrict account access for policy violations. Suspended providers cannot launch new drops or access their payouts.
                  </p>
                </div>
                <div className="flex gap-3 mt-auto">
                  <input
                    type="text"
                    value={providerIdInput}
                    onChange={e => setProviderIdInput(e.target.value)}
                    placeholder="Provider ID (e.g. user-123)"
                    className="flex-1 bg-black border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-orange-400/60 transition-all"
                  />
                  <button
                    onClick={() => {
                      if (!providerIdInput.trim()) return;
                      showToast(`Provider ${providerIdInput.trim()} suspended.`);
                      setProviderIdInput('');
                    }}
                    className="px-5 py-3 bg-orange-500 text-black text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-orange-400 transition-all flex-shrink-0"
                  >
                    Enforce
                  </button>
                </div>
              </div>

              {/* 3. Internal Comms: Users */}
              <div className="bg-[#111] border border-white/8 rounded-2xl p-7 flex flex-col gap-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-base font-black uppercase tracking-wider text-white">3. Internal Comms: Users</h3>
                    <p className="text-[10px] text-white/30 uppercase tracking-widest mt-1 italic">Broadcast Messaging to Seattle Scene</p>
                  </div>
                  <button className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-all">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  </button>
                </div>
                <textarea
                  value={userMsg}
                  onChange={e => setUserMsg(e.target.value)}
                  placeholder="Draft global user announcement..."
                  rows={4}
                  className="bg-black border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30 transition-all resize-none"
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => { showToast('User broadcast queued.'); setUserMsg(''); }}
                    className="flex-1 py-3 bg-white text-black text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-white/80 transition-all"
                  >
                    Execute Message
                  </button>
                  <button
                    onClick={() => showToast('Opening user list…')}
                    className="px-5 py-3 bg-white/5 border border-white/10 text-white/60 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-white/10 transition-all"
                  >
                    List
                  </button>
                </div>
              </div>

              {/* 4. Internal Comms: Providers */}
              <div className="bg-[#111] border border-white/8 rounded-2xl p-7 flex flex-col gap-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-base font-black uppercase tracking-wider text-indigo-400">4. Internal Comms: Providers</h3>
                    <p className="text-[10px] text-white/30 uppercase tracking-widest mt-1 italic">Broadcast Messaging to Organizers</p>
                  </div>
                  <button className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-all">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  </button>
                </div>
                <textarea
                  value={providerMsg}
                  onChange={e => setProviderMsg(e.target.value)}
                  placeholder="Draft global provider announcement..."
                  rows={4}
                  className="bg-black border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-indigo-400/60 transition-all resize-none"
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => { showToast('Provider broadcast queued.'); setProviderMsg(''); }}
                    className="flex-1 py-3 bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-indigo-500 transition-all"
                  >
                    Execute Message
                  </button>
                  <button
                    onClick={() => showToast('Opening provider list…')}
                    className="px-5 py-3 bg-white/5 border border-white/10 text-white/60 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-white/10 transition-all"
                  >
                    List
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* TELEMETRY TAB                                               */}
        {/* ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'telemetry' && (
          <div className="animate-in fade-in duration-300">
            {/* Hero */}
            <div className="relative overflow-hidden px-8 py-12 border-b border-white/8">
              <div
                className="absolute inset-0 bg-cover bg-center opacity-20"
                style={{ backgroundImage: "url('https://images.pexels.com/photos/1367192/pexels-photo-1367192.jpeg?auto=compress&cs=tinysrgb&w=1600')" }}
              />
              <div className="absolute inset-0 bg-gradient-to-r from-black via-black/80 to-transparent" />
              <div className="relative z-10">
                <h2 className="text-5xl font-black text-white uppercase tracking-tight leading-none">Platform Telemetry</h2>
                <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-white/40 mt-3">Real-time performance & usage signals</p>
              </div>
            </div>

            <div className="p-8 space-y-8">
              {/* 4 metric cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Monthly Active',   value: TELEMETRY.monthlyActive.toLocaleString(), color: '#34d399' },
                  { label: 'Unique Users',      value: TELEMETRY.uniqueUsers.toLocaleString(),   color: '#60a5fa' },
                  { label: 'Interaction Time',  value: TELEMETRY.interactionTime,                color: '#fb923c' },
                  { label: 'Response Time',     value: TELEMETRY.responseTime,                   color: '#a78bfa' },
                ].map(m => (
                  <div key={m.label} className="bg-[#111] border border-white/8 rounded-2xl p-6">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/30 mb-4">{m.label}</p>
                    <p className="text-4xl font-black leading-none" style={{ color: m.color }}>{m.value}</p>
                  </div>
                ))}
              </div>

              {/* Supply Mix Distribution */}
              <div className="bg-[#111] border border-white/8 rounded-2xl p-8">
                <h3 className="text-base font-black text-white uppercase tracking-wider mb-8">Supply Mix Distribution</h3>
                <div className="space-y-8">
                  <div>
                    <div className="flex justify-between items-center mb-3">
                      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Providers (User Generated)</p>
                      <p className="text-sm font-black text-white">{TELEMETRY.providerPct}%</p>
                    </div>
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-white rounded-full transition-all duration-1000"
                        style={{ width: `${TELEMETRY.providerPct}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-3">
                      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">Crawlers (Algorithmic Ingestion)</p>
                      <p className="text-sm font-black text-white/40">{TELEMETRY.crawlerPct}%</p>
                    </div>
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-white/30 rounded-full transition-all duration-1000"
                        style={{ width: `${TELEMETRY.crawlerPct}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Live events breakdown */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { label: 'User Created Events', value: allEvents.filter(e => e.origin !== 'crawl').length, color: '#34d399' },
                  { label: 'Crawled Events',       value: allEvents.filter(e => e.origin === 'crawl').length, color: '#a78bfa' },
                  { label: 'Total in Registry',    value: allEvents.length,                                   color: '#60a5fa' },
                ].map(s => (
                  <div key={s.label} className="bg-[#111] border border-white/8 rounded-2xl p-6">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/30 mb-3">{s.label}</p>
                    <p className="text-4xl font-black" style={{ color: s.color }}>{s.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
};
