
import React from 'react';
import { KickflipEvent, ThemeConfig } from '../types';
import { EventCard } from './EventCard';
import { VideoBackground } from './VideoBackground';

interface PublicEventViewProps {
  event: KickflipEvent;
  onBack: () => void;
  theme: ThemeConfig;
  onBook?: (event: KickflipEvent) => void;
}

export const PublicEventView: React.FC<PublicEventViewProps> = ({ event, onBack, theme, onBook }) => {
  // Logic to determine CTA text (mirrors EventCard logic)
  const hasPrice = event.price && event.price.trim().length > 0;
  const isFree = hasPrice ? (event.price!.toLowerCase().includes('free') || event.price!.toLowerCase().includes('no cover')) : false;
  
  // Custom CTA Logic
  // Only events created natively on Kickflip (origin='user' or has creatorId) get the booking flow.
  // Featured, crawled, or legacy events link out.
  const isNative = event.origin === 'user' || !!event.creatorId;

  let ctaText = "Learn More";
  let ctaAction = () => { window.open(event.link, '_blank'); };

  if (isNative && onBook) {
      // Native Kickflip Event -> Internal Checkout
      ctaText = (hasPrice && !isFree) ? "Book Now" : "RSVP Now";
      ctaAction = () => onBook(event);
  } else {
      // External/Featured/Crawled -> External Link
      if (event.origin === 'crawl') {
          ctaText = `Visit ${event.crawlSource || 'Website'}`;
      } else if (hasPrice && !isFree) {
          ctaText = "Get Tickets";
      } else {
          ctaText = "View Info";
      }
  }

  // Check if link is external (only used if falling back to default action)
  const isExternalLink = event.link && (event.link.startsWith('http') || event.link.startsWith('www'));

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-center overflow-hidden">
        {/* Background - Use event specific if possible, else theme */}
        <VideoBackground 
            src={event.videoUrl || theme.backgroundUrl} 
            type={event.videoUrl ? 'video' : 'image'} // Assume videoUrl is video, simple check
            isOverlayDark={true}
        />
        
        <div className="relative z-10 w-full h-full max-w-4xl p-4 md:p-8 flex flex-col items-center justify-center animate-in zoom-in-95 duration-500">
            <div className="w-full h-full max-h-[85vh] relative shadow-2xl rounded-2xl overflow-hidden">
                <EventCard 
                    event={event} 
                    variant="details" 
                    className="w-full h-full" 
                    onBook={onBook} // Pass the booking handler down just in case
                    footerSlot={
                        <div className="flex flex-col gap-3 w-full">
                            <button 
                                onClick={ctaAction}
                                className="block w-full py-4 rounded-xl text-center font-bold text-black text-lg transition-transform hover:scale-[1.02] active:scale-[0.98] shadow-lg"
                                style={{ backgroundColor: theme.accentColor }}
                            >
                                {ctaText}
                            </button>
                            <button 
                                onClick={onBack}
                                className="flex-1 py-4 font-black uppercase tracking-widest text-xs rounded-xl hover:scale-[1.02] transition-transform border border-white/10 bg-black/40 text-white hover:bg-white/10 backdrop-blur-md"
                            >
                                Return to Feed
                            </button>
                        </div>
                    }
                />
            </div>
            
             <button 
                onClick={onBack}
                className="absolute top-6 left-6 p-3 bg-black/50 text-white rounded-full hover:bg-white hover:text-black transition-all border border-white/10 backdrop-blur-md z-50 md:hidden"
            >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            </button>
        </div>
    </div>
  );
};
