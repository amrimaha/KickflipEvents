
import React from 'react';
import { VibemojiConfig } from '../types';

export const VIBEMOJIS = [
  { id: 'duck', label: 'Duck' },
  { id: 'arcade', label: 'Arcade' },
  { id: 'ghost', label: 'Ghost' },
  { id: 'pizza', label: 'Pizza' },
  { id: 'bolt', label: 'Volt' },
];

interface VibemojiRendererProps {
  id?: string; // For legacy support
  config?: VibemojiConfig; // For new customization
  className?: string;
}

export const VibemojiRenderer: React.FC<VibemojiRendererProps> = ({ id, config, className }) => {
  // Backwards compatibility or default
  const baseId = config?.baseId || id || 'duck';
  const hat = config?.hat || 'none';
  const outfit = config?.outfit || 'none';
  const shoes = config?.shoes || 'none';
  const primaryColor = config?.primaryColor || '#ec4899'; // Default accent

  const renderHat = () => {
    switch (hat) {
      case 'beanie':
        return <path d="M30 40 C30 20 70 20 70 40 L30 40 Z" fill={primaryColor} stroke="white" strokeWidth="2" />;
      case 'bucket':
        return <path d="M25 45 L30 35 H70 L75 45 H85 L80 30 H20 L15 45 Z" fill={primaryColor} stroke="white" strokeWidth="2"/>;
      case 'cap':
         return (
             <g>
                 <path d="M30 40 C30 25 70 25 70 40 Z" fill={primaryColor} />
                 <rect x="60" y="38" width="25" height="4" fill={primaryColor} rx="2" />
             </g>
         );
      case 'backwards':
          return (
              <g>
                  <path d="M30 40 C30 25 70 25 70 40 Z" fill={primaryColor} />
                  <rect x="15" y="38" width="25" height="4" fill={primaryColor} rx="2" />
              </g>
          );
      case 'crown':
         return <path d="M30 40 L30 25 L40 35 L50 20 L60 35 L70 25 L70 40 Z" fill="#fbbf24" stroke="white" strokeWidth="2"/>;
      default: return null;
    }
  };

  const renderOutfit = () => {
    // Renders generically over the "chest" area (approx 45,70 to 55,70)
    switch(outfit) {
        case 'hoodie':
            return <path d="M35 70 L30 90 H70 L65 70 Z" fill={primaryColor} opacity="0.9" />;
        case 'tee':
             return <rect x="35" y="70" width="30" height="20" fill="white" opacity="0.5" rx="2" />;
        case 'jacket':
             return (
               <g>
                 <path d="M35 70 L30 90 H45 V70 Z" fill={primaryColor} />
                 <path d="M65 70 L70 90 H55 V70 Z" fill={primaryColor} />
                 <rect x="45" y="70" width="10" height="20" fill="white" opacity="0.2" />
               </g>
             );
        case 'flannel':
            return (
              <g>
                 <rect x="35" y="70" width="30" height="20" fill={primaryColor} opacity="0.6" />
                 <line x1="45" y1="70" x2="45" y2="90" stroke="black" strokeWidth="1" opacity="0.5" />
                 <line x1="55" y1="70" x2="55" y2="90" stroke="black" strokeWidth="1" opacity="0.5" />
                 <line x1="35" y1="80" x2="65" y2="80" stroke="black" strokeWidth="1" opacity="0.5" />
              </g>
            );
        default: return null;
    }
  };

  const renderShoes = () => {
      // Renders at the bottom feet area
      switch(shoes) {
          case 'skate':
              return (
                  <g>
                      <rect x="25" y="90" width="15" height="8" rx="2" fill="white" />
                      <rect x="60" y="90" width="15" height="8" rx="2" fill="white" />
                  </g>
              );
          case 'boots':
               return (
                  <g>
                      <path d="M25 85 L25 98 H40 L40 85 Z" fill="#78350f" />
                      <path d="M60 85 L60 98 H75 L75 85 Z" fill="#78350f" />
                  </g>
               );
          case 'high-tops':
                return (
                  <g>
                      <rect x="28" y="85" width="12" height="12" fill={primaryColor} />
                      <rect x="28" y="97" width="12" height="3" fill="white" />
                      <rect x="63" y="85" width="12" height="12" fill={primaryColor} />
                      <rect x="63" y="97" width="12" height="3" fill="white" />
                  </g>
                );
          default: return null;
      }
  }

  switch (baseId) {
    case 'arcade':
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <g transform="rotate(5, 50, 50)">
            <rect x="25" y="35" width="50" height="30" rx="4" fill={primaryColor} />
            <rect x="20" y="45" width="5" height="10" fill={primaryColor} />
            <rect x="75" y="45" width="5" height="10" fill={primaryColor} />
            <rect x="35" y="45" width="10" height="10" fill="black" />
            <rect x="55" y="45" width="10" height="10" fill="black" />
            <rect x="25" y="70" width="10" height="10" fill={primaryColor} />
            <rect x="65" y="70" width="10" height="10" fill={primaryColor} />
            {renderHat()}
            {renderOutfit()}
            {renderShoes()}
          </g>
        </svg>
      );
    case 'ghost':
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <g transform="rotate(-5, 50, 50)">
            <path d="M20 50 C20 20 80 20 80 50 V80 L70 70 L60 80 L50 70 L40 80 L30 70 L20 80 Z" fill={primaryColor} />
            <circle cx="35" cy="45" r="8" fill="white" />
            <circle cx="65" cy="45" r="8" fill="white" />
            <circle cx="37" cy="45" r="3" fill="blue" />
            <circle cx="67" cy="45" r="3" fill="blue" />
            {renderHat()}
            {renderOutfit()}
            {renderShoes()}
          </g>
        </svg>
      );
    case 'pizza':
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
           <g transform="rotate(10, 50, 50)">
             <path d="M10 20 Q50 0 90 20 L50 90 Z" fill="#fbbf24" stroke="#d97706" strokeWidth="4" strokeLinejoin="round" />
             <path d="M18 25 Q50 10 82 25 L50 80 Z" fill="#fcd34d" />
             <circle cx="50" cy="35" r="6" fill="#ef4444" />
             <circle cx="35" cy="50" r="5" fill="#ef4444" />
             <circle cx="65" cy="55" r="5" fill="#ef4444" />
             {renderHat()}
             {renderShoes()}
           </g>
        </svg>
      );
    case 'bolt':
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
           <g transform="rotate(-10, 50, 50)">
             <path d="M55 5 L30 50 H50 L45 95 L70 50 H50 L55 5 Z" fill={primaryColor} stroke="white" strokeWidth="3" strokeLinejoin="round"/>
             {renderHat()}
           </g>
        </svg>
      );
    case 'duck':
    default:
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <g transform="rotate(-5, 50, 50)">
            <path d="M15 80C15 80 20 85 50 85C80 85 85 80 85 80" stroke="white" strokeWidth="5" strokeLinecap="round"/>
            <circle cx="25" cy="88" r="5" fill="#34d399"/>
            <circle cx="75" cy="88" r="5" fill="#34d399"/>
            <path d="M25 65C25 65 30 40 45 35C60 30 70 35 75 45C80 55 75 65 65 70H35L25 65Z" fill={primaryColor} />
            <circle cx="65" cy="40" r="14" fill={primaryColor}/>
            <path d="M78 38L90 40L80 45Z" fill="#fbbf24"/>
            <circle cx="70" cy="38" r="2.5" fill="black"/>
            <circle cx="71" cy="37" r="1" fill="white"/>
            {renderHat()}
            {renderOutfit()}
            {renderShoes()}
          </g>
        </svg>
      );
  }
};
