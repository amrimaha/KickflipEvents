
import React, { useState, useRef, useEffect } from 'react';
import { User, EventDraft, KickflipEvent, CrawlJob, VibemojiConfig } from '../types';
import { CATEGORY_COLORS, draftToEvent, getVideoForEvent } from '../constants';
import { EventCard } from './EventCard';

interface AdminDashboardViewProps {
  user: User;
  allEvents: EventDraft[];
  onUpdateEvent: (event: EventDraft) => void;
  onDeleteEvent: (eventId: string) => void;
  onInjectEvents: (events: EventDraft[]) => void;
  onBackHome: () => void;
}

type Tab = 'governance' | 'crawler' | 'users';

export const AdminDashboardView: React.FC<AdminDashboardViewProps> = ({ 
  user, 
  allEvents, 
  onUpdateEvent, 
  onDeleteEvent,
  onInjectEvents,
  onBackHome 
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('governance');
  const [jobs, setJobs] = useState<CrawlJob[]>([]);
  const [crawlUrl, setCrawlUrl] = useState('');
  const [isCrawling, setIsCrawling] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  
  // Theme for Admin Mode (System/Ops vibe)
  const adminAccent = '#6366f1'; // Indigo-500

  // --- CRAWLER LOGIC (SIMULATED) ---
  const addLog = (msg: string) => setConsoleLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const runValidationAgent = async (url: string) => {
      setIsCrawling(true);
      setConsoleLogs([]);
      addLog(`Initializing crawl job for: ${url}`);
      
      const jobId = `job-${Date.now()}`;
      const newJob: CrawlJob = {
          id: jobId,
          targetUrl: url,
          status: 'running',
          eventsFound: 0,
          eventsCreated: 0,
          logs: [],
          timestamp: Date.now()
      };
      setJobs(prev => [newJob, ...prev]);

      // Step 1: Connect
      await new Promise(r => setTimeout(r, 1500));
      addLog("Connection established. Handshaking...");
      
      // Step 2: Parse
      await new Promise(r => setTimeout(r, 2000));
      const foundCount = Math.floor(Math.random() * 5) + 3; // Random 3-8 events
      addLog(`Parsing DOM... Found ${foundCount} potential event nodes.`);
      
      // Step 3: Validate
      addLog("Starting Validation Agent v2.1...");
      const validEvents: EventDraft[] = [];
      const category = url.includes('ticketmaster') ? 'sports' : url.includes('ra.co') ? 'music' : 'other';
      const sourceName = new URL(url).hostname.replace('www.', '');

      for (let i = 0; i < foundCount; i++) {
          await new Promise(r => setTimeout(r, 800)); // Simulate processing time per item
          const isInvalid = Math.random() > 0.8; // 20% failure rate
          
          if (isInvalid) {
              addLog(`WARN: Event node #${i+1} rejected. Reason: Date in past or missing location.`);
          } else {
              addLog(`INFO: Event node #${i+1} validated. Schema integrity: 100%.`);
              
              // Generate Mock Event
              const daysFromNow = Math.floor(Math.random() * 30);
              const eventDate = new Date();
              eventDate.setDate(eventDate.getDate() + daysFromNow);
              
              const mockEvent: EventDraft = {
                  id: `crawl-${Date.now()}-${i}`,
                  concept: 'Imported via Admin Crawler',
                  title: `Imported Event ${i+1} @ ${sourceName}`,
                  category: category as any,
                  vibeDescription: `A curated event ingested from ${sourceName}. Visit their site for tickets.`,
                  tone: 'minimal',
                  locationName: 'Seattle Venue TBD',
                  address: 'Seattle, WA',
                  startDate: eventDate.toISOString().split('T')[0],
                  startTime: '20:00',
                  endDate: eventDate.toISOString().split('T')[0],
                  endTime: '23:00',
                  isFree: false,
                  price: 'See Site',
                  isUnlimitedCapacity: true,
                  capacity: 0,
                  overview: `This event was automatically discovered by Kickflip's crawler from ${url}.`,
                  collaborators: [],
                  providerName: sourceName,
                  socialLinks: {},
                  media: [], // No media initially, uses iframe fallback logic
                  vibemoji: { baseId: 'bolt', primaryColor: '#6366f1' },
                  themeColor: '#6366f1',
                  status: 'active',
                  ticketsSold: 0,
                  origin: 'crawl',
                  crawlSource: sourceName,
                  iframeUrl: url
              };
              validEvents.push(mockEvent);
          }
      }

      // Step 4: Finalize
      addLog(`Validation complete. ${validEvents.length} events ready for ingestion.`);
      onInjectEvents(validEvents);
      
      setJobs(prev => prev.map(j => j.id === jobId ? { 
          ...j, 
          status: 'completed', 
          eventsFound: foundCount, 
          eventsCreated: validEvents.length 
      } : j));
      
      setIsCrawling(false);
      setCrawlUrl('');
  };

  return (
    <div className="min-h-screen bg-[#050505] text-slate-200 font-mono flex flex-col">
       {/* Admin Header */}
       <header className="p-6 border-b border-indigo-500/20 bg-indigo-950/10 flex justify-between items-center backdrop-blur-md sticky top-0 z-50">
          <div className="flex items-center gap-4">
             <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(99,102,241,0.5)]">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
             </div>
             <div>
                <h1 className="text-xl font-bold tracking-tight text-white">Kickflip Ops</h1>
                <p className="text-[10px] uppercase tracking-widest text-indigo-400">System Admin & Governance</p>
             </div>
          </div>
          <div className="flex gap-4">
             <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded bg-green-900/20 border border-green-500/30">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                <span className="text-[10px] font-bold text-green-400">SYSTEM HEALTHY</span>
             </div>
             <button onClick={onBackHome} className="text-xs font-bold hover:text-white transition-colors">EXIT CONSOLE</button>
          </div>
       </header>

       {/* Tabs */}
       <div className="border-b border-white/5 bg-black/40">
          <div className="flex">
             {[
               { id: 'governance', label: 'Event Governance' },
               { id: 'crawler', label: 'Web Crawler Agent' },
               { id: 'users', label: 'User Management' }
             ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as Tab)}
                  className={`px-8 py-4 text-xs font-bold uppercase tracking-wider transition-all border-b-2 ${
                     activeTab === tab.id 
                       ? 'border-indigo-500 text-white bg-indigo-500/10' 
                       : 'border-transparent text-slate-500 hover:text-slate-300'
                  }`}
                >
                   {tab.label}
                </button>
             ))}
          </div>
       </div>

       {/* Main Content */}
       <main className="flex-1 p-6 md:p-10 max-w-7xl mx-auto w-full overflow-y-auto">
          
          {/* --- GOVERNANCE TAB --- */}
          {activeTab === 'governance' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex justify-between items-end">
                   <h2 className="text-2xl font-bold text-white">Event Registry</h2>
                   <div className="text-xs text-slate-500">Total Records: {allEvents.length}</div>
                </div>
                
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                   {allEvents.map(draft => {
                      const evt = draftToEvent(draft);
                      return (
                         <div key={draft.id} className="bg-[#0a0a0a] border border-white/10 rounded-xl overflow-hidden flex flex-col group relative hover:border-indigo-500/50 transition-colors">
                            {/* Visual Header */}
                            <div className="h-32 bg-gray-900 relative">
                               {evt.videoUrl ? (
                                  <video src={evt.videoUrl} className="w-full h-full object-cover opacity-50" muted loop autoPlay />
                               ) : (
                                  <img src={evt.imageUrl || 'https://images.pexels.com/photos/1105666/pexels-photo-1105666.jpeg'} className="w-full h-full object-cover opacity-50" />
                               )}
                               <div className="absolute top-2 right-2">
                                  <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${draft.origin === 'crawl' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                     {draft.origin || 'user'}
                                  </span>
                               </div>
                            </div>
                            
                            {/* Content */}
                            <div className="p-4 flex-1 flex flex-col gap-2">
                               <h3 className="font-bold text-white leading-tight">{evt.title}</h3>
                               <p className="text-xs text-slate-400">{evt.date} • {evt.location}</p>
                               <div className="mt-auto pt-4 flex gap-2">
                                  <button 
                                    onClick={() => onDeleteEvent(draft.id)}
                                    className="flex-1 py-2 bg-red-900/20 border border-red-500/30 text-red-400 text-[10px] font-bold uppercase rounded hover:bg-red-900/40 transition-all"
                                  >
                                     Purge
                                  </button>
                                  <button className="flex-1 py-2 bg-slate-800 border border-slate-700 text-slate-300 text-[10px] font-bold uppercase rounded hover:bg-slate-700 transition-all">
                                     Suspend
                                  </button>
                               </div>
                            </div>
                         </div>
                      );
                   })}
                </div>
             </div>
          )}

          {/* --- CRAWLER TAB --- */}
          {activeTab === 'crawler' && (
             <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 h-full animate-in fade-in slide-in-from-bottom-4 duration-500">
                {/* Configuration Panel */}
                <div className="lg:col-span-1 space-y-6">
                   <div className="bg-[#0a0a0a] border border-white/10 rounded-2xl p-6">
                      <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-widest mb-4">Job Configuration</h3>
                      <div className="space-y-4">
                         <div>
                            <label className="block text-[10px] text-slate-500 uppercase font-bold mb-2">Target URL</label>
                            <input 
                               type="text" 
                               value={crawlUrl}
                               onChange={(e) => setCrawlUrl(e.target.value)}
                               placeholder="https://ticketmaster.com/seattle..."
                               className="w-full bg-black border border-white/20 rounded-lg px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors placeholder-slate-700"
                            />
                         </div>
                         <div>
                            <label className="block text-[10px] text-slate-500 uppercase font-bold mb-2">Scope</label>
                            <select className="w-full bg-black border border-white/20 rounded-lg px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500">
                               <option>Seattle Area (Strict)</option>
                               <option>Greater Washington</option>
                               <option>Global (Debug)</option>
                            </select>
                         </div>
                         <div className="pt-4">
                            <button 
                               onClick={() => runValidationAgent(crawlUrl)}
                               disabled={!crawlUrl || isCrawling}
                               className="w-full py-4 bg-indigo-600 text-white font-bold rounded-lg uppercase tracking-widest text-xs hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-indigo-900/20"
                            >
                               {isCrawling ? 'Agent Running...' : 'Start Crawl Job'}
                            </button>
                         </div>
                      </div>
                   </div>

                   {/* Job History */}
                   <div className="bg-[#0a0a0a] border border-white/10 rounded-2xl p-6 flex-1">
                      <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">Job History</h3>
                      <div className="space-y-3">
                         {jobs.map(job => (
                            <div key={job.id} className="flex justify-between items-center p-3 rounded bg-white/5 border border-white/5">
                               <div>
                                  <div className="flex items-center gap-2">
                                     <span className={`w-1.5 h-1.5 rounded-full ${job.status === 'completed' ? 'bg-green-500' : job.status === 'running' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`}></span>
                                     <span className="text-xs font-bold text-white truncate max-w-[120px]">{job.targetUrl}</span>
                                  </div>
                                  <p className="text-[10px] text-slate-500 mt-1">{new Date(job.timestamp).toLocaleTimeString()}</p>
                               </div>
                               <div className="text-right">
                                  <p className="text-xs font-bold text-white">+{job.eventsCreated}</p>
                                  <p className="text-[10px] text-slate-500">Events</p>
                               </div>
                            </div>
                         ))}
                         {jobs.length === 0 && <p className="text-xs text-slate-600 italic text-center py-4">No jobs run this session.</p>}
                      </div>
                   </div>
                </div>

                {/* Console / Output */}
                <div className="lg:col-span-2 flex flex-col h-[600px] bg-black border border-white/10 rounded-2xl overflow-hidden relative shadow-2xl">
                   <div className="bg-gray-900/50 p-3 border-b border-white/10 flex justify-between items-center">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Agent Terminal Output</span>
                      <div className="flex gap-1.5">
                         <div className="w-2.5 h-2.5 rounded-full bg-red-500/20 border border-red-500/50"></div>
                         <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/20 border border-yellow-500/50"></div>
                         <div className="w-2.5 h-2.5 rounded-full bg-green-500/20 border border-green-500/50"></div>
                      </div>
                   </div>
                   <div className="flex-1 p-6 font-mono text-xs overflow-y-auto custom-scrollbar space-y-2">
                      <div className="text-indigo-400 mb-4">Kickflip Validation Agent v2.1.0 initialized...</div>
                      {consoleLogs.map((log, i) => (
                         <div key={i} className="text-slate-300 border-l-2 border-indigo-500/30 pl-3 py-0.5 animate-in fade-in slide-in-from-left-2 duration-300">
                            {log}
                         </div>
                      ))}
                      {isCrawling && (
                         <div className="text-slate-500 animate-pulse">_</div>
                      )}
                   </div>
                </div>
             </div>
          )}

          {/* --- USER MANAGEMENT TAB (MOCK) --- */}
          {activeTab === 'users' && (
             <div className="bg-[#0a0a0a] border border-white/10 rounded-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <h2 className="text-xl font-bold text-white mb-6">Active Users</h2>
                <table className="w-full text-left">
                   <thead>
                      <tr className="border-b border-white/10 text-[10px] font-bold uppercase text-slate-500 tracking-widest">
                         <th className="pb-4">User</th>
                         <th className="pb-4">Email</th>
                         <th className="pb-4">Status</th>
                         <th className="pb-4 text-right">Actions</th>
                      </tr>
                   </thead>
                   <tbody className="divide-y divide-white/5">
                      <tr className="group hover:bg-white/5 transition-colors">
                         <td className="py-4 text-sm font-bold text-white">{user.name} (You)</td>
                         <td className="py-4 text-sm text-slate-400">{user.email}</td>
                         <td className="py-4"><span className="px-2 py-1 bg-indigo-500/20 text-indigo-300 rounded text-[10px] font-bold uppercase">Admin</span></td>
                         <td className="py-4 text-right"><span className="text-slate-600 text-xs italic">Protected</span></td>
                      </tr>
                      {/* Mocks */}
                      {[1,2,3].map(i => (
                         <tr key={i} className="group hover:bg-white/5 transition-colors">
                            <td className="py-4 text-sm font-bold text-white">User {9000+i}</td>
                            <td className="py-4 text-sm text-slate-400">user{9000+i}@example.com</td>
                            <td className="py-4"><span className="px-2 py-1 bg-green-500/20 text-green-300 rounded text-[10px] font-bold uppercase">Active</span></td>
                            <td className="py-4 text-right">
                               <button className="text-xs text-red-400 hover:underline font-bold" onClick={() => alert('Mock Ban Action')}>BAN</button>
                            </td>
                         </tr>
                      ))}
                   </tbody>
                </table>
             </div>
          )}

       </main>
    </div>
  );
};
