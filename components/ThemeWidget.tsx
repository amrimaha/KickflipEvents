
import React, { useState } from 'react';
import { ThemeConfig } from '../types';
import { BACKGROUND_OPTIONS } from '../constants';

interface ThemeWidgetProps {
  currentTheme: ThemeConfig;
  onUpdate: (theme: ThemeConfig) => void;
}

const FONTS = [
  { label: 'Modern', value: 'font-sans' },
  { label: 'Classic', value: 'font-serif' },
  { label: 'Typewriter', value: 'font-mono' },
];

const COLORS = [
  { label: 'Emerald', value: '#34d399' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Cyan', value: '#22d3ee' },
  { label: 'Violet', value: '#a78bfa' },
  { label: 'Orange', value: '#fb923c' },
];

export const ThemeWidget: React.FC<ThemeWidgetProps> = ({ currentTheme, onUpdate }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative z-50">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 text-white/70 hover:text-white transition-colors bg-black/20 hover:bg-black/40 backdrop-blur-md rounded-full"
        title="Customize Experience"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)}></div>
          <div className="absolute right-0 mt-2 w-72 bg-[#111] border border-white/10 rounded-xl shadow-2xl p-4 z-50 animate-in slide-in-from-top-2 fade-in duration-200 overflow-y-auto max-h-[80vh] custom-scrollbar">
            
            {/* Typography */}
            <div className="mb-5">
              <label className="text-xs font-bold text-white/50 uppercase tracking-wider mb-2 block">Typography</label>
              <div className="flex gap-2 bg-white/5 p-1 rounded-lg">
                {FONTS.map(font => (
                  <button
                    key={font.value}
                    onClick={() => onUpdate({ ...currentTheme, font: font.value as any })}
                    className={`flex-1 py-1.5 text-xs rounded-md transition-all ${
                      currentTheme.font === font.value 
                        ? 'bg-white/20 text-white font-bold' 
                        : 'text-white/50 hover:text-white'
                    }`}
                  >
                    {font.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Accent Color */}
            <div className="mb-5">
              <label className="text-xs font-bold text-white/50 uppercase tracking-wider mb-2 block">Accent</label>
              <div className="flex justify-between gap-2">
                {COLORS.map(color => (
                  <button
                    key={color.value}
                    onClick={() => onUpdate({ ...currentTheme, accentColor: color.value })}
                    className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${
                      currentTheme.accentColor === color.value 
                        ? 'border-white scale-110' 
                        : 'border-transparent opacity-70 hover:opacity-100'
                    }`}
                    style={{ backgroundColor: color.value }}
                    title={color.label}
                  />
                ))}
              </div>
            </div>

            {/* Background Vibe (Video or Image) */}
            <div className="mb-4">
              <label className="text-xs font-bold text-white/50 uppercase tracking-wider mb-2 block">Vibe</label>
              <div className="grid grid-cols-2 gap-2 max-h-52 overflow-y-auto no-scrollbar">
                {BACKGROUND_OPTIONS.map((bg) => (
                  <button
                    key={bg.label}
                    onClick={() => onUpdate({ 
                      ...currentTheme, 
                      backgroundType: bg.type as 'video' | 'image', 
                      backgroundUrl: bg.url 
                    })}
                    className={`relative p-2 h-16 rounded-lg text-xs font-bold overflow-hidden transition-all group border ${
                      currentTheme.backgroundUrl === bg.url
                        ? 'border-white text-white'
                        : 'border-transparent text-white/80 hover:text-white'
                    }`}
                  >
                    <div className="absolute inset-0 bg-gray-800 z-0">
                      {(bg.type as string) === 'video' ? (
                        <video 
                          src={bg.url} 
                          muted 
                          loop 
                          autoPlay 
                          playsInline 
                          webkit-playsinline="true"
                          className="w-full h-full object-cover opacity-50 pointer-events-none" 
                        />
                      ) : (
                        <img src={bg.url} alt={bg.label} className="w-full h-full object-cover opacity-50 pointer-events-none" />
                      )}
                    </div>
                    <div className="absolute inset-0 bg-black/40 group-hover:bg-black/20 transition-colors z-10" />
                    <span className="relative z-20 drop-shadow-md pointer-events-none">{bg.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Save Button */}
            <div className="mt-2 pt-4 border-t border-white/10">
                <button 
                  onClick={() => setIsOpen(false)}
                  className="w-full py-3 rounded-xl font-bold text-black transition-transform hover:scale-[1.02] active:scale-[0.98] shadow-lg"
                  style={{ backgroundColor: currentTheme.accentColor }}
                >
                  Save Settings
                </button>
            </div>

          </div>
        </>
      )}
    </div>
  );
};
