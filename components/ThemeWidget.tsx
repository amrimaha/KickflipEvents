
import React, { useState } from 'react';
import { ThemeConfig } from '../types';
import { BACKGROUND_OPTIONS, MUSIC_OPTIONS } from '../constants';

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

const SpeakerIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
  </svg>
);

const OffIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
  </svg>
);

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

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
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 mt-2 w-72 bg-[#111] border border-white/10 rounded-xl shadow-2xl p-4 z-50 animate-in slide-in-from-top-2 fade-in duration-200 overflow-y-auto max-h-[85vh] custom-scrollbar">

            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-bold text-white tracking-wide">Customize</h3>
              <button onClick={() => setIsOpen(false)} className="text-white/40 hover:text-white transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            {/* Typography */}
            <div className="mb-5">
              <label className="text-xs font-bold text-white/50 uppercase tracking-wider mb-2 block">Typography</label>
              <div className="flex gap-2 bg-white/5 p-1 rounded-lg">
                {FONTS.map(font => (
                  <button
                    key={font.value}
                    onClick={() => onUpdate({ ...currentTheme, font: font.value as ThemeConfig['font'] })}
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
                    className={`w-9 h-9 rounded-full border-2 transition-all hover:scale-110 flex items-center justify-center ${
                      currentTheme.accentColor === color.value
                        ? 'border-white scale-110'
                        : 'border-transparent opacity-70 hover:opacity-100'
                    }`}
                    style={{ backgroundColor: color.value }}
                    title={color.label}
                  >
                    {currentTheme.accentColor === color.value && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Background Vibe */}
            <div className="mb-5">
              <label className="text-xs font-bold text-white/50 uppercase tracking-wider mb-2 block">Vibe</label>
              <div className="grid grid-cols-2 gap-2">
                {BACKGROUND_OPTIONS.map((bg) => {
                  const isSelected = currentTheme.backgroundUrl === bg.url;
                  return (
                    <button
                      key={bg.label}
                      onClick={() => onUpdate({
                        ...currentTheme,
                        backgroundType: bg.type as 'video' | 'image',
                        backgroundUrl: bg.url,
                      })}
                      className={`relative h-16 rounded-lg text-xs font-bold overflow-hidden transition-all group border-2 ${
                        isSelected ? 'border-white' : 'border-transparent hover:border-white/30'
                      }`}
                    >
                      {/* Thumbnail background */}
                      <div className="absolute inset-0 bg-gray-800">
                        <img
                          src={bg.thumbnail || bg.url}
                          alt={bg.label}
                          className="w-full h-full object-cover opacity-60 pointer-events-none"
                          loading="lazy"
                        />
                      </div>

                      {/* Hover overlay */}
                      <div className={`absolute inset-0 transition-colors ${
                        isSelected ? 'bg-black/20' : 'bg-black/40 group-hover:bg-black/25'
                      }`} />

                      {/* Label */}
                      <span className="absolute bottom-1.5 left-2 right-2 text-left z-20 drop-shadow-md text-white text-[10px] font-bold leading-tight pointer-events-none">
                        {bg.label}
                      </span>

                      {/* Checkmark badge */}
                      {isSelected && (
                        <div className="absolute top-1.5 right-1.5 z-20 w-5 h-5 rounded-full bg-white flex items-center justify-center shadow-md">
                          <CheckIcon />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Music */}
            <div className="mb-5">
              <label className="text-xs font-bold text-white/50 uppercase tracking-wider mb-2 block">Music</label>
              <div className="flex flex-col gap-1">
                {MUSIC_OPTIONS.map((track) => {
                  const isSelected = (currentTheme.music ?? null) === track.url;
                  return (
                    <button
                      key={track.label}
                      onClick={() => onUpdate({ ...currentTheme, music: track.url })}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${
                        isSelected
                          ? 'bg-white/15 text-white font-semibold'
                          : 'text-white/60 hover:text-white hover:bg-white/8'
                      }`}
                    >
                      <span className={`flex-shrink-0 ${isSelected ? 'text-white' : 'text-white/40'}`}>
                        {track.url === null ? <OffIcon /> : <SpeakerIcon />}
                      </span>
                      <span className="flex-1 text-left">{track.label}</span>
                      {isSelected && (
                        <span className="flex-shrink-0 text-white/70">
                          <CheckIcon />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Save Button */}
            <div className="pt-4 border-t border-white/10">
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
