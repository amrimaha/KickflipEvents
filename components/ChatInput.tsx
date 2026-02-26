
import React, { useState } from 'react';
import { ThemeConfig } from '../types';

interface ChatInputProps {
  onSend: (message: string) => void;
  isLoading: boolean;
  theme?: ThemeConfig;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, isLoading, theme }) => {
  const [input, setInput] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  
  const accentColor = theme?.accentColor || '#34d399';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      onSend(input);
      setInput('');
    }
  };

  return (
    // Updated padding for fixed bottom positioning
    <div className={`w-full max-w-3xl mx-auto px-4 pb-6 pt-2 relative z-50 ${theme?.font || 'font-sans'}`}>
      <form onSubmit={handleSubmit} className="relative group">
        <div className="absolute inset-0 bg-white/10 blur-md rounded-lg transform scale-x-95 translate-y-1 group-hover:bg-white/20 transition-all"></div>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={isLoading ? "Thinking..." : "Find me something"}
          disabled={isLoading}
          className="w-full bg-black/80 backdrop-blur-xl border border-white/20 text-lg px-6 py-4 pr-14 outline-none rounded-xl font-medium transition-all focus:bg-black/90 focus:border-white/40 shadow-xl"
          style={{ 
              color: accentColor,
              borderColor: isFocused ? accentColor : 'rgba(255,255,255,0.2)',
              '--placeholder-color': `${accentColor}80` // 50% opacity hex
          } as React.CSSProperties}
        />
        <style dangerouslySetInnerHTML={{__html: `
          input::placeholder {
            color: ${accentColor}80 !important;
          }
        `}} />
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className="absolute right-6 top-1/2 -translate-y-1/2 p-2 text-white/50 hover:text-white disabled:opacity-30 transition-colors"
          style={{ color: input.trim() && !isLoading ? accentColor : undefined }}
        >
          {isLoading ? (
             <svg className="animate-spin h-6 w-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
               <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
               <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
             </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" strokeWidth="2" strokeLinecap="square"/>
            </svg>
          )}
        </button>
      </form>
    </div>
  );
};
