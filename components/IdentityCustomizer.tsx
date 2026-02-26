
import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { VibemojiConfig } from '../types';
import { EventVibemojiRenderer } from './EventVibemojiRenderer';
import { BRAND_COLORS, FONTS, BACKGROUND_OPTIONS } from '../constants';

interface IdentityCustomizerProps {
  config: VibemojiConfig;
  onUpdate: (c: VibemojiConfig) => void;
  onClose: () => void;
  variant?: 'dashboard' | 'profile'; // 'profile' might hide dashboard specific font settings if desired
}

export const IdentityCustomizer: React.FC<IdentityCustomizerProps> = ({ config, onUpdate, onClose, variant = 'dashboard' }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Local fallback vars to handle editing
  const currentFont = config.font || 'font-sans';
  const currentBgUrl = config.backgroundUrl || '';

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          onUpdate({ ...config, logoUrl: event.target.result as string });
        }
      };
      reader.readAsDataURL(e.target.files[0]);
    }
  };

  const title = variant === 'dashboard' ? 'My Brand Identity' : 'My Vibemoji';

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/95 backdrop-blur-3xl animate-in fade-in duration-500" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-[#0a0a0a] border border-white/10 rounded-[3rem] p-12 overflow-y-auto max-h-[90vh] shadow-2xl animate-in zoom-in-95 duration-500 custom-scrollbar">
         <div className="flex justify-between items-center mb-10">
             <h2 className="text-5xl font-black tracking-tighter text-white">{title}</h2>
             <button onClick={onClose} className="p-3 bg-white/5 rounded-full hover:bg-white/10 text-white">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
             </button>
         </div>

         <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
            
            {/* BRANDING SECTION */}
            <div className="space-y-10">
                <div>
                   <label className="text-[10px] font-black uppercase tracking-[0.4em] text-white/60 block mb-6">Visual Avatar</label>
                   <div className="flex flex-col items-center gap-6">
                      <div className="w-36 h-36 p-4 bg-white/5 rounded-[2.5rem] border-2 border-white/10 shadow-2xl relative group overflow-hidden">
                        {config.logoUrl ? (
                            <img src={config.logoUrl} alt="Logo" className="w-full h-full object-contain" />
                        ) : (
                            <EventVibemojiRenderer config={config} className="w-full h-full" />
                        )}
                        <button 
                            onClick={() => fileInputRef.current?.click()}
                            className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
                        >
                            <span className="text-[9px] font-black uppercase tracking-widest text-white">Update</span>
                        </button>
                      </div>
                      <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleLogoUpload} />
                      <div className="flex gap-2">
                          <button onClick={() => fileInputRef.current?.click()} className="px-4 py-2 bg-white/10 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-white/20 transition-all text-white">Upload Custom</button>
                          {config.logoUrl && (
                            <button onClick={() => onUpdate({ ...config, logoUrl: undefined })} className="px-4 py-2 bg-red-500/10 text-red-400 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-red-500/20 transition-all">Reset</button>
                          )}
                      </div>
                   </div>
                </div>

                <div>
                   <label className="text-[10px] font-black uppercase tracking-[0.4em] text-white/60 block mb-6">Primary Color</label>
                   <div className="grid grid-cols-4 gap-4">
                      {BRAND_COLORS.map(c => (
                         <button 
                           key={c}
                           onClick={() => {
                             onUpdate({...config, primaryColor: c});
                           }}
                           className={`h-10 rounded-xl transition-all ${config.primaryColor === c ? 'scale-110 border-2 border-white shadow-2xl' : 'opacity-40 hover:opacity-100'}`}
                           style={{ backgroundColor: c }}
                         />
                      ))}
                   </div>
                </div>
            </div>

            {/* THEME SECTION */}
            <div className="space-y-10">
                {variant === 'dashboard' && (
                    <div>
                    <label className="text-[10px] font-black uppercase tracking-[0.4em] text-white/60 block mb-6">Studio Font</label>
                    <div className="flex flex-col gap-2">
                        {FONTS.map(f => (
                            <button 
                            key={f.value}
                            onClick={() => onUpdate({...config, font: f.value as any})}
                            className={`px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] border transition-all text-left ${currentFont === f.value ? 'bg-white text-black border-white' : 'border-white/10 text-white/60 hover:text-white'}`}
                            >
                            {f.label}
                            </button>
                        ))}
                    </div>
                    </div>
                )}

                <div>
                   <label className="text-[10px] font-black uppercase tracking-[0.4em] text-white/60 block mb-6">{variant === 'dashboard' ? 'Studio Vibe' : 'Background Vibe'}</label>
                   <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto no-scrollbar pr-2">
                        {BACKGROUND_OPTIONS.map((bg) => (
                        <button
                            key={bg.label}
                            onClick={() => onUpdate({ 
                                ...config, 
                                backgroundType: bg.type as 'video' | 'image', 
                                backgroundUrl: bg.url 
                            })}
                            className={`relative p-2 h-16 rounded-xl text-[9px] font-black uppercase tracking-widest overflow-hidden transition-all group border ${
                            currentBgUrl === bg.url
                                ? 'border-white text-white'
                                : 'border-transparent text-white/60 hover:text-white'
                            }`}
                        >
                            <div className="absolute inset-0 bg-gray-900 z-0">
                                {(bg.type as string) === 'video' ? (
                                    <video src={bg.url} muted loop autoPlay playsInline className="w-full h-full object-cover opacity-50" />
                                ) : (
                                    <img src={bg.url} alt={bg.label} className="w-full h-full object-cover opacity-50" />
                                )}
                            </div>
                            <div className="absolute inset-0 bg-black/40 group-hover:bg-black/20 transition-colors z-10" />
                            <span className="relative z-20 drop-shadow-md">{bg.label}</span>
                        </button>
                        ))}
                    </div>
                </div>
            </div>
         </div>

         <button 
           onClick={onClose}
           className="w-full mt-14 py-6 bg-white text-black font-black rounded-3xl text-xs uppercase tracking-[0.4em] hover:scale-[1.02] active:scale-95 transition-all shadow-2xl shadow-white/10"
         >
           Save Changes
         </button>
      </div>
    </div>,
    document.body
  );
};
