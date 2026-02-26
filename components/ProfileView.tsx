
import React, { useState, useMemo, useRef } from 'react';
import { User, EventDraft, VibemojiConfig, KickflipEvent } from '../types';
import { EventVibemojiRenderer } from './EventVibemojiRenderer';
import { EventCard } from './EventCard';
import { IdentityCustomizer } from './IdentityCustomizer';
import { draftToEvent } from '../constants';

interface ProfileViewProps {
  user: User;
  createdEvents: EventDraft[];
  onLogout: () => void;
  onNavigateDashboard: () => void;
  onNavigateCreate: () => void;
  onUpdateUser: (updates: Partial<User>) => void;
  onUpdateBrand: (config: VibemojiConfig) => void;
  brandIdentity: VibemojiConfig;
  onBackHome: () => void;
}

export const ProfileView: React.FC<ProfileViewProps> = ({ 
  user, 
  createdEvents, 
  onLogout, 
  onNavigateDashboard, 
  onNavigateCreate,
  onUpdateUser,
  onUpdateBrand,
  brandIdentity,
  onBackHome
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
      name: user.name,
      email: user.email,
      phone: user.phoneNumber || ''
  });
  
  const [isIdentityModalOpen, setIsIdentityModalOpen] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // Filter events
  const { upcoming, past } = useMemo(() => {
     const now = new Date();
     const upcomingList: KickflipEvent[] = [];
     const pastList: KickflipEvent[] = [];

     createdEvents.forEach(draft => {
         const evt = draftToEvent(draft);
         // Simple active check logic
         if (draft.status === 'completed') {
             pastList.push(evt);
         } else if (draft.status === 'draft') {
             // Drafts usually go to dashboard, but maybe show here as 'In Progress'? 
             // Requirement says "Upcoming and Past", implies active ones.
             // We'll skip drafts here to keep profile clean, or put them in upcoming.
         } else {
             // Active
             if (draft.endDate) {
                 const end = new Date(`${draft.endDate}T${draft.endTime || '23:59'}`);
                 if (end < now) pastList.push(evt);
                 else upcomingList.push(evt);
             } else {
                 upcomingList.push(evt);
             }
         }
     });
     
     // Sort upcoming by start date ascending
     upcomingList.sort((a, b) => new Date(a.startDate || 0).getTime() - new Date(b.startDate || 0).getTime());
     // Sort past by start date descending
     pastList.sort((a, b) => new Date(b.startDate || 0).getTime() - new Date(a.startDate || 0).getTime());

     return { upcoming: upcomingList, past: pastList };
  }, [createdEvents]);

  const handleSaveProfile = () => {
      onUpdateUser({
          name: formData.name,
          email: formData.email,
          phoneNumber: formData.phone
      });
      setIsEditing(false);
  };

  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files[0]) {
          const file = e.target.files[0];
          const type = file.type.startsWith('image') ? 'image' : 'video';
          
          // Use FileReader to convert to Base64 Data URL for persistent storage in DB
          const reader = new FileReader();
          reader.onload = (ev) => {
              const url = ev.target?.result as string;
              onUpdateUser({ 
                  profileCoverUrl: url,
                  profileCoverType: type
              });
          };
          reader.readAsDataURL(file);
      }
  };

  const toggleNotification = (key: keyof NonNullable<User['notificationPreferences']>) => {
      const current = user.notificationPreferences || {
          eventUpdates: true,
          bookingConfirmations: true,
          reminders: true,
          productAnnouncements: true
      };
      onUpdateUser({
          notificationPreferences: {
              ...current,
              [key]: !current[key]
          }
      });
  };

  const preferences = user.notificationPreferences || {
      eventUpdates: true,
      bookingConfirmations: true,
      reminders: true,
      productAnnouncements: true
  };

  const accentColor = brandIdentity.primaryColor || '#34d399';

  return (
    <div className="min-h-screen bg-black text-white pb-24 animate-in fade-in duration-500">
      
      {/* --- HEADER --- */}
      <div className="relative h-[40vh] w-full bg-gray-900 overflow-hidden group">
          {user.profileCoverUrl ? (
              user.profileCoverType === 'image' ? (
                  <img 
                      src={user.profileCoverUrl} 
                      className="absolute inset-0 w-full h-full object-cover" 
                      alt="Profile Cover"
                  />
              ) : (
                  <video 
                      src={user.profileCoverUrl} 
                      className="absolute inset-0 w-full h-full object-cover" 
                      autoPlay loop muted playsInline webkit-playsinline="true"
                  />
              )
          ) : user.profileVideoUrl ? (
              // Legacy Fallback
              <video 
                 src={user.profileVideoUrl} 
                 className="absolute inset-0 w-full h-full object-cover" 
                 autoPlay loop muted playsInline webkit-playsinline="true"
              />
          ) : (
              // Fallback abstract gradient
              <div className="absolute inset-0 w-full h-full bg-gradient-to-br from-indigo-900 via-purple-900 to-black opacity-80 animate-pulse" />
          )}
          
          {/* Enhanced Clarity Overlay - Removed Blur */}
          <div className="absolute inset-0 bg-black/10" />
          <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent" />

          {/* Back Button */}
          <button 
             onClick={onBackHome}
             className="absolute top-6 left-6 z-20 p-2 rounded-full bg-black/20 hover:bg-black/40 backdrop-blur-md text-white transition-all border border-white/10"
          >
             <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
          </button>

          {/* Edit Cover Button */}
          <button 
             onClick={() => coverInputRef.current?.click()}
             className="absolute top-6 right-6 z-20 px-4 py-2 rounded-full bg-black/20 hover:bg-black/40 backdrop-blur-md text-[10px] font-black uppercase tracking-widest text-white transition-all border border-white/10 opacity-0 group-hover:opacity-100"
          >
             Change Cover
          </button>
          <input type="file" ref={coverInputRef} className="hidden" accept="image/*,video/*" onChange={handleCoverUpload} />

          {/* Avatar / Vibemoji */}
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-12 z-30 flex flex-col items-center">
              <div className="w-32 h-32 rounded-[2.5rem] bg-black border-4 border-[#111] shadow-2xl overflow-hidden relative group/avatar cursor-pointer" onClick={() => setIsIdentityModalOpen(true)}>
                 <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />
                 <EventVibemojiRenderer config={brandIdentity} className="w-full h-full p-2 group-hover/avatar:scale-110 transition-transform duration-500" />
                 <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/avatar:opacity-100 flex items-center justify-center transition-opacity">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                 </div>
              </div>
          </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 pt-16 flex flex-col gap-12">
          
          {/* User Info */}
          <div className="text-center">
              <h1 className="text-3xl font-black text-white mb-1">{user.name}</h1>
              <p className="text-white/50 text-sm">{user.email}</p>
          </div>

          {/* Creator CTA */}
          <div className="flex justify-center">
              {createdEvents.length > 0 ? (
                  <button 
                    onClick={onNavigateDashboard}
                    className="flex items-center gap-3 px-8 py-4 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all group"
                  >
                      <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.5)]" />
                      <div className="text-left">
                          <span className="block text-xs font-black uppercase tracking-widest text-white/50 group-hover:text-white/80 transition-colors">Creator Mode</span>
                          <span className="block text-lg font-black text-white">My Event Dashboard</span>
                      </div>
                      <svg className="ml-2 text-white/30 group-hover:text-white transition-colors" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                  </button>
              ) : (
                  <button 
                    onClick={onNavigateCreate}
                    className="px-10 py-5 rounded-full font-black text-sm uppercase tracking-widest shadow-xl hover:scale-105 transition-all text-black"
                    style={{ backgroundColor: accentColor }}
                  >
                      Launch Your First Event
                  </button>
              )}
          </div>

          <div className="h-px bg-white/10 w-full" />

          {/* --- EVENTS SECTION --- */}
          <div className="space-y-10">
              {upcoming.length > 0 && (
                  <section>
                      <h3 className="text-xs font-black uppercase tracking-[0.2em] text-white/40 mb-6 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-white/40" />
                          Upcoming Drops
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                          {upcoming.map(evt => (
                              <EventCard key={evt.id} event={evt} className="w-full h-80" onClick={() => {}} />
                          ))}
                      </div>
                  </section>
              )}

              {past.length > 0 && (
                  <section>
                      <h3 className="text-xs font-black uppercase tracking-[0.2em] text-white/40 mb-6 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-white/10" />
                          Past Drops
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 opacity-60 hover:opacity-100 transition-opacity">
                          {past.map(evt => (
                              <EventCard key={evt.id} event={evt} className="w-full h-80 grayscale hover:grayscale-0 transition-all" onClick={() => {}} />
                          ))}
                      </div>
                  </section>
              )}
              
              {upcoming.length === 0 && past.length === 0 && (
                  <div className="text-center py-10 border-2 border-dashed border-white/5 rounded-3xl">
                      <p className="text-white/30 font-bold uppercase tracking-widest text-xs">No events yet</p>
                  </div>
              )}
          </div>

          <div className="h-px bg-white/10 w-full" />

          {/* --- SETTINGS SECTION --- */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-12">
              <div>
                  <div className="flex justify-between items-end mb-6">
                     <h3 className="text-xs font-black uppercase tracking-[0.2em] text-white/40">Profile Info</h3>
                     {!isEditing && (
                         <button onClick={() => setIsEditing(true)} className="text-[10px] font-bold text-white/60 hover:text-white uppercase tracking-widest">Edit</button>
                     )}
                  </div>
                  
                  <div className="space-y-6">
                      <div>
                          <label className="block text-[9px] font-bold text-white/30 uppercase tracking-widest mb-2">Display Name</label>
                          <input 
                             type="text" 
                             disabled={!isEditing}
                             value={formData.name}
                             onChange={(e) => setFormData({...formData, name: e.target.value})}
                             className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-white/30 transition-all"
                          />
                      </div>
                      <div>
                          <label className="block text-[9px] font-bold text-white/30 uppercase tracking-widest mb-2">Email</label>
                          <input 
                             type="email" 
                             disabled={!isEditing}
                             value={formData.email}
                             onChange={(e) => setFormData({...formData, email: e.target.value})}
                             className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-white/30 transition-all"
                          />
                      </div>
                      <div>
                          <label className="block text-[9px] font-bold text-white/30 uppercase tracking-widest mb-2">Phone (Optional)</label>
                          <input 
                             type="tel" 
                             disabled={!isEditing}
                             value={formData.phone}
                             onChange={(e) => setFormData({...formData, phone: e.target.value})}
                             placeholder="+1 (555) 000-0000"
                             className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-white/30 transition-all placeholder-white/10"
                          />
                      </div>
                      
                      {isEditing && (
                          <div className="flex gap-3 pt-2">
                              <button onClick={handleSaveProfile} className="flex-1 py-3 bg-white text-black font-bold rounded-xl text-xs uppercase tracking-widest hover:bg-white/90">Save Changes</button>
                              <button onClick={() => { setIsEditing(false); setFormData({name: user.name, email: user.email, phone: user.phoneNumber || ''}); }} className="px-6 py-3 bg-white/10 text-white font-bold rounded-xl text-xs uppercase tracking-widest hover:bg-white/20">Cancel</button>
                          </div>
                      )}
                  </div>
              </div>

              <div className="space-y-12">
                  <div>
                      <h3 className="text-xs font-black uppercase tracking-[0.2em] text-white/40 mb-6">Notifications</h3>
                      <div className="space-y-4">
                          {[
                              { key: 'eventUpdates', label: 'Event Updates' },
                              { key: 'bookingConfirmations', label: 'Booking Confirmations' },
                              { key: 'reminders', label: 'Reminders' },
                              { key: 'productAnnouncements', label: 'Product Announcements' }
                          ].map(({key, label}) => (
                              <div key={key} className="flex justify-between items-center p-4 bg-white/5 border border-white/5 rounded-xl">
                                  <span className="text-sm font-medium text-white/80">{label}</span>
                                  <button 
                                     onClick={() => toggleNotification(key as any)}
                                     className={`w-10 h-6 rounded-full relative transition-colors ${preferences[key as keyof typeof preferences] ? 'bg-green-500' : 'bg-white/10'}`}
                                  >
                                      <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${preferences[key as keyof typeof preferences] ? 'left-5' : 'left-1'}`} />
                                  </button>
                              </div>
                          ))}
                      </div>
                  </div>

                  <div className="pt-6 border-t border-white/10 space-y-4">
                      <div className="flex flex-wrap gap-6 text-xs font-bold text-white/40 uppercase tracking-widest">
                          <a href="#" className="hover:text-white transition-colors">Privacy Policy</a>
                          <a href="#" className="hover:text-white transition-colors">Terms of Service</a>
                          <a href="mailto:support@kickflip.co" className="hover:text-white transition-colors">Contact Support</a>
                      </div>
                      
                      <button 
                         onClick={onLogout}
                         className="w-full py-4 rounded-xl border border-red-500/30 text-red-400 font-bold text-xs uppercase tracking-widest hover:bg-red-500/10 transition-all mt-4"
                      >
                         Log Out
                      </button>
                  </div>
              </div>
          </section>

      </div>

      {isIdentityModalOpen && (
        <IdentityCustomizer 
            config={brandIdentity} 
            onUpdate={onUpdateBrand} 
            onClose={() => setIsIdentityModalOpen(false)} 
            variant="profile"
        />
      )}
    </div>
  );
};
