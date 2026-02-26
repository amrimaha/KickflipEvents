
import React from 'react';
import { VibemojiConfig } from '../types';

interface EventVibemojiRendererProps {
  config?: VibemojiConfig;
  className?: string;
}

export const EventVibemojiRenderer: React.FC<EventVibemojiRendererProps> = ({ config, className }) => {
  // Safe destructuring with defaults in case config is null/undefined
  const { 
    hat = 'none', 
    outfit = 'none', 
    pants = 'none',
    shoes = 'none', 
    expression = 'neutral',
    glasses = 'none',
    jewelry = 'none',
    primaryColor = '#34d399',
    skinTone = '#fca5a5' // Default Light
  } = config || {};
  
  const strokeColor = '#000000';

  // --- ACCESSORY RENDERERS ---
  
  const renderHat = () => {
    switch(hat) {
      case 'beanie':
        return <path d="M35 35 C35 25 65 25 65 35 L65 40 H35 L35 35 Z" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />;
      case 'bucket':
        return <path d="M38 38 L40 28 H60 L62 38 H70 L68 25 H32 L30 38 H38 Z" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />;
      case 'cap':
        return (
          <g>
            <path d="M35 35 C35 28 65 28 65 35 L65 40 H35 Z" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />
            <rect x="60" y="38" width="15" height="4" fill={primaryColor} stroke={strokeColor} strokeWidth="2" rx="2" />
          </g>
        );
      case 'backwards':
        return (
          <g>
            <path d="M35 35 C35 28 65 28 65 35 L65 40 H35 Z" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />
            <rect x="25" y="38" width="15" height="4" fill={primaryColor} stroke={strokeColor} strokeWidth="2" rx="2" />
          </g>
        );
      case 'crown':
        return <path d="M35 38 L35 25 L42 32 L50 20 L58 32 L65 25 L65 38 Z" fill="#fbbf24" stroke={strokeColor} strokeWidth="2" />;
      case 'halo':
        return <ellipse cx="50" cy="22" rx="15" ry="4" fill="none" stroke="#fbbf24" strokeWidth="3" />;
      default: return null;
    }
  };

  const renderGlasses = () => {
    const yPos = 48;
    switch(glasses) {
      case 'sunnies':
        return (
          <g>
            <path d="M35 45 H65" stroke="black" strokeWidth="1" />
            <path d="M38 45 Q38 55 48 45 Z" fill="black" />
            <path d="M52 45 Q52 55 62 45 Z" fill="black" />
          </g>
        );
      case 'retro':
        return (
          <g>
            <line x1="35" y1="48" x2="65" y2="48" stroke="black" strokeWidth="1" />
            <circle cx="43" cy={yPos} r="5" fill="#222" stroke="white" strokeWidth="1" />
            <circle cx="57" cy={yPos} r="5" fill="#222" stroke="white" strokeWidth="1" />
          </g>
        );
      case 'nerd':
        return (
          <g>
            <line x1="48" y1="48" x2="52" y2="48" stroke="black" strokeWidth="2" />
            <circle cx="43" cy={yPos} r="6" fill="none" stroke="black" strokeWidth="2" />
            <circle cx="57" cy={yPos} r="6" fill="none" stroke="black" strokeWidth="2" />
          </g>
        );
      case 'star':
        return (
           <g>
             <line x1="35" y1="48" x2="65" y2="48" stroke="#fbbf24" strokeWidth="1" />
             <path d="M43 42 L45 48 L49 48 L45 51 L46 56 L43 53 L40 56 L41 51 L37 48 H41 Z" fill="#fbbf24" stroke="black" strokeWidth="0.5" />
             <path d="M57 42 L59 48 L63 48 L59 51 L60 56 L57 53 L54 56 L55 51 L51 48 H55 Z" fill="#fbbf24" stroke="black" strokeWidth="0.5" />
           </g>
        );
      default: return null;
    }
  };

  const renderJewelry = () => {
    switch(jewelry) {
      case 'chain':
        return <path d="M38 65 Q50 75 62 65" fill="none" stroke="#fbbf24" strokeWidth="3" />;
      case 'studs':
        return (
          <g>
             {/* Small dots on ears (headphones cover ears usually, but this adds detail if headphones move/change) */}
             {/* Placing slightly outside usual ear zone for visibility under headphones */}
             <circle cx="28" cy="50" r="2" fill="#fbbf24" />
             <circle cx="72" cy="50" r="2" fill="#fbbf24" />
          </g>
        );
      case 'hoops':
         return (
           <g>
             <circle cx="30" cy="52" r="3" fill="none" stroke="#fbbf24" strokeWidth="1.5" />
             <circle cx="70" cy="52" r="3" fill="none" stroke="#fbbf24" strokeWidth="1.5" />
           </g>
         );
      default: return null;
    }
  };

  const renderOutfit = () => {
    switch(outfit) {
      case 'tee':
        return (
           <g>
              <rect x="35" y="65" width="30" height="20" fill="white" stroke={strokeColor} strokeWidth="2" />
              <circle cx="50" cy="75" r="4" fill={primaryColor} />
              <path d="M45 78 L55 78" stroke={primaryColor} strokeWidth="2" />
           </g>
        );
      case 'hoodie':
         return (
             <g>
                <path d="M32 65 L30 85 H70 L68 65 Z" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />
                <path d="M45 65 V85" stroke={strokeColor} strokeWidth="1" opacity="0.5" />
                <path d="M55 65 V85" stroke={strokeColor} strokeWidth="1" opacity="0.5" />
                {/* Hood strings */}
                <path d="M46 65 V72" stroke="white" strokeWidth="2" />
                <path d="M54 65 V72" stroke="white" strokeWidth="2" />
             </g>
         );
      case 'flannel':
          return (
             <g>
                <rect x="35" y="65" width="30" height="20" fill="#cc4444" stroke={strokeColor} strokeWidth="2" />
                <line x1="45" y1="65" x2="45" y2="85" stroke="black" strokeWidth="1" />
                <line x1="55" y1="65" x2="55" y2="85" stroke="black" strokeWidth="1" />
                <line x1="35" y1="75" x2="65" y2="75" stroke="black" strokeWidth="1" />
             </g>
          );
      case 'jacket': 
          return (
             <g>
                <rect x="33" y="65" width="34" height="20" fill="#222" stroke={strokeColor} strokeWidth="2" />
                <path d="M33 65 L43 85" stroke={primaryColor} strokeWidth="2" />
                <path d="M67 65 L57 85" stroke={primaryColor} strokeWidth="2" />
                <rect x="48" y="65" width="4" height="20" fill="white" opacity="0.2" />
             </g>
          );
      default: // Basic body if none
        return <rect x="35" y="65" width="30" height="20" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />;
    }
  };

  const renderPants = () => {
      // Legs are from y=80 to y=90 usually (before shoes)
      // Base legs are lines, we'll replace or overlay based on pants style
      const pantsColor = '#1e3a8a'; // denim default

      switch (pants) {
          case 'jeans':
              return (
                  <g>
                      <rect x="34" y="80" width="12" height="12" fill={pantsColor} stroke={strokeColor} strokeWidth="2" />
                      <rect x="54" y="80" width="12" height="12" fill={pantsColor} stroke={strokeColor} strokeWidth="2" />
                  </g>
              );
          case 'cargo':
              return (
                  <g>
                      <rect x="33" y="80" width="14" height="12" fill="#57534e" stroke={strokeColor} strokeWidth="2" />
                      <rect x="53" y="80" width="14" height="12" fill="#57534e" stroke={strokeColor} strokeWidth="2" />
                      {/* Pockets */}
                      <rect x="31" y="82" width="4" height="6" fill="#44403c" />
                      <rect x="65" y="82" width="4" height="6" fill="#44403c" />
                  </g>
              );
          case 'shorts':
               return (
                  <g>
                      {/* Skin legs exposed below */}
                      <rect x="38" y="80" width="6" height="10" fill={skinTone} />
                      <rect x="58" y="80" width="6" height="10" fill={skinTone} />
                      
                      {/* Shorts */}
                      <rect x="34" y="80" width="12" height="6" fill={pantsColor} stroke={strokeColor} strokeWidth="2" />
                      <rect x="54" y="80" width="12" height="6" fill={pantsColor} stroke={strokeColor} strokeWidth="2" />
                  </g>
               );
          case 'skirt':
              return (
                 <g>
                     {/* Skin legs */}
                     <rect x="38" y="80" width="6" height="10" fill={skinTone} />
                     <rect x="58" y="80" width="6" height="10" fill={skinTone} />
                     {/* Skirt */}
                     <path d="M35 80 H65 L70 88 H30 Z" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />
                 </g>
              );
          default: // 'none' implies stick legs or basic pants
              return (
                <g>
                   <line x1="40" y1="80" x2="40" y2="90" stroke={strokeColor} strokeWidth="4" />
                   <line x1="60" y1="80" x2="60" y2="90" stroke={strokeColor} strokeWidth="4" />
                </g>
              );
      }
  }

  const renderShoes = () => {
    switch(shoes) {
       case 'high-tops':
          return (
             <g>
                <rect x="30" y="85" width="12" height="10" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />
                <rect x="58" y="85" width="12" height="10" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />
                <line x1="30" y1="92" x2="42" y2="92" stroke="white" strokeWidth="2" />
                <line x1="58" y1="92" x2="70" y2="92" stroke="white" strokeWidth="2" />
             </g>
          );
       case 'boots':
          return (
             <g>
                <path d="M30 85 L30 95 H42 L42 85 Z" fill="#5c3a21" stroke={strokeColor} strokeWidth="2" />
                <path d="M58 85 L58 95 H70 L70 85 Z" fill="#5c3a21" stroke={strokeColor} strokeWidth="2" />
             </g>
          );
       case 'neon':
           return (
             <g>
                <rect x="30" y="88" width="14" height="7" fill="#ccff00" stroke={strokeColor} strokeWidth="2" rx="3" />
                <rect x="56" y="88" width="14" height="7" fill="#ccff00" stroke={strokeColor} strokeWidth="2" rx="3" />
             </g>
           );
       default: // Skate shoes
          return (
             <g>
                <rect x="30" y="88" width="14" height="7" fill="white" stroke={strokeColor} strokeWidth="2" rx="3" />
                <rect x="56" y="88" width="14" height="7" fill="white" stroke={strokeColor} strokeWidth="2" rx="3" />
             </g>
          );
    }
  };

  const renderFace = () => {
      // Eyes and Mouth
      const eyeY = 48;
      const mouthY = 55;
      
      switch (expression) {
          case 'happy':
              return (
                  <g>
                      <circle cx="43" cy={eyeY} r="3" fill="black" />
                      <circle cx="57" cy={eyeY} r="3" fill="black" />
                      <path d="M43 55 Q50 60 57 55" stroke="black" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </g>
              );
          case 'hype':
              return (
                  <g>
                      <path d="M40 46 L46 50 L40 50" fill="black" /> {/* Star eye left */}
                      <path d="M60 46 L54 50 L60 50" fill="black" /> {/* Star eye right */}
                      <circle cx="43" cy={eyeY} r="3" fill="black" />
                      <circle cx="57" cy={eyeY} r="3" fill="black" />
                      <path d="M43 55 Q50 62 57 55 Z" fill="black" /> {/* Open mouth */}
                  </g>
              );
          case 'chill':
              return (
                  <g>
                      {/* Sunglasses handled by accessories, so chill is just a flat mouth line */}
                      <circle cx="43" cy={eyeY} r="3" fill="black" />
                      <circle cx="57" cy={eyeY} r="3" fill="black" />
                      <line x1="43" y1="58" x2="57" y2="58" stroke="black" strokeWidth="2" />
                  </g>
              );
          case 'wink':
              return (
                  <g>
                      <circle cx="43" cy={eyeY} r="3" fill="black" />
                      <path d="M54 48 L60 48" stroke="black" strokeWidth="2" /> {/* Wink */}
                      <path d="M45 55 Q50 58 55 55" stroke="black" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </g>
              );
          case 'neutral':
          default:
              return (
                  <g>
                      <circle cx="43" cy={eyeY} r="3" fill="black" />
                      <circle cx="57" cy={eyeY} r="3" fill="black" />
                      <line x1="45" y1={mouthY} x2="55" y2={mouthY} stroke="black" strokeWidth="2" strokeLinecap="round" />
                  </g>
              );
      }
  }

  return (
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      
      {/* --- SKATEBOARD (Back Layer) --- */}
      <g transform="rotate(-10, 50, 95)">
         <rect x="15" y="92" width="70" height="8" rx="4" fill="#222" stroke={strokeColor} strokeWidth="2" />
         <circle cx="25" cy="98" r="3" fill={primaryColor} stroke={strokeColor} strokeWidth="1" />
         <circle cx="75" cy="98" r="3" fill={primaryColor} stroke={strokeColor} strokeWidth="1" />
      </g>

      {/* --- CHARACTER --- */}
      <g transform="translate(0, -5)">
        {/* Shoes */}
        {renderShoes()}

        {/* Pants/Legs */}
        {renderPants()}

        {/* Outfit (Body) */}
        {renderOutfit()}
        
        {/* Jewelry (Chest/Neck) */}
        {renderJewelry()}

        {/* HEADPHONES (Back part of band) */}
        <path d="M25 50 C25 30 75 30 75 50" stroke={primaryColor} strokeWidth="4" fill="none" />

        {/* Head - Geometric Boxy Shape with Skin Tone */}
        <rect x="30" y="30" width="40" height="35" rx="8" fill={skinTone} stroke={strokeColor} strokeWidth="2.5" />

        {/* Face */}
        {renderFace()}
        
        {/* Glasses */}
        {renderGlasses()}

        {/* Headphones (Ear cups) */}
        <rect x="22" y="40" width="10" height="18" rx="3" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />
        <rect x="68" y="40" width="10" height="18" rx="3" fill={primaryColor} stroke={strokeColor} strokeWidth="2" />

        {/* Hat */}
        {renderHat()}
      </g>
    </svg>
  );
};
