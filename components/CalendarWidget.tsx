
import React, { useState } from 'react';

interface CalendarWidgetProps {
  onSelectDate: (date: Date) => void;
  onClear: () => void;
  onClose: () => void;
  accentColor: string;
  selectedDate?: Date | null;
}

export const CalendarWidget: React.FC<CalendarWidgetProps> = ({ onSelectDate, onClear, onClose, accentColor, selectedDate }) => {
  // Initialize view to the selected date's month, or today if null
  const [currentDate, setCurrentDate] = useState(selectedDate || new Date());

  const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
  const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay();

  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const monthName = currentDate.toLocaleString('default', { month: 'long' });
  const year = currentDate.getFullYear();
  
  const today = new Date();

  const handlePrevMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const handleNextMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const handleDateClick = (day: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const selected = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    onSelectDate(selected);
  };

  const handleClearClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClear();
  };

  return (
    <>
      {/* Invisible backdrop to handle closing when clicking outside */}
      <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); onClose(); }} />
      
      {/* Calendar Popup - Positioned BELOW the button (top-full) and aligned LEFT (left-0) */}
      <div 
        className="absolute top-full mt-2 left-0 z-50 bg-[#111] border border-white/20 rounded-xl shadow-2xl p-4 w-72 animate-in fade-in zoom-in-95 duration-200 origin-top-left"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center mb-4 pb-2 border-b border-white/10">
          <button 
            onClick={handlePrevMonth} 
            className="p-1.5 hover:bg-white/10 rounded-full text-white/70 hover:text-white transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
          <span className="font-bold text-white text-sm tracking-wide">{monthName} {year}</span>
          <button 
            onClick={handleNextMonth} 
            className="p-1.5 hover:bg-white/10 rounded-full text-white/70 hover:text-white transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>

        {/* Days Grid Headers */}
        <div className="grid grid-cols-7 gap-1 text-center mb-2">
          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => (
              <span key={d} className="text-[10px] text-white/40 font-bold uppercase">{d}</span>
          ))}
        </div>

        {/* Days Grid */}
        <div className="grid grid-cols-7 gap-1 mb-4">
          {Array.from({ length: firstDayOfMonth }).map((_, i) => (
              <div key={`empty-${i}`} />
          ))}
          {days.map(day => {
            const dateObj = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
            
            // Check if this date is the selected one
            const isSelected = selectedDate && 
                               dateObj.getDate() === selectedDate.getDate() &&
                               dateObj.getMonth() === selectedDate.getMonth() &&
                               dateObj.getFullYear() === selectedDate.getFullYear();
                               
            // Check if this date is Today
            const isToday = dateObj.getDate() === today.getDate() &&
                            dateObj.getMonth() === today.getMonth() &&
                            dateObj.getFullYear() === today.getFullYear();

            return (
              <button
                  key={day}
                  onClick={(e) => handleDateClick(day, e)}
                  className={`h-8 w-8 flex items-center justify-center rounded-full text-xs font-medium transition-all hover:bg-white/10 ${
                    isSelected 
                      ? 'text-black font-bold shadow-lg scale-110' 
                      : isToday 
                        ? 'text-white font-bold border border-white/50' 
                        : 'text-white/80'
                  }`}
                  style={{
                     backgroundColor: isSelected ? accentColor : 'transparent',
                  }}
              >
                  {day}
              </button>
            );
          })}
        </div>

        {/* Clear Button */}
        <button 
          onClick={handleClearClick} 
          className="w-full py-3 rounded-lg bg-white/5 text-xs font-bold uppercase tracking-wider text-white/60 hover:bg-white/10 hover:text-white transition-colors border border-white/5"
        >
            Clear / Anytime
        </button>
      </div>
    </>
  );
};
