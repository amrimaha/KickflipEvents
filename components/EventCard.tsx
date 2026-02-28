
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { KickflipEvent, ThemeConfig } from '../types';
import { getVideoForEvent, CATEGORY_COLORS } from '../constants';
import { EventVibemojiRenderer } from './EventVibemojiRenderer';

interface EventCardProps {
  event: KickflipEvent;
  theme?: ThemeConfig;
  className?: string;
  onTagClick?: (tag: string) => void;
  variant?: 'default' | 'details';
  isSuperAdmin?: boolean;
  onEdit?: (event: KickflipEvent) => void;
  // New props for Dashboard flexibility
  onClick?: (event: KickflipEvent) => void;
  actionSlot?: React.ReactNode;
  footerSlot?: React.ReactNode;
  extraContent?: React.ReactNode;
  onBook?: (event: KickflipEvent) => void; // Added onBook prop
}

export const EventCard: React.FC<EventCardProps> = ({ 
  event, 
  theme, 
  className, 
  onTagClick, 
  variant = 'default', 
  isSuperAdmin, 
  onEdit,
  onClick,
  actionSlot,
  footerSlot,
  extraContent,
  onBook
}) => {
  const [showInfo, setShowInfo] = useState(false);
  const [isOverviewExpanded, setIsOverviewExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  // Track failed videos to hide them
  const [failedVideos, setFailedVideos] = useState<Set<string>>(new Set());

  // --- URL SYNCHRONIZATION ---
  useEffect(() => {
    // Only apply for default cards (feed), not dashboard or already routed details views
    if (variant !== 'default' || !!onClick) return;

    if (showInfo) {
        // When opening, push the event ID to the URL
        const url = new URL(window.location.href);
        if (url.searchParams.get('event') !== event.id) {
            url.searchParams.set('event', event.id);
            window.history.pushState({ eventId: event.id }, '', url.toString());
        }
    } else {
        // When closing, revert to root ONLY if we are currently on this event's URL
        const url = new URL(window.location.href);
        if (url.searchParams.get('event') === event.id) {
            url.searchParams.delete('event');
            window.history.pushState({}, '', url.toString());
        }
    }

    // Handle Browser Back Button
    const handlePopState = () => {
        const url = new URL(window.location.href);
        const currentEventId = url.searchParams.get('event');
        
        // If the URL no longer matches this event, close the modal
        if (currentEventId !== event.id && showInfo) {
            setShowInfo(false);
        }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [showInfo, event.id, variant, onClick]);

  // Helper to normalize media list based on available props
  const resolveMediaList = useCallback(() => {
    // 1. If media array exists and has items, use it
    if (event.media && event.media.length > 0) {
       return event.media;
    }
    // 2. Legacy support for single videoUrl
    if (event.videoUrl) {
       return [{ src: event.videoUrl, type: 'video' as const, url: event.videoUrl }];
    }
    // 3. Legacy support for single imageUrl
    if (event.imageUrl) {
       return [{ src: event.imageUrl, type: 'image' as const, url: event.imageUrl }];
    }
    // 4. Fallback Category Video
    const fallback = getVideoForEvent(event.category, event.id);
    return [{ src: fallback, type: 'video' as const, url: fallback }];
  }, [event]);

  const mediaList = useMemo(() => resolveMediaList(), [resolveMediaList]);
  
  // Carousel State
  const [currentIndex, setCurrentIndex] = useState(0);
  
  useEffect(() => {
      setCurrentIndex(0);
      setFailedVideos(new Set());
  }, [mediaList.length, event.id]);

  useEffect(() => {
      setIsOverviewExpanded(false);
  }, [event.id]);

  const currentMedia = mediaList[currentIndex];
  
  const [videoNode, setVideoNode] = useState<HTMLVideoElement | null>(null);

  // --- AUTOPLAY LOGIC ---
  useEffect(() => {
    if (!videoNode || variant === 'details' || currentMedia.type !== 'video') return;

    videoNode.muted = true;
    videoNode.defaultMuted = true;
    videoNode.playsInline = true;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            videoNode.play().catch(() => { videoNode.muted = true; });
          } else {
            videoNode.pause();
          }
        });
      },
      { threshold: 0.2 }
    );

    observer.observe(videoNode);
    videoNode.play().catch(() => {});

    return () => observer.disconnect();
  }, [videoNode, variant, currentMedia.type, currentIndex]); 

  // --- INTERACTION HANDLERS ---
  const handleClick = (e: React.MouseEvent) => {
      if (onClick) {
          e.stopPropagation();
          onClick(event);
      } else {
          setShowInfo(true);
      }
  };

  const handleNext = (e?: React.MouseEvent) => {
    if(e) e.stopPropagation();
    setCurrentIndex((prev) => (prev + 1) % mediaList.length);
  };

  const handlePrev = (e?: React.MouseEvent) => {
    if(e) e.stopPropagation();
    setCurrentIndex((prev) => (prev - 1 + mediaList.length) % mediaList.length);
  };

  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
      setTouchEnd(null);
      setTouchStart(e.targetTouches[0].clientX);
  }

  const onTouchMove = (e: React.TouchEvent) => {
      setTouchEnd(e.targetTouches[0].clientX);
  }

  const onTouchEnd = () => {
      if (!touchStart || !touchEnd) return;
      const distance = touchStart - touchEnd;
      const isLeftSwipe = distance > 50;
      const isRightSwipe = distance < -50;
      
      if (isLeftSwipe) handleNext();
      if (isRightSwipe) handlePrev();
      
      setTouchStart(null);
      setTouchEnd(null);
  }

  const handleShare = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const permalink = `${window.location.origin}/?event=${event.id}`;
    if (navigator.share) {
      navigator.share({
        title: event.title,
        text: `Check out ${event.title} at ${event.location}! Found on Kickflip.`,
        url: permalink,
      }).catch(console.error);
    } else {
      navigator.clipboard.writeText(permalink);
      alert("Link copied to clipboard!");
    }
  };

  const accentColor = theme?.accentColor || '#34d399';
  const categoryColor = CATEGORY_COLORS[event.category] || '#9ca3af';

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

  // --- DISPLAY FIELD LOGIC ---
  const displayDate = useMemo(() => {
    if (event.startDate) {
        let dateObj: Date;
        if (event.startDate.length === 10 && event.startDate.indexOf('-') === 4) {
            const [y, m, d] = event.startDate.split('-').map(Number);
            dateObj = new Date(y, m - 1, d);
        } else {
            dateObj = new Date(event.startDate);
        }

        const dateStr = dateObj.toLocaleDateString('en-US', {month:'short', day:'numeric'});
        
        let timeStr = event.startTime;
        if (timeStr) {
            if (timeStr.indexOf(':') > -1 && !timeStr.toLowerCase().includes('m')) {
                const [h, m] = timeStr.split(':');
                const hour = parseInt(h);
                if (!isNaN(hour)) {
                    const ampm = hour >= 12 ? 'PM' : 'AM';
                    const h12 = hour % 12 || 12;
                    timeStr = `${h12}:${m} ${ampm}`;
                }
            }
            return `${dateStr} @ ${timeStr}`;
        }
        return dateStr;
    }
    return event.date;
  }, [event.startDate, event.startTime, event.date]);

  const displayLocation = event.locationName || event.location;
  const displayDescription = event.vibeDescription || event.description;

  // --- RENDER HELPERS ---
  const renderDots = () => {
      if (mediaList.length <= 1) return null;
      return (
          <div className="absolute bottom-4 left-0 right-0 z-30 flex justify-center gap-1.5 pointer-events-none">
              {mediaList.map((_, idx) => (
                  <div 
                    key={idx} 
                    className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                        idx === currentIndex ? 'bg-white w-3' : 'bg-white/40'
                    }`}
                  />
              ))}
          </div>
      );
  };
  
  const renderArrows = (showOnHover = true) => {
     if (mediaList.length <= 1) return null;
     return (
        <>
           <button 
             onClick={handlePrev} 
             className={`absolute left-2 top-1/2 -translate-y-1/2 z-30 p-2 rounded-full bg-black/30 text-white/80 hover:bg-black/60 hover:text-white transition-all backdrop-blur-sm ${showOnHover ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}
             aria-label="Previous"
           >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
           </button>
           <button 
             onClick={handleNext} 
             className={`absolute right-2 top-1/2 -translate-y-1/2 z-30 p-2 rounded-full bg-black/30 text-white/80 hover:bg-black/60 hover:text-white transition-all backdrop-blur-sm ${showOnHover ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}
             aria-label="Next"
           >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
           </button>
        </>
     );
  };

  const renderMediaContent = (isDetail = false) => {
      const item = mediaList[currentIndex];
      const commonClasses = "w-full h-full object-cover transition-opacity duration-300";
      const isFailed = failedVideos.has(item.url);
      
      if (item.type === 'image' || isFailed) {
         return (
            <div className="w-full h-full relative bg-gray-900" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
              <img 
                 src={item.type === 'image' ? item.url : (event.imageUrl || 'https://images.pexels.com/photos/1105666/pexels-photo-1105666.jpeg')} 
                 className={commonClasses}
                 alt={event.title}
                 onError={(e) => {
                     e.currentTarget.src = 'https://images.pexels.com/photos/1105666/pexels-photo-1105666.jpeg';
                 }}
              />
            </div>
         );
      }
      
      return (
        <div 
           className="w-full h-full relative bg-gray-900" 
           onTouchStart={onTouchStart} 
           onTouchMove={onTouchMove} 
           onTouchEnd={onTouchEnd}
        >
           <video
              key={`${item.url}-${currentIndex}`} 
              ref={!isDetail ? setVideoNode : undefined}
              src={item.url}
              className={commonClasses}
              muted
              loop
              playsInline
              autoPlay={true}
              webkit-playsinline="true"
              onError={() => {
                  console.warn(`Card video failed: ${item.url}`);
                  setFailedVideos(prev => new Set(prev).add(item.url));
              }}
           />
        </div>
      );
  };

  const renderDetailContent = () => (
    <div 
        className={`relative w-full bg-[#111] flex flex-col ${variant === 'details' ? 'h-full' : 'max-h-[90vh] rounded-2xl border border-white/10 shadow-2xl'} overflow-hidden animate-in zoom-in-95 duration-300`}
        onClick={(e) => e.stopPropagation()}
    >
        {!onClick && variant !== 'details' && (
            <>
                <button 
                onClick={() => setShowInfo(false)}
                className="absolute top-4 right-4 z-50 p-2 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors backdrop-blur-md border border-white/10"
                >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>

                 <button 
                 onClick={(e) => handleShare(e)}
                 className="absolute top-4 right-16 z-50 p-2 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors backdrop-blur-md border border-white/10"
                 >
                 <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
                 </button>
            </>
        )}

        <div className="w-full h-full overflow-y-auto custom-scrollbar flex flex-col">
            <div className="relative h-64 md:h-80 w-full flex-shrink-0 bg-gray-900 group">
                {renderMediaContent(true)}
                {renderArrows(false)} 
                {renderDots()}

                <div className="absolute inset-0 bg-gradient-to-t from-[#111] via-transparent to-transparent opacity-90 pointer-events-none" />
                
                <div className="absolute bottom-0 left-0 w-full p-6 md:p-8 pointer-events-none">
                    <div className="flex items-center gap-3 mb-2">
                        <span 
                        className="px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider text-black"
                        style={{ backgroundColor: categoryColor }}
                        >
                        {event.category}
                        </span>
                        {event.price && (
                            <span className="px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider bg-white/10 text-white border border-white/20">
                            {event.price}
                            </span>
                        )}
                        {isSuperAdmin && onEdit && (
                            <button 
                                onClick={(e) => { e.stopPropagation(); onEdit(event); }}
                                className="pointer-events-auto px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider bg-red-600 text-white hover:bg-red-500 transition-colors shadow-lg"
                            >
                                Admin Edit
                            </button>
                        )}
                        {event.origin === 'crawl' && (
                            <span className="px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider bg-indigo-600/80 text-white border border-indigo-400/30 backdrop-blur-md">
                                External
                            </span>
                        )}
                    </div>
                    <div className="flex items-end justify-between">
                         <h2 className="text-3xl md:text-4xl font-black text-white leading-none mb-1 drop-shadow-xl">{event.title}</h2>
                         {event.vibemoji && (
                             <div className="w-16 h-16 pointer-events-auto">
                                 <EventVibemojiRenderer config={event.vibemoji} className="w-full h-full drop-shadow-lg" />
                             </div>
                         )}
                    </div>
                    {event.organizer && (
                        <p className="text-white/60 text-sm font-medium">Hosted by <span className="text-white">{event.organizer}</span></p>
                    )}
                </div>
            </div>

            <div className="p-6 md:p-8 flex flex-col gap-6 flex-1">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <h4 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-2">When & Where</h4>
                        <p className="text-xl font-bold text-white mb-1">{displayDate}</p>
                        <p className="text-lg text-white/80">{event.address || displayLocation}</p>
                        <div className="flex flex-wrap gap-2 mt-4">
                        {event.vibeTags.map((tag, i) => (
                            <span key={i} className="text-xs px-2 py-1 rounded border border-white/10 text-white/50">
                                {tag}
                            </span>
                        ))}
                        </div>
                    </div>

                    <div>
                        <h4 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-2">The Vibe</h4>
                        <p className="text-base text-white/90 leading-relaxed">
                            {displayDescription}
                        </p>
                    </div>
                </div>

                {extraContent && (
                    <div className="pt-4 border-t border-white/10">
                        {extraContent}
                    </div>
                )}

                {event.overview && (
                    <div className="pt-4 border-t border-white/10">
                        <h4 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-2">What to Expect</h4>
                        <p className="text-sm text-white/80 leading-relaxed whitespace-pre-line transition-all">
                            {isOverviewExpanded || event.overview.length <= 120 
                                ? event.overview 
                                : `${event.overview.slice(0, 120).trim()}...`
                            }
                        </p>
                        {event.overview.length > 120 && (
                            <button 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setIsOverviewExpanded(!isOverviewExpanded);
                                }}
                                className="text-xs font-bold mt-2 uppercase tracking-wider hover:opacity-80 transition-opacity"
                                style={{ color: accentColor }}
                            >
                                {isOverviewExpanded ? "Show Less" : "Show More"}
                            </button>
                        )}
                    </div>
                )}

                <div className="w-full h-64 rounded-xl overflow-hidden border border-white/10 bg-white/5 relative group flex-shrink-0 mt-4">
                    <iframe 
                        width="100%" 
                        height="100%" 
                        frameBorder="0" 
                        style={{ border: 0, filter: 'invert(90%) hue-rotate(180deg)' }} 
                        src={`https://www.google.com/maps?q=${encodeURIComponent(event.address || displayLocation)}&output=embed&z=14`}
                        allowFullScreen
                        loading="lazy"
                        className="opacity-60 group-hover:opacity-100 transition-opacity"
                    ></iframe>
                    
                    <div className="absolute top-4 left-4 right-4 z-10 pointer-events-none">
                        <div className="inline-block bg-black/80 backdrop-blur-md px-4 py-3 rounded-xl border border-white/10 shadow-lg">
                            <p className="text-sm font-bold text-white leading-tight">{displayLocation}</p>
                            {event.address && (
                                <p className="text-xs text-white/60 mt-0.5">{event.address}</p>
                            )}
                        </div>
                    </div>
                </div>

                {/* Footer / CTA Area */}
                <div className="pt-6 mt-auto">
                    {footerSlot ? footerSlot : (
                        <button 
                            onClick={ctaAction}
                            className="block w-full py-4 rounded-xl text-center font-bold text-black text-lg transition-transform hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-white/5"
                            style={{ backgroundColor: accentColor }}
                        >
                            {ctaText}
                        </button>
                    )}
                </div>
            </div>
        </div>
    </div>
  );

  if (variant === 'details') {
    return (
       <div className={`overflow-hidden rounded-2xl ${className}`}>
          {renderDetailContent()}
       </div>
    );
  }

  // --- DEFAULT CARD VARIANT ---
  return (
    <>
      <div
        className={className || ''}
        style={{
          width: className ? undefined : '300px',
          background: '#111113',
          borderRadius: '16px',
          border: isHovered ? `1px solid ${categoryColor}` : '1px solid rgba(255,255,255,0.08)',
          boxShadow: isHovered
            ? `0 8px 32px rgba(0,0,0,0.4), 0 0 20px ${categoryColor}40`
            : '0 2px 8px rgba(0,0,0,0.3)',
          overflow: 'hidden',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          flexShrink: 0,
          transform: isHovered ? 'scale(1.02)' : 'scale(1)',
          position: 'relative',
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={handleClick}
      >
        {/* Image area — 16:9 ratio via padding trick */}
        <div style={{ position: 'relative', paddingBottom: '62%', overflow: 'hidden', background: '#1a1a1c' }}>
          <div style={{ position: 'absolute', inset: 0 }}>
            {renderMediaContent(false)}
          </div>

          {renderArrows(true)}
          {renderDots()}

          {/* Gradient fade at bottom of image */}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, height: '45%',
            background: 'linear-gradient(to top, rgba(17,17,19,0.75), transparent)',
            pointerEvents: 'none', zIndex: 10,
          }} />

          {/* Category badge */}
          <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 20 }}>
            <span style={{
              backgroundColor: categoryColor,
              padding: '3px 8px', borderRadius: '6px',
              fontSize: '10px', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.06em', color: '#000',
            }}>
              {event.category}
            </span>
          </div>

          {/* Price badge */}
          {event.price && !isSuperAdmin && !actionSlot && (
            <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 20 }}>
              <span style={{
                padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                color: 'rgba(255,255,255,0.9)', background: 'rgba(0,0,0,0.55)',
                border: '1px solid rgba(255,255,255,0.2)', backdropFilter: 'blur(8px)',
              }}>
                {event.price}
              </span>
            </div>
          )}

          {/* Action slot */}
          {actionSlot && (
            <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 50 }} onClick={(e) => e.stopPropagation()}>
              {actionSlot}
            </div>
          )}

          {/* Admin edit button */}
          {isSuperAdmin && onEdit && !actionSlot && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(event); }}
              style={{ position: 'absolute', top: 10, right: 10, zIndex: 50 }}
              className="p-2 bg-red-600 text-white rounded-lg text-[10px] font-black uppercase tracking-widest shadow-xl border border-red-400/50 hover:bg-red-500 transition-colors"
            >
              Edit
            </button>
          )}
        </div>

        {/* Content below image */}
        <div style={{ padding: '12px 14px 14px' }}>
          {/* Vibe tags */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {event.vibeTags.slice(0, 3).map((tag, i) => (
              <button
                key={i}
                onClick={(e) => {
                  if (onTagClick) { e.stopPropagation(); onTagClick(tag); }
                }}
                style={{
                  fontSize: '10px', fontWeight: 700,
                  padding: '2px 7px', borderRadius: '4px',
                  border: '1px solid rgba(255,255,255,0.22)',
                  color: 'rgba(255,255,255,0.7)', background: 'transparent',
                  cursor: onTagClick ? 'pointer' : 'default',
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                  transition: 'all 0.15s',
                }}
              >
                #{tag}
              </button>
            ))}
          </div>

          {/* Title */}
          <h3 style={{
            fontSize: '15px', fontWeight: 700, color: 'white', lineHeight: 1.3,
            margin: '0 0 5px', overflow: 'hidden', display: '-webkit-box',
            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          }}>
            {event.title}
          </h3>

          {/* Date */}
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.4)', flexShrink: 0 }} />
            {displayDate}
          </p>

          {/* Location */}
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.42)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            @{event.city || displayLocation}
          </p>

          {/* Vibemoji */}
          {event.vibemoji && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
              <div style={{ width: 30, height: 30 }}>
                <EventVibemojiRenderer config={event.vibemoji} className="w-full h-full" />
              </div>
            </div>
          )}

          {extraContent && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              {extraContent}
            </div>
          )}
        </div>
      </div>

      {!onClick && showInfo && createPortal(
        <div className="fixed inset-0 z-[100]">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/85 backdrop-blur-md animate-in fade-in duration-300"
            onClick={() => setShowInfo(false)}
          />
          {/* Mobile: slide up from bottom */}
          <div className="md:hidden absolute bottom-0 left-0 right-0 max-h-[90vh] rounded-t-3xl overflow-hidden animate-in slide-in-from-bottom duration-300">
            {renderDetailContent()}
          </div>
          {/* Desktop: centered modal */}
          <div className="hidden md:flex absolute inset-0 items-center justify-center p-6" onClick={() => setShowInfo(false)}>
            <div
              className="relative w-full max-w-2xl h-[80vh] animate-in zoom-in-95 duration-300"
              onClick={(e) => e.stopPropagation()}
            >
              {renderDetailContent()}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
