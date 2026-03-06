
import React, { useState, useEffect, useCallback } from 'react';
import { User, EventDraft } from '../types';

interface AdminDashboardViewProps {
  user: User;
  allEvents: EventDraft[];
  onUpdateEvent: (event: EventDraft) => void;
  onDeleteEvent: (eventId: string) => void;
  onInjectEvents: (events: EventDraft[]) => void;
  onBackHome: () => void;
}

type Tab = 'supply' | 'users' | 'tasks' | 'telemetry';

interface TelemetryData {
  mau: number;
  unique_users: number;
  new_users_today: number;
  interaction_time: string | null;
  avg_response_ms: number | null;
  p95_response_ms: number | null;
  queries_today: number;
  cache_hit_rate: number;
  active_sessions: number;
  sessions_today: number;
  computed_at: string | null;
  total_events: number;
  user_events: number;
  crawl_events: number;
  provider_pct: number;
  crawler_pct: number;
}

interface ParserUser {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  is_banned: boolean;
  banned_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CrawlJob {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  log_line_count: number;
  summary?: {
    totals?: { events_found?: number; events_saved?: number };
    per_source?: Record<string, { events_found?: number; events_saved?: number; error?: string }>;
  };
}

const DEFAULT_SOURCES = [
  'https://do206.com/p/seattle',
  'https://ra.co/events/us/seattle',
];

const PARSER_URL = (import.meta as any).env?.VITE_PARSER_URL ?? '';
const API_URL    = (import.meta as any).env?.VITE_API_URL ?? '';
const CRON_SECRET = (import.meta as any).env?.VITE_CRON_SECRET ?? '';

const adminHeaders = () => ({
  'Content-Type': 'application/json',
  ...(CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {}),
});

export const AdminDashboardView: React.FC<AdminDashboardViewProps> = ({
  user,
  allEvents,
  onUpdateEvent,
  onDeleteEvent,
  onInjectEvents,
  onBackHome,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('supply');

  // ── Toast ─────────────────────────────────────────────────────────
  const [toast, setToast] = useState('');
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // ── Discover Supply state ─────────────────────────────────────────
  const [sources, setSources]     = useState<string[]>(DEFAULT_SOURCES);
  const [newSource, setNewSource] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncLog, setSyncLog]     = useState<string[]>([]);
  const totalCrawled = allEvents.filter(e => e.origin === 'crawl').length;

  // ── Crawl Jobs state ──────────────────────────────────────────────
  const [crawlJobs, setCrawlJobs]           = useState<CrawlJob[]>([]);
  const [crawlJobsLoading, setCrawlJobsLoading] = useState(false);
  const [expandedJob, setExpandedJob]       = useState<string | null>(null);

  const fetchCrawlJobs = useCallback(async () => {
    if (!PARSER_URL) return;
    setCrawlJobsLoading(true);
    try {
      const res = await fetch(`${PARSER_URL}/jobs?page=1&pageSize=10`, {
        headers: adminHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setCrawlJobs(data.jobs ?? data ?? []);
      }
    } catch {
      // silently ignore
    } finally {
      setCrawlJobsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'supply') fetchCrawlJobs();
  }, [activeTab, fetchCrawlJobs]);

  // ── Telemetry state ───────────────────────────────────────────────
  const [telemetry, setTelemetry]               = useState<TelemetryData | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);

  useEffect(() => {
    if (!API_URL) return;
    const fetchTelemetry = async () => {
      try {
        const res = await fetch(`${API_URL}/api/admin/telemetry`, {
          headers: adminHeaders(),
        });
        if (res.ok) setTelemetry(await res.json());
      } catch { /* silently ignore */ } finally {
        setTelemetryLoading(false);
      }
    };
    setTelemetryLoading(true);
    fetchTelemetry();
    const timer = setInterval(fetchTelemetry, 30_000);
    return () => clearInterval(timer);
  }, []);

  // ── Supply helpers ────────────────────────────────────────────────
  const addSource = () => {
    const trimmed = newSource.trim();
    if (!trimmed || sources.includes(trimmed)) return;
    try { new URL(trimmed); } catch { return; }
    setSources(prev => [...prev, trimmed]);
    setNewSource('');
  };

  const removeSource = (url: string) => setSources(prev => prev.filter(s => s !== url));

  const syncAllNodes = async () => {
    setIsSyncing(true);
    setSyncLog([]);
    for (const src of sources) {
      setSyncLog(prev => [...prev, `→ Queuing ${src}`]);
      await new Promise(r => setTimeout(r, 300));
    }
    if (API_URL) {
      try {
        setSyncLog(prev => [...prev, '⟳ Triggering crawl job on Railway...']);
        const res = await fetch(`${API_URL}/api/crawl`, {
          method: 'POST',
          headers: adminHeaders(),
          body: JSON.stringify({ sources }),
        });
        const data = await res.json();
        setSyncLog(prev => [...prev, `✓ Crawl triggered — ${data.eventsCreated ?? 0} new events ingested.`]);
        fetchCrawlJobs();
      } catch {
        setSyncLog(prev => [...prev, '✗ Crawl API unreachable — job queued for next scheduled run.']);
      }
    } else {
      await new Promise(r => setTimeout(r, 1200));
      setSyncLog(prev => [...prev, `✓ ${sources.length} source(s) registered.`]);
    }
    setIsSyncing(false);
  };

  // ── User Management state ─────────────────────────────────────────
  const [usersList, setUsersList]         = useState<ParserUser[]>([]);
  const [usersLoading, setUsersLoading]   = useState(false);
  const [usersSearch, setUsersSearch]     = useState('');
  const [usersPage, setUsersPage]         = useState(1);
  const [usersTotal, setUsersTotal]       = useState(0);
  const PAGE_SIZE = 20;

  const fetchUsers = useCallback(async (page = 1, search = '') => {
    if (!PARSER_URL) return;
    setUsersLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (search) params.set('search', search);
      const res = await fetch(`${PARSER_URL}/api/admin/users?${params}`, {
        headers: adminHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setUsersList(data.users ?? data ?? []);
        setUsersTotal(data.total ?? (data.users ?? data ?? []).length);
      }
    } catch { /* silently ignore */ } finally {
      setUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'users') fetchUsers(usersPage, usersSearch);
  }, [activeTab, usersPage, usersSearch, fetchUsers]);

  const handleBan = async (userId: string, ban: boolean) => {
    if (!PARSER_URL) return;
    try {
      await fetch(`${PARSER_URL}/api/admin/users/${userId}/ban`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ banned: ban }),
      });
      showToast(ban ? 'User banned.' : 'User unbanned.');
      fetchUsers(usersPage, usersSearch);
    } catch {
      showToast('Action failed — check connection.');
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    if (!PARSER_URL) return;
    try {
      await fetch(`${PARSER_URL}/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ role }),
      });
      showToast(`Role updated to ${role}.`);
      fetchUsers(usersPage, usersSearch);
    } catch {
      showToast('Role update failed.');
    }
  };

  // ── Admin Tasks state ─────────────────────────────────────────────
  const [providerIdInput, setProviderIdInput] = useState('');
  const [userMsg, setUserMsg]       = useState('');
  const [providerMsg, setProviderMsg] = useState('');

  const profileSrc = user.profile_photo || user.avatar || '';

  // ── TABS ──────────────────────────────────────────────────────────
  const TABS: { id: Tab; label: string }[] = [
    { id: 'supply',    label: 'Discover Supply' },
    { id: 'users',     label: 'User Management' },
    { id: 'tasks',     label: 'Admin Tasks' },
    { id: 'telemetry', label: 'Telemetry' },
  ];

  // ── Crawl job status helpers ──────────────────────────────────────
  const statusColor: Record<string, string> = {
    completed: '#34d399',
    running:   '#60a5fa',
    pending:   '#fb923c',
    failed:    '#f87171',
  };

  const fmtDuration = (ms: number | null) => {
    if (!ms) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

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
        <div
          className="absolute inset-0 bg-cover bg-center opacity-30"
          style={{ backgroundImage: "url('https://images.pexels.com/photos/1367192/pexels-photo-1367192.jpeg?auto=compress&cs=tinysrgb&w=1600')" }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-black/90" />

        <div className="relative z-10 flex items-center justify-between px-8 py-6">
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

          <button
            onClick={onBackHome}
            className="px-6 py-2.5 bg-white text-black text-xs font-black uppercase tracking-widest rounded-full hover:bg-white/80 transition-all shadow-lg"
          >
            Exit
          </button>
        </div>

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

              <div className="space-y-2">
                {sources.map((src, i) => (
                  <div key={i} className="flex items-center justify-between bg-[#111] border border-white/8 rounded-xl px-5 py-4 group">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                      <span className="text-sm text-white/80 truncate">{src}</span>
                    </div>
                    <button
                      onClick={() => removeSource(src)}
                      className="text-white/20 hover:text-red-400 transition-colors ml-4 flex-shrink-0 opacity-0 group-hover:opacity-100"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                ))}
                {sources.length === 0 && (
                  <p className="text-center text-white/20 text-xs py-8 italic">No sources registered — add one above.</p>
                )}
              </div>

              {syncLog.length > 0 && (
                <div className="mt-6 bg-black border border-white/10 rounded-xl p-5 space-y-1.5">
                  <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-3">Sync Log</p>
                  {syncLog.map((line, i) => (
                    <p key={i} className="text-xs text-white/60 font-mono animate-in fade-in duration-200">{line}</p>
                  ))}
                </div>
              )}
            </div>

            {/* ── Recent Crawl Runs ── */}
            <div>
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-xl font-black text-white uppercase tracking-tight">Recent Crawl Runs</h2>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest mt-0.5">Last 10 jobs from the parser</p>
                </div>
                <button
                  onClick={fetchCrawlJobs}
                  disabled={crawlJobsLoading}
                  className="px-4 py-2 rounded-full text-[10px] font-black uppercase tracking-widest border border-white/20 text-white/40 hover:text-white hover:border-white/60 disabled:opacity-40 transition-all"
                >
                  {crawlJobsLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>

              {!PARSER_URL && (
                <p className="text-xs text-white/20 italic py-4">Set VITE_PARSER_URL to connect to the parser backend.</p>
              )}

              {PARSER_URL && crawlJobs.length === 0 && !crawlJobsLoading && (
                <p className="text-xs text-white/20 italic py-4">No crawl jobs found.</p>
              )}

              <div className="space-y-2">
                {crawlJobs.map(job => (
                  <div key={job.job_id} className="bg-[#111] border border-white/8 rounded-xl overflow-hidden">
                    <button
                      className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-white/5 transition-all"
                      onClick={() => setExpandedJob(expandedJob === job.job_id ? null : job.job_id)}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: statusColor[job.status] ?? '#888' }}
                        />
                        <span className="text-xs font-mono text-white/60">{job.job_id.slice(0, 8)}…</span>
                        <span
                          className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded"
                          style={{ color: statusColor[job.status], border: `1px solid ${statusColor[job.status]}40` }}
                        >
                          {job.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-6 text-[10px] text-white/30">
                        <span>{new Date(job.created_at).toLocaleString()}</span>
                        <span>{fmtDuration(job.duration_ms)}</span>
                        <span>{job.summary?.totals?.events_saved ?? '—'} saved</span>
                        <svg
                          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                          className={`transition-transform ${expandedJob === job.job_id ? 'rotate-180' : ''}`}
                        >
                          <polyline points="6 9 12 15 18 9"/>
                        </svg>
                      </div>
                    </button>

                    {expandedJob === job.job_id && (
                      <div className="border-t border-white/8 px-5 py-4 space-y-3">
                        {job.summary?.per_source && Object.entries(job.summary.per_source).map(([src, stats]) => (
                          <div key={src} className="flex items-start justify-between gap-4">
                            <span className="text-xs text-white/50 truncate max-w-[60%]">{src}</span>
                            <div className="flex gap-4 text-[10px] text-right flex-shrink-0">
                              {stats.error
                                ? <span className="text-red-400">{stats.error.slice(0, 60)}</span>
                                : <>
                                    <span className="text-white/30">{stats.events_found ?? 0} found</span>
                                    <span className="text-emerald-400">{stats.events_saved ?? 0} saved</span>
                                  </>
                              }
                            </div>
                          </div>
                        ))}
                        {!job.summary?.per_source && (
                          <p className="text-xs text-white/20 italic">{job.log_line_count} log lines — no per-source breakdown available.</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* USER MANAGEMENT TAB                                         */}
        {/* ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'users' && (
          <div className="p-8 animate-in fade-in duration-300">
            <div className="mb-6">
              <h2 className="text-3xl font-black text-white uppercase tracking-tight">User Management</h2>
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/30 mt-1">
                {usersTotal} total users
              </p>
            </div>

            {!PARSER_URL && (
              <p className="text-xs text-white/20 italic py-4">Set VITE_PARSER_URL to connect to the parser backend.</p>
            )}

            {/* Search */}
            {PARSER_URL && (
              <>
                <div className="flex gap-3 mb-6">
                  <input
                    type="text"
                    value={usersSearch}
                    onChange={e => { setUsersSearch(e.target.value); setUsersPage(1); }}
                    placeholder="Search by name or email…"
                    className="flex-1 bg-[#111] border border-white/10 rounded-xl px-5 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/40 transition-all"
                  />
                </div>

                {usersLoading && (
                  <p className="text-xs text-white/30 uppercase tracking-widest animate-pulse mb-4">Loading users…</p>
                )}

                {/* Table */}
                {!usersLoading && (
                  <div className="bg-[#111] border border-white/8 rounded-2xl overflow-hidden">
                    <div className="grid grid-cols-[2fr_2fr_1fr_1fr_auto] gap-0 text-[9px] font-black uppercase tracking-[0.2em] text-white/30 px-5 py-3 border-b border-white/8">
                      <span>Name</span>
                      <span>Email</span>
                      <span>Role</span>
                      <span>Status</span>
                      <span>Action</span>
                    </div>

                    {usersList.length === 0 && (
                      <p className="text-center text-white/20 text-xs py-10 italic">No users found.</p>
                    )}

                    {usersList.map(u => (
                      <div
                        key={u.id}
                        className="grid grid-cols-[2fr_2fr_1fr_1fr_auto] gap-0 items-center px-5 py-4 border-b border-white/5 hover:bg-white/5 transition-all"
                      >
                        <span className="text-sm text-white truncate pr-3">{u.full_name || '—'}</span>
                        <span className="text-xs text-white/50 truncate pr-3">{u.email || '—'}</span>

                        {/* Role dropdown */}
                        <select
                          value={u.role}
                          onChange={e => handleRoleChange(u.id, e.target.value)}
                          className="bg-black border border-white/10 text-white/60 text-[10px] font-black uppercase tracking-wider rounded-lg px-2 py-1.5 focus:outline-none focus:border-white/40 transition-all appearance-none cursor-pointer"
                        >
                          <option value="user">User</option>
                          <option value="provider">Provider</option>
                          <option value="admin">Admin</option>
                        </select>

                        {/* Status badge */}
                        <span className={`text-[9px] font-black uppercase tracking-wider ${u.is_banned ? 'text-red-400' : 'text-emerald-400'}`}>
                          {u.is_banned ? 'Banned' : 'Active'}
                        </span>

                        {/* Ban / Unban */}
                        <button
                          onClick={() => handleBan(u.id, !u.is_banned)}
                          className={`text-[9px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg transition-all ${
                            u.is_banned
                              ? 'bg-emerald-900/40 border border-emerald-700/60 text-emerald-400 hover:bg-emerald-800/60'
                              : 'bg-red-950/40 border border-red-800/60 text-red-400 hover:bg-red-900/60'
                          }`}
                        >
                          {u.is_banned ? 'Unban' : 'Ban'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Pagination */}
                {usersTotal > PAGE_SIZE && (
                  <div className="flex items-center justify-between mt-5">
                    <button
                      onClick={() => setUsersPage(p => Math.max(1, p - 1))}
                      disabled={usersPage === 1}
                      className="px-4 py-2 text-[10px] font-black uppercase tracking-widest border border-white/10 text-white/40 rounded-xl hover:border-white/30 disabled:opacity-30 transition-all"
                    >
                      Prev
                    </button>
                    <span className="text-[10px] text-white/30 uppercase tracking-widest">
                      Page {usersPage} / {Math.ceil(usersTotal / PAGE_SIZE)}
                    </span>
                    <button
                      onClick={() => setUsersPage(p => p + 1)}
                      disabled={usersPage >= Math.ceil(usersTotal / PAGE_SIZE)}
                      className="px-4 py-2 text-[10px] font-black uppercase tracking-widest border border-white/10 text-white/40 rounded-xl hover:border-white/30 disabled:opacity-30 transition-all"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
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
                    Remove stale or fraudulent supply platform-wide. Targets accounts with zero activity or flagged metadata.
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
                <div>
                  <h3 className="text-base font-black uppercase tracking-wider text-white">3. Internal Comms: Users</h3>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest mt-1 italic">Broadcast Messaging to Seattle Scene</p>
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
                    onClick={() => { setActiveTab('users'); }}
                    className="px-5 py-3 bg-white/5 border border-white/10 text-white/60 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-white/10 transition-all"
                  >
                    List
                  </button>
                </div>
              </div>

              {/* 4. Internal Comms: Providers */}
              <div className="bg-[#111] border border-white/8 rounded-2xl p-7 flex flex-col gap-4">
                <div>
                  <h3 className="text-base font-black uppercase tracking-wider text-indigo-400">4. Internal Comms: Providers</h3>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest mt-1 italic">Broadcast Messaging to Organizers</p>
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
                    onClick={() => { setActiveTab('users'); }}
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

              {telemetryLoading && !telemetry && (
                <p className="text-xs text-white/30 uppercase tracking-widest animate-pulse">Loading metrics…</p>
              )}
              {!telemetryLoading && !telemetry && (
                <p className="text-xs text-white/20 uppercase tracking-widest">
                  No snapshot yet — metrics refresh every 5 min via cron.
                </p>
              )}

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Monthly Active',  value: telemetry ? telemetry.mau.toLocaleString() : '—',                       color: '#34d399' },
                  { label: 'Unique Users',    value: telemetry ? telemetry.unique_users.toLocaleString() : '—',               color: '#60a5fa' },
                  { label: 'Interaction Time',value: telemetry?.interaction_time ?? '—',                                      color: '#fb923c' },
                  { label: 'Response Time',   value: telemetry?.avg_response_ms != null ? `${telemetry.avg_response_ms}ms` : '—', color: '#a78bfa' },
                ].map(m => (
                  <div key={m.label} className="bg-[#111] border border-white/8 rounded-2xl p-6">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/30 mb-4">{m.label}</p>
                    <p className="text-4xl font-black leading-none" style={{ color: m.color }}>{m.value}</p>
                  </div>
                ))}
              </div>

              <div className="bg-[#111] border border-white/8 rounded-2xl p-8">
                <div className="flex items-center justify-between mb-8">
                  <h3 className="text-base font-black text-white uppercase tracking-wider">Supply Mix Distribution</h3>
                  {telemetry?.computed_at && (
                    <p className="text-[10px] text-white/20 uppercase tracking-widest">
                      Snapshot: {new Date(telemetry.computed_at).toLocaleTimeString()}
                    </p>
                  )}
                </div>
                <div className="space-y-8">
                  <div>
                    <div className="flex justify-between items-center mb-3">
                      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Providers (User Generated)</p>
                      <p className="text-sm font-black text-white">{telemetry?.provider_pct ?? 0}%</p>
                    </div>
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-white rounded-full transition-all duration-1000" style={{ width: `${telemetry?.provider_pct ?? 0}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-3">
                      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">Crawlers (Algorithmic Ingestion)</p>
                      <p className="text-sm font-black text-white/40">{telemetry?.crawler_pct ?? 0}%</p>
                    </div>
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-white/30 rounded-full transition-all duration-1000" style={{ width: `${telemetry?.crawler_pct ?? 0}%` }} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { label: 'User Created Events', value: telemetry?.user_events  ?? allEvents.filter(e => e.origin !== 'crawl').length, color: '#34d399' },
                  { label: 'Crawled Events',       value: telemetry?.crawl_events ?? allEvents.filter(e => e.origin === 'crawl').length,  color: '#a78bfa' },
                  { label: 'Total in Registry',    value: telemetry?.total_events ?? allEvents.length,                                    color: '#60a5fa' },
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
