import React, { useEffect, useRef } from 'react';

interface VideoBackgroundProps {
  src: string;
  type?: 'video' | 'image';
  isOverlayDark?: boolean;
  onVideoEnded?: () => void; // Optional: could serve as a trigger for rotation
  onVideoError?: () => void; // Trigger to skip if video is broken
}

export const VideoBackground: React.FC<VideoBackgroundProps> = ({ 
  src, 
  type = 'video',
  isOverlayDark = true,
  onVideoError 
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Strictly enforce muted state on the DOM element to satisfy autoplay policies
    if (videoRef.current && type === 'video') {
      videoRef.current.muted = true;
      videoRef.current.defaultMuted = true;
      
      const playPromise = videoRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          // Autoplay failed - usually user interaction policy or low power mode
          console.warn("Hero video autoplay prevented:", error);
        });
      }
    }
  }, [src, type]);

  if (type === 'image') {
    return (
      <div className="fixed inset-0 w-full h-full overflow-hidden z-0 bg-black">
        <img
          key={src}
          className="absolute top-1/2 left-1/2 min-w-full min-h-full w-auto h-auto -translate-x-1/2 -translate-y-1/2 object-cover transition-opacity duration-1000 animate-in fade-in"
          src={src}
          alt="Background"
          onError={() => {
            console.warn(`Image failed to load: ${src}`);
            if (onVideoError) onVideoError();
          }}
        />
        {/* Dark Overlay for Readability */}
        <div 
          className={`absolute inset-0 pointer-events-none transition-colors duration-1000 ${
            isOverlayDark ? 'bg-black/70' : 'bg-black/30'
          }`} 
        />
        {/* Bottom Gradient for Chat Bar Integration */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent pointer-events-none" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden z-0 bg-black">
      <video
        ref={videoRef}
        key={src} // Force component unmount/remount on source change
        className="absolute top-1/2 left-1/2 min-w-full min-h-full w-auto h-auto -translate-x-1/2 -translate-y-1/2 object-cover transition-opacity duration-1000"
        src={src}
        autoPlay
        muted
        loop
        playsInline
        webkit-playsinline="true"
        preload="auto"
        onError={() => {
            console.warn(`Video failed to load: ${src}`);
            if (onVideoError) onVideoError();
        }}
      />
      {/* Dark Overlay for Readability */}
      <div 
        className={`absolute inset-0 pointer-events-none transition-colors duration-1000 ${
          isOverlayDark ? 'bg-black/70' : 'bg-black/30'
        }`} 
      />
      {/* Bottom Gradient for Chat Bar Integration */}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent pointer-events-none" />
    </div>
  );
};