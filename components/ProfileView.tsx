
import React, { useState, useMemo, useRef } from 'react';
import { User, EventDraft, VibemojiConfig, KickflipEvent } from '../types';
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
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const MAX = 400;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const compressed = canvas.toDataURL('image/jpeg', 0.82);
        onUpdateUser({ profilePhotoUrl: compressed });
      };
      img.src = objectUrl;
    }
  };

  // Resolved avatar: uploaded photo → Google account photo → initials
  const avatarUrl = user.profilePhotoUrl || user.avatar || null;
  const initials = user.name
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

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

          if (type === 'image') {
            const img = new Image();
            const objectUrl = URL.createObjectURL(file);
            img.onload = () => {
              URL.revokeObjectURL(objectUrl);
              const MAX_W = 1280, MAX_H = 720;
              const scale = Math.min(1, MAX_W / img.width, MAX_H / img.height);
              const canvas = document.createElement('canvas');
              canvas.width = Math.round(img.width * scale);
              canvas.height = Math.round(img.height * scale);
              canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
              onUpdateUser({ profileCoverUrl: canvas.toDataURL('image/jpeg', 0.80), profileCoverType: 'image' });
            };
            img.src = objectUrl;
          } else {
            // Videos: store as object URL (session only — Supabase Storage needed for persistence)
            const objectUrl = URL.createObjectURL(file);
            onUpdateUser({ profileCoverUrl: objectUrl, profileCoverType: 'video' });
          }
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

          {/* Avatar — click to upload photo */}
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-12 z-30">
              <div
                className="w-32 h-32 rounded-full bg-black border-4 shadow-2xl overflow-hidden relative group/avatar cursor-pointer"
                style={{ borderColor: accentColor }}
                onClick={() => avatarInputRef.current?.click()}
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={user.name}
                    className="w-full h-full object-cover group-hover/avatar:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center text-3xl font-black text-white"
                    style={{ backgroundColor: accentColor + '33' }}
                  >
                    {initials}
                  </div>
                )}
                {/* Camera overlay on hover */}
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/avatar:opacity-100 flex flex-col items-center justify-center gap-1 transition-opacity">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                    <circle cx="12" cy="13" r="4"></circle>
                  </svg>
                  <span className="text-white text-[9px] font-bold uppercase tracking-widest">Upload</span>
                </div>
              </div>
              <input
                type="file"
                ref={avatarInputRef}
                className="hidden"
                accept="image/*"
                onChange={handleAvatarUpload}
              />
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
