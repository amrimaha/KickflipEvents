
import React, { useState } from 'react';
import { OnboardingPreferences, ThemeConfig } from '../types';

interface OnboardingModalProps {
  onComplete: (prefs: OnboardingPreferences) => void;
  onSkip: () => void;
  theme: ThemeConfig;
}

const VIBE_CHIPS = [
  "Live music 🎶", "Food & drink 🍜", "Arts & culture 🎨", "Outdoor adventures 🌲",
  "Wellness & movement 🧘", "Comedy & nightlife 🌙", "Markets & pop-ups 🛍️", "Classes & workshops ✂️"
];

const NEIGHBORHOOD_CHIPS = [
  "Capitol Hill", "Ballard", "Fremont", "Queen Anne", "Downtown", 
  "U-District", "South Lake Union", "West Seattle", "Bellevue / Eastside", "Surprise me ✨"
];

const TIMING_CHIPS = ["Tonight", "Weekends", "Weeknights", "Anytime"];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({ onComplete, onSkip, theme }) => {
  const [step, setStep] = useState(1);
  const [selectedVibes, setSelectedVibes] = useState<string[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [selectedTiming, setSelectedTiming] = useState<string[]>([]);

  const toggleVibe = (vibe: string) => {
    if (selectedVibes.includes(vibe)) {
      setSelectedVibes(prev => prev.filter(v => v !== vibe));
    } else if (selectedVibes.length < 3) {
      setSelectedVibes(prev => [...prev, vibe]);
    }
  };

  const toggleTiming = (time: string) => {
    if (selectedTiming.includes(time)) {
      setSelectedTiming(prev => prev.filter(t => t !== time));
    } else if (selectedTiming.length < 2) {
      setSelectedTiming(prev => [...prev, time]);
    }
  };

  const handleNext = () => setStep(2);

  const handleFinish = () => {
    onComplete({
      vibes: selectedVibes,
      location: selectedLocation || "Seattle",
      timing: selectedTiming.length > 0 ? selectedTiming : ["Anytime"],
      completed: true
    });
  };

  const accent = theme.accentColor;

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center pointer-events-none">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm pointer-events-auto transition-opacity duration-500 animate-in fade-in" />

      {/* Bottom Sheet */}
      <div className="w-full max-w-lg bg-[#111] rounded-t-3xl border-t border-white/10 p-8 pointer-events-auto relative shadow-2xl animate-in slide-in-from-bottom-full duration-500">
        
        {/* Header */}
        <div className="mb-6">
          <h2 className="text-3xl font-black text-white tracking-tighter mb-1">
            Welcome to Kickflip 👋
          </h2>
          <p className="text-white/50 text-sm font-medium">
            Discover the best of Seattle. Let's get started.
          </p>
        </div>

        {/* Step 1: Vibe Tuning */}
        {step === 1 && (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
            <div>
              <h3 className="text-lg font-bold text-white mb-4">What are you feeling lately?</h3>
              <div className="flex flex-wrap gap-3">
                {VIBE_CHIPS.map(vibe => (
                  <button
                    key={vibe}
                    onClick={() => toggleVibe(vibe)}
                    className={`px-5 py-3 rounded-full text-sm font-bold transition-all transform active:scale-95 border ${
                      selectedVibes.includes(vibe) 
                        ? 'bg-white text-black border-white shadow-[0_0_15px_rgba(255,255,255,0.3)]' 
                        : 'bg-white/5 text-white/70 border-transparent hover:bg-white/10'
                    }`}
                  >
                    {vibe}
                  </button>
                ))}
              </div>
              <p className="text-white/30 text-xs mt-3 font-medium uppercase tracking-widest">
                Pick up to 3 — we’ll fine-tune as you go.
              </p>
            </div>

            <div className="flex gap-4 pt-4">
              <button 
                onClick={handleNext}
                disabled={selectedVibes.length === 0}
                className="flex-1 py-4 rounded-xl font-black text-black text-sm uppercase tracking-widest transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:scale-[1.02]"
                style={{ backgroundColor: selectedVibes.length > 0 ? accent : '#555' }}
              >
                Next
              </button>
              <button 
                onClick={onSkip}
                className="px-6 py-4 rounded-xl font-bold text-white/40 text-sm uppercase tracking-widest hover:text-white hover:bg-white/5 transition-all"
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Location & Timing */}
        {step === 2 && (
          <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Location */}
            <div>
              <h3 className="text-lg font-bold text-white mb-3">Where should we start?</h3>
              <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto no-scrollbar pb-2">
                <button
                   onClick={() => setSelectedLocation('Current Location')}
                   className={`px-4 py-2 rounded-full text-xs font-bold transition-all border flex items-center gap-2 ${
                      selectedLocation === 'Current Location'
                        ? 'bg-blue-500 text-white border-blue-500'
                        : 'bg-white/5 text-white/70 border-white/10 hover:bg-white/10'
                   }`}
                >
                   <span>📍</span> Near me
                </button>
                {NEIGHBORHOOD_CHIPS.map(hood => (
                  <button
                    key={hood}
                    onClick={() => setSelectedLocation(hood)}
                    className={`px-4 py-2 rounded-full text-xs font-bold transition-all border ${
                      selectedLocation === hood 
                        ? 'bg-white text-black border-white' 
                        : 'bg-white/5 text-white/70 border-transparent hover:bg-white/10'
                    }`}
                  >
                    {hood}
                  </button>
                ))}
              </div>
            </div>

            {/* Timing */}
            <div>
              <h3 className="text-lg font-bold text-white mb-3">When do you usually go out?</h3>
              <div className="flex flex-wrap gap-3">
                {TIMING_CHIPS.map(time => (
                  <button
                    key={time}
                    onClick={() => toggleTiming(time)}
                    className={`px-4 py-2 rounded-full text-xs font-bold transition-all border ${
                      selectedTiming.includes(time)
                        ? 'bg-white text-black border-white'
                        : 'bg-white/5 text-white/70 border-transparent hover:bg-white/10'
                    }`}
                  >
                    {time}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-4 pt-2">
              <button 
                onClick={handleFinish}
                className="flex-1 py-4 rounded-xl font-black text-black text-sm uppercase tracking-widest transition-all hover:scale-[1.02] shadow-lg"
                style={{ backgroundColor: accent }}
              >
                Show my picks
              </button>
              <button 
                onClick={onSkip}
                className="px-6 py-4 rounded-xl font-bold text-white/40 text-sm uppercase tracking-widest hover:text-white hover:bg-white/5 transition-all"
              >
                Skip
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
