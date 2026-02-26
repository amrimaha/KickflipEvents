
import React, { useState, useMemo } from 'react';
import { User, EventDraft, VibemojiConfig } from '../types';
import { EventVibemojiRenderer } from './EventVibemojiRenderer';
import { createPortal } from 'react-dom';
import { VideoBackground } from './VideoBackground';
import { EventCard } from './EventCard';
import { IdentityCustomizer } from './IdentityCustomizer';
import { draftToEvent } from '../constants';

interface DashboardViewProps {
  user: User;
  createdEvents: EventDraft[];
  onBackHome: () => void;
  onConnectStripe?: () => void;
  brandIdentity: VibemojiConfig;
  onUpdateBrand: (config: VibemojiConfig) => void;
  onEditEvent: (event: EventDraft) => void;
  onViewPublicPage: (event: EventDraft) => void;
  onDownloadGuestList: (event: EventDraft) => void;
  onDeleteEvent: (eventId: string) => void;
}

type Tab = 'summary' | 'events' | 'payments';

export const DashboardView: React.FC<DashboardViewProps> = ({ 
  user, 
  createdEvents, 
  onBackHome, 
  brandIdentity,
  onUpdateBrand,
  onConnectStripe,
  onEditEvent,
  onViewPublicPage,
  onDownloadGuestList,
  onDeleteEvent
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [selectedEvent, setSelectedEvent] = useState<EventDraft | null>(null);
  const [isIdentityModalOpen, setIsIdentityModalOpen] = useState(false);
  const [isStripeOnboardingOpen, setIsStripeOnboardingOpen] = useState(false);
  
  const accentColor = brandIdentity.primaryColor || '#34d399';
  const dashboardFont = brandIdentity.font || 'font-sans';
  const backgroundType = brandIdentity.backgroundType || 'image';
  const backgroundUrl = brandIdentity.backgroundUrl || 'https://images.pexels.com/photos/3165335/pexels-photo-3165335.jpeg';

  // --- STATS CALCULATION ---
  const stats = useMemo(() => {
    const lifetimeRevenue = createdEvents.reduce((acc, curr) => acc + (curr.ticketsSold * parseFloat(curr.price || '0')), 0);
    const lifetimeTickets = createdEvents.reduce((acc, curr) => acc + curr.ticketsSold, 0);
    const avgPrice = createdEvents.length ? lifetimeRevenue / createdEvents.length : 0;
    
    return {
      lifetimeRevenue,
      lifetimeTickets,
      totalCreated: createdEvents.length,
      avgPrice
    };
  }, [createdEvents]);

  const groupedEvents = useMemo(() => {
    const now = new Date();
    const isPast = (e: EventDraft) => {
        if (e.status === 'completed') return true;
        if (e.status === 'draft') return false;
        if (e.endDate) {
            const dateTimeStr = `${e.endDate}T${e.endTime || '23:59'}`;
            return new Date(dateTimeStr) < now;
        }
        return false;
    };
    return {
      active: createdEvents.filter(e => e.status === 'active' && !isPast(e)),
      draft: createdEvents.filter(e => e.status === 'draft'),
      past: createdEvents.filter(e => isPast(e)).map(e => e.status === 'active' ? { ...e, status: 'completed' as const } : e)
    };
  }, [createdEvents]);

  const handleCompleteStripe = () => {
    setIsStripeOnboardingOpen(false);
    if (onConnectStripe) onConnectStripe();
  };

  const renderTabTrigger = (id: Tab, label: string) => (
    <button
      onClick={() => setActiveTab(id)}
      className={`px-8 py-4 text-xs font-black uppercase tracking-[0.2em] border-b-4 transition-all ${
        activeTab === id ? 'text-white border-white' : 'text-white/60 border-transparent hover:text-white'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className={`min-h-screen bg-black text-white flex flex-col transition-all duration-500 overflow-x-hidden ${dashboardFont}`}>
      
      {backgroundType === 'video' ? (
        <VideoBackground key={backgroundUrl} src={backgroundUrl} isOverlayDark={true} />
      ) : (
        <div className="fixed inset-0 w-full h-full overflow-hidden z-0 bg-black">
           <img src={backgroundUrl} alt="Background" className="absolute inset-0 w-full h-full object-cover animate-in fade-in duration-1000 opacity-40" />
           <div className="absolute inset-0 bg-black/60" />
        </div>
      )}

      <div className="relative z-10 flex flex-col min-h-screen">
          <header className="p-8 md:p-14 border-b border-white/5 flex flex-col md:flex-row justify-between items-center md:items-end bg-black/40 backdrop-blur-3xl gap-8">
            <div className="flex items-center gap-8">
               <div 
                 className="w-24 h-24 rounded-[2rem] border-2 border-white/10 overflow-hidden bg-white/5 flex items-center justify-center p-2 group cursor-pointer relative hover:border-white/40 transition-all shadow-2xl"
                 onClick={() => setIsIdentityModalOpen(true)}
               >
                  {brandIdentity.logoUrl ? (
                    <img src={brandIdentity.logoUrl} alt="Brand Logo" className="w-full h-full object-contain group-hover:scale-110 transition-transform duration-500" />
                  ) : (
                    <EventVibemojiRenderer config={brandIdentity} className="w-full h-full group-hover:scale-110 transition-transform duration-500" />
                  )}
               </div>
               <div>
                  <h1 className="text-4xl md:text-7xl font-black tracking-tighter leading-none uppercase">My Kickflip Dashboard</h1>
                  <div className="mt-4 flex items-center gap-3">
                     <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.5)]" />
                     <p className="text-white/80 text-xs font-black uppercase tracking-[0.4em]">{user.name}</p>
                  </div>
               </div>
            </div>
            <div className="flex gap-4">
               <button 
                 onClick={() => setIsIdentityModalOpen(true)}
                 className="px-6 py-3 rounded-2xl bg-white/5 border border-white/10 font-black text-[10px] uppercase tracking-widest hover:bg-white/10 transition-all text-white/80"
               >
                 Customize Brand
               </button>
               <button 
                 onClick={onBackHome}
                 className="px-8 py-4 rounded-2xl bg-white text-black font-black text-[10px] uppercase tracking-[0.2em] hover:scale-105 active:scale-95 transition-all shadow-xl shadow-white/5"
               >
                 Exit Dashboard
               </button>
            </div>
          </header>

          <nav className="flex px-8 md:px-14 border-b border-white/5 bg-black/60 backdrop-blur-2xl sticky top-0 z-40">
             {renderTabTrigger('summary', 'Summary')}
             {renderTabTrigger('events', 'Your Events')}
             {renderTabTrigger('payments', 'Payments $$')}
          </nav>

          <main className="flex-1 p-8 md:p-14 max-w-7xl mx-auto w-full pb-40">
             {activeTab === 'summary' && (
                <div className="space-y-14 animate-in fade-in slide-in-from-bottom-8 duration-700">
                   
                   <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                      <SummaryStatTile label="Lifetime Revenue" value={`$${stats.lifetimeRevenue.toLocaleString()}`} accent={accentColor} delay="delay-100" />
                      <SummaryStatTile label="Tickets Sold" value={stats.lifetimeTickets.toLocaleString()} accent={accentColor} delay="delay-200" />
                      <SummaryStatTile label="Events Created" value={stats.totalCreated.toString()} accent={accentColor} delay="delay-300" />
                   </div>
                   <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                      <div className="lg:col-span-2 bg-black/40 backdrop-blur-xl border border-white/10 rounded-[3rem] p-12 relative overflow-hidden group shadow-2xl">
                         <div className="absolute -top-10 -right-10 w-64 h-64 bg-white/5 blur-3xl rounded-full group-hover:bg-white/10 transition-all duration-1000" />
                         <h3 className="text-[10px] font-black mb-12 uppercase tracking-[0.4em] text-white/70">Business Health</h3>
                         <div className="grid grid-cols-1 sm:grid-cols-2 gap-12">
                            <SimpleInsight label="Top Age Group" value="21–25" sub="42% of total dropouts" />
                            <SimpleInsight label="Top District" value="Capitol Hill" sub="Highest ticket conversion" />
                            <SimpleInsight label="Returning Guests" value="38%" sub="+4% from last drop" />
                            <SimpleInsight label="Avg Ticket Cost" value={`$${stats.avgPrice.toFixed(0)}`} sub="Competitive for category" />
                         </div>
                      </div>
                      <div 
                        className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-[3rem] p-12 flex flex-col items-center justify-center text-center group cursor-pointer hover:border-white/30 transition-all shadow-2xl"
                        onClick={() => setIsIdentityModalOpen(true)}
                      >
                         <div className="w-24 h-24 mb-8 relative">
                            <div className="absolute inset-0 bg-white/10 rounded-full blur-2xl animate-pulse" />
                            {brandIdentity.logoUrl ? (
                                <img src={brandIdentity.logoUrl} alt="Logo" className="w-full h-full object-contain relative z-10 group-hover:scale-110 transition-transform duration-500" />
                            ) : (
                                <EventVibemojiRenderer config={brandIdentity} className="w-full h-full relative z-10 group-hover:rotate-12 transition-transform duration-500" />
                            )}
                         </div>
                         <h4 className="text-xl font-black mb-2 tracking-tighter text-white">Identity Widget</h4>
                         <p className="text-xs text-white/70 leading-relaxed max-w-[180px] mb-8 uppercase font-bold tracking-widest">Global brand vibe across Kickflip</p>
                         <button className="text-[9px] font-black uppercase tracking-[0.3em] px-6 py-3 border border-white/10 rounded-full hover:bg-white hover:text-black transition-all">Adjust Brand</button>
                      </div>
                   </div>
                </div>
             )}

             {activeTab === 'events' && (
                <div className="space-y-24 animate-in fade-in slide-in-from-bottom-8 duration-700">
                   <EventDeck title="Active Drops" events={groupedEvents.active} count={groupedEvents.active.length} onEventClick={setSelectedEvent} accent={accentColor} onDeleteEvent={onDeleteEvent} />
                   <EventDeck title="Draft Sessions" events={groupedEvents.draft} count={groupedEvents.draft.length} onEventClick={setSelectedEvent} accent={accentColor} onDeleteEvent={onDeleteEvent} />
                   <EventDeck title="Completed" events={groupedEvents.past} count={groupedEvents.past.length} onEventClick={setSelectedEvent} accent={accentColor} onDeleteEvent={onDeleteEvent} />
                </div>
             )}

             {activeTab === 'payments' && (
                <div className="space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-700">
                   <div className="flex flex-col md:flex-row justify-between items-center bg-black/40 backdrop-blur-xl border border-white/10 rounded-[3rem] p-12 gap-8 shadow-2xl">
                      <div className="flex items-center gap-8">
                         <div className="w-20 h-20 rounded-[2rem] bg-indigo-600 flex items-center justify-center shadow-[0_0_40px_rgba(79,70,229,0.3)] overflow-hidden">
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                         </div>
                         <div>
                            <h4 className="text-3xl font-black tracking-tighter text-white">Stripe Gateway</h4>
                            <p className="text-white/70 text-xs font-bold uppercase tracking-[0.2em] mt-2">
                               {user.stripeConnected ? 'CONNECTED & VERIFIED' : 'ACTION REQUIRED: ONBOARDING PENDING'}
                            </p>
                         </div>
                      </div>
                      {!user.stripeConnected && (
                         <button 
                           onClick={() => setIsStripeOnboardingOpen(true)}
                           className="px-10 py-5 bg-white text-black font-black rounded-2xl hover:scale-105 active:scale-95 transition-all text-xs uppercase tracking-[0.2em] shadow-xl shadow-indigo-500/10"
                         >
                            Connect Account
                         </button>
                      )}
                      {user.stripeConnected && (
                         <div className="flex items-center gap-2 px-6 py-4 rounded-2xl bg-green-500/10 border border-green-500/20">
                            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            <span className="text-xs font-black text-green-500 uppercase tracking-widest">Linked & Ready</span>
                         </div>
                      )}
                   </div>
                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                      <MiniFinancialTile label="Projected" value={`$${(stats.lifetimeRevenue * 1.1).toFixed(0)}`} sub="Book of business" />
                      <MiniFinancialTile label="Transferred" value={`$${(stats.lifetimeRevenue * 0.9).toFixed(0)}`} sub="Verified payouts" />
                      <MiniFinancialTile label="Next Payment" value={`$${(stats.lifetimeRevenue * 0.25).toFixed(0)}`} sub="Rev this period" />
                      <MiniFinancialTile label="Next Payout" value="Scheduled" sub="Est. Nov 20th" />
                   </div>
                   <div className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-[3rem] overflow-hidden shadow-2xl">
                      <div className="p-12 border-b border-white/10">
                         <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-white/70">Payout Activity</h3>
                      </div>
                      <div className="overflow-x-auto">
                         <table className="w-full text-left">
                            <thead>
                               <tr className="bg-white/5 text-[9px] uppercase font-black text-white/70 tracking-[0.3em]">
                                  <th className="px-12 py-6">Drop Title</th>
                                  <th className="px-12 py-6 text-center">Tix</th>
                                  <th className="px-12 py-6 text-right">Gross</th>
                                  <th className="px-12 py-6 text-right">Net</th>
                                  <th className="px-12 py-6 text-right">State</th>
                               </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                               {createdEvents.map((evt, i) => {
                                  const gross = evt.ticketsSold * parseFloat(evt.price || '0');
                                  const net = gross * 0.92;
                                  return (
                                     <tr key={i} className="hover:bg-white/5 transition-colors group">
                                        <td className="px-12 py-6 font-black text-sm tracking-tight group-hover:text-pink-400 transition-colors text-white">{evt.title}</td>
                                        <td className="px-12 py-6 text-center font-mono text-sm text-white/90">{evt.ticketsSold}</td>
                                        <td className="px-12 py-6 text-right font-mono text-sm text-white/90">${gross.toFixed(2)}</td>
                                        <td className="px-12 py-6 text-right font-mono text-sm text-green-400 font-black">${net.toFixed(2)}</td>
                                        <td className="px-12 py-6 text-right">
                                           <span className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-[0.2em] ${evt.payoutStatus === 'paid' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-500'}`}>
                                              {evt.payoutStatus || 'pending'}
                                           </span>
                                        </td>
                                     </tr>
                                  );
                               })}
                            </tbody>
                         </table>
                      </div>
                   </div>
                </div>
             )}
          </main>
      </div>

      {isIdentityModalOpen && (
        <IdentityCustomizer 
          config={brandIdentity} 
          onUpdate={onUpdateBrand} 
          onClose={() => setIsIdentityModalOpen(false)} 
        />
      )}

      {isStripeOnboardingOpen && (
         <StripeOnboardingSimulation onComplete={handleCompleteStripe} onCancel={() => setIsStripeOnboardingOpen(false)} />
      )}

      {selectedEvent && (
         <EventDetailOverlay 
            event={selectedEvent} 
            accentColor={accentColor} 
            onClose={() => setSelectedEvent(null)}
            onEdit={() => { onEditEvent(selectedEvent); setSelectedEvent(null); }}
            onViewPublic={() => onViewPublicPage(selectedEvent)}
            onDownloadGuestList={() => onDownloadGuestList(selectedEvent)}
         />
      )}
    </div>
  );
};

// --- SUBCOMPONENTS ---

const SummaryStatTile = ({ label, value, accent, delay }: { label: string, value: string, accent: string, delay: string }) => (
  <div className={`bg-black/40 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-10 flex flex-col justify-between h-64 relative overflow-hidden group hover:border-white/30 transition-all shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-700 ${delay}`}>
      <div className="absolute top-0 right-0 p-8 opacity-20 group-hover:opacity-40 transition-opacity">
         <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
      </div>
      <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-white/60">{label}</h3>
      <p className="text-5xl md:text-6xl font-black tracking-tighter text-white drop-shadow-lg" style={{ color: accent }}>{value}</p>
      <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden mt-4">
         <div className="h-full bg-white/20 w-2/3 rounded-full" style={{ backgroundColor: accent }} />
      </div>
  </div>
);

const SimpleInsight = ({ label, value, sub }: { label: string, value: string, sub: string }) => (
   <div>
      <h4 className="text-[9px] font-black uppercase tracking-[0.3em] text-white/40 mb-2">{label}</h4>
      <p className="text-2xl font-black text-white tracking-tight mb-1">{value}</p>
      <p className="text-xs text-white/60 font-medium">{sub}</p>
   </div>
);

const EventDeck = ({ title, events, count, onEventClick, accent, onDeleteEvent }: { title: string, events: EventDraft[], count: number, onEventClick: (e: EventDraft) => void, accent: string, onDeleteEvent: (id: string) => void }) => (
   <div>
      <div className="flex items-end gap-4 mb-8 px-2">
         <h2 className="text-3xl font-black tracking-tighter text-white uppercase">{title}</h2>
         <span className="text-sm font-black text-white/40 mb-1.5">{count.toString().padStart(2, '0')}</span>
      </div>
      {events.length > 0 ? (
         <div className="flex gap-8 overflow-x-auto no-scrollbar pb-16 snap-x px-4">
             {events.map((draft) => {
                 const kickflipEvent = draftToEvent(draft);
                 return (
                     <EventCard
                        key={draft.id}
                        event={kickflipEvent}
                        className="w-96 h-[34rem] snap-center"
                        onClick={() => onEventClick(draft)}
                        // Inject Delete Button in Action Slot
                        actionSlot={
                            <button 
                                className="p-3 bg-red-600 text-white rounded-full hover:bg-red-500 hover:scale-110 transition-all shadow-xl opacity-0 group-hover:opacity-100"
                                onClick={(e) => { e.stopPropagation(); if(confirm('Delete event?')) onDeleteEvent(draft.id); }}
                                title="Delete Event"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        }
                        // Inject Dashboard Stats in Content Area
                        extraContent={
                            <div className="grid grid-cols-2 gap-3 p-4 bg-white/5 rounded-2xl border border-white/5 group-hover:bg-white/10 transition-colors">
                                <div>
                                    <p className="text-[9px] font-black uppercase tracking-widest text-white/30 mb-1">Date</p>
                                    <p className="text-sm font-bold text-white">{draft.startDate ? new Date(draft.startDate).toLocaleDateString('en-US', {month:'short', day:'numeric'}) : 'TBD'}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-[9px] font-black uppercase tracking-widest text-white/30 mb-1">Sales</p>
                                    <div className="flex items-center justify-end gap-1">
                                        <span className="text-sm font-bold" style={{color: accent}}>{draft.ticketsSold}</span>
                                        <span className="text-[10px] text-white/30 font-bold">/ {draft.isUnlimitedCapacity ? '∞' : draft.capacity}</span>
                                    </div>
                                </div>
                            </div>
                        }
                     />
                 );
             })}
         </div>
      ) : (
         <div className="w-full h-64 flex flex-col gap-4 items-center justify-center border-2 border-dashed border-white/10 rounded-[2.5rem] text-white/30">
            <div className="p-4 bg-white/5 rounded-full"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
            <p className="text-xs font-black uppercase tracking-[0.2em]">No Events Found</p>
         </div>
      )}
   </div>
);

const MiniFinancialTile = ({ label, value, sub }: { label: string, value: string, sub: string }) => (
    <div className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-[2rem] p-8 flex flex-col justify-center shadow-lg">
       <h4 className="text-[9px] font-black uppercase tracking-[0.2em] text-white/40 mb-2">{label}</h4>
       <p className="text-2xl font-black text-white tracking-tight mb-1">{value}</p>
       <p className="text-[10px] text-white/60 font-medium">{sub}</p>
    </div>
);

const StripeOnboardingSimulation = ({ onComplete, onCancel }: { onComplete: () => void, onCancel: () => void }) => createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
        <div className="absolute inset-0 bg-black/90 backdrop-blur-xl animate-in fade-in duration-300" onClick={onCancel} />
        <div className="relative w-full max-w-md bg-white text-black rounded-3xl p-8 shadow-2xl animate-in zoom-in-95 duration-300">
             <div className="flex justify-center mb-6 text-[#635bff]">
                <svg width="60" height="60" viewBox="0 0 24 24" fill="currentColor"><path d="M13.976 9.15c-2.172-.806-4.029-1.564-4.029-3.266 0-1.114.992-1.905 2.656-1.905 2.375 0 3.737.942 4.675 2.454l3.14-2.162C18.667 1.847 16.327 0 12.633 0 8.01 0 4.697 2.502 4.697 6.47c0 4.315 3.518 5.629 6.772 6.643 2.56.806 3.447 1.54 3.447 2.923 0 1.258-1.092 2.115-2.898 2.115-2.585 0-4.475-1.28-5.323-3.038l-3.32 1.838c1.373 2.87 4.156 4.78 8.643 4.78 4.887 0 8.358-2.452 8.358-6.619 0-4.697-3.904-5.962-6.4-6.962z"/></svg>
             </div>
             <h3 className="text-2xl font-bold text-center mb-2">Connect Stripe</h3>
             <p className="text-center text-gray-500 text-sm mb-8">Securely link your bank account to receive payouts from ticket sales instantly.</p>
             
             <div className="space-y-4">
                 <div className="p-4 bg-gray-50 border rounded-xl flex items-center gap-3">
                     <div className="w-8 h-8 bg-gray-200 rounded-full animate-pulse" />
                     <div className="flex-1 space-y-2">
                         <div className="h-2 bg-gray-200 rounded w-1/3 animate-pulse" />
                         <div className="h-2 bg-gray-200 rounded w-2/3 animate-pulse" />
                     </div>
                 </div>
                 <button onClick={onComplete} className="w-full py-4 bg-[#635bff] text-white font-bold rounded-xl hover:brightness-110 transition-all">
                     Authorize & Connect
                 </button>
                 <button onClick={onCancel} className="w-full py-4 text-gray-500 font-bold text-xs hover:text-black">
                     Cancel
                 </button>
             </div>
        </div>
    </div>,
    document.body
);

const EventDetailOverlay = ({ event, accentColor, onClose, onEdit, onViewPublic, onDownloadGuestList }: { event: EventDraft, accentColor: string, onClose: () => void, onEdit: () => void, onViewPublic: () => void, onDownloadGuestList: () => void }) => {
    // Cast Draft to Event for the card
    const kickflipEvent = draftToEvent(event);

    return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8">
        <div className="absolute inset-0 bg-black/95 backdrop-blur-3xl animate-in fade-in duration-300" onClick={onClose} />
        {/* Render EventCard in Detail Mode with Custom Footer */}
        <div className="relative w-full max-w-4xl h-[85vh] z-10 animate-in zoom-in-95 duration-300">
             <button onClick={onClose} className="absolute top-4 right-4 z-50 p-3 bg-black/50 text-white rounded-full hover:bg-white hover:text-black transition-all border border-white/10">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
             </button>
             
             <EventCard 
                event={kickflipEvent}
                variant="details"
                className="w-full h-full shadow-2xl"
                // Inject Dashboard Stats into Content Area
                extraContent={
                    <div className="grid grid-cols-2 gap-8 py-4">
                         <div className="flex flex-col items-center p-4 bg-white/5 rounded-xl">
                             <label className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30 block mb-2">Tickets</label>
                             <p className="text-2xl font-black text-white">{event.ticketsSold} / {event.isUnlimitedCapacity ? '∞' : event.capacity}</p>
                         </div>
                         <div className="flex flex-col items-center p-4 bg-white/5 rounded-xl">
                             <label className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30 block mb-2">Revenue</label>
                             <p className="text-2xl font-black text-green-400">${(event.ticketsSold * parseFloat(event.price || '0')).toFixed(0)}</p>
                         </div>
                    </div>
                }
                // Inject Dashboard Actions into Footer
                footerSlot={
                    <div className="space-y-4 w-full max-w-md mx-auto">
                        <div className="grid grid-cols-2 gap-4">
                            <button onClick={onEdit} className="py-4 rounded-xl bg-white/5 border border-white/10 text-xs font-black uppercase tracking-[0.2em] hover:bg-white hover:text-black transition-all">Edit Details</button>
                            <button onClick={onViewPublic} className="py-4 rounded-xl bg-white/5 border border-white/10 text-xs font-black uppercase tracking-[0.2em] hover:bg-white hover:text-black transition-all">Public Page</button>
                        </div>
                        <button onClick={onDownloadGuestList} className="w-full py-4 rounded-xl text-black font-black text-xs uppercase tracking-[0.2em] hover:brightness-110 transition-all shadow-xl" style={{ backgroundColor: accentColor }}>
                            Download Guest List
                        </button>
                    </div>
                }
             />
        </div>
    </div>,
    document.body
    );
};