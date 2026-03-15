
import React, { useState, useEffect, useRef } from 'react';
import { EventDraft, KickflipEvent, VibemojiConfig } from '../types';
import { CATEGORY_COLORS, DEFAULT_INITIAL_DRAFT } from '../constants';
import { EventCard } from './EventCard';

interface CreateEventViewProps {
  onPublish: (draft: EventDraft) => void;
  onCancel: () => void;
  initialDraft?: EventDraft | null;
}

interface MockLocation {
  name: string;
  address: string;
}

const ROBUST_MOCK_LOCATIONS: MockLocation[] = [
  { name: "Space Needle", address: "400 Broad St, Seattle, WA 98109" },
  { name: "Pike Place Market", address: "85 Pike St, Seattle, WA 98101" },
  { name: "Kerry Park", address: "211 W Highland Dr, Seattle, WA 98119" },
  { name: "Central Park", address: "New York, NY" },
  { name: "Empire State Building", address: "20 W 34th St, New York, NY 10001" },
  { name: "Brooklyn Bridge", address: "New York, NY 10038" },
  { name: "Times Square", address: "Manhattan, NY 10036" },
  { name: "Hollywood Bowl", address: "2301 N Highland Ave, Los Angeles, CA 90068" },
  { name: "Santa Monica Pier", address: "200 Santa Monica Pier, Santa Monica, CA 90401" },
  { name: "Griffith Observatory", address: "2800 E Observatory Rd, Los Angeles, CA 90027" },
];

interface LocationSuggestion {
  name: string;
  address: string;
  fullText?: string;
  source: 'google' | 'mock' | 'manual';
  id?: string;
}

// Helper to format date string properly without timezone issues (prevents off-by-one error)
const getFormattedDate = (dateStr: string) => {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    // Create date at 00:00 local time
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

// Helper to get local ISO date string (YYYY-MM-DD)
const getLocalISO = (d: Date = new Date()) => {
    const offset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - offset).toISOString().split('T')[0];
};

export const CreateEventView: React.FC<CreateEventViewProps> = ({ onPublish, onCancel, initialDraft }) => {
  // ROBUST INITIALIZATION: Deep merge with default to ensure no fields (like media array) are missing
  const [draft, setDraft] = useState<EventDraft>(() => {
      // Use local timezone for default dates to prevent UTC off-by-one-day bug
      const defaultDate = getLocalISO(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
      const base: EventDraft = { ...DEFAULT_INITIAL_DRAFT, startDate: defaultDate, endDate: defaultDate };
      if (!initialDraft) return base;
      return {
          ...base,
          ...initialDraft,
          // Explicitly ensure nested objects/arrays exist if missing in legacy data
          media: initialDraft.media || [],
          vibemoji: { ...DEFAULT_INITIAL_DRAFT.vibemoji, ...(initialDraft.vibemoji || {}) }
      };
  });

  const [showPreviewMobile, setShowPreviewMobile] = useState(false);
  const [isMagicLoading, setIsMagicLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false); // New uploading state
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const autocompleteService = useRef<any>(null);
  const sessionToken = useRef<any>(null);
  const debounceTimeout = useRef<any>(null);
  
  useEffect(() => {
    if (window.google && window.google.maps && window.google.maps.places) {
      try {
        autocompleteService.current = new window.google.maps.places.AutocompleteService();
        sessionToken.current = new window.google.maps.places.AutocompleteSessionToken();
      } catch (e) {
        console.warn("Google Maps Places API not ready", e);
      }
    }
  }, []);

  const handleLocationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setDraft(prev => ({ ...prev, locationName: val, address: '' }));
    
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
    
    // Try initializing if not yet ready
    if (!autocompleteService.current && window.google && window.google.maps && window.google.maps.places) {
        try {
            autocompleteService.current = new window.google.maps.places.AutocompleteService();
            sessionToken.current = new window.google.maps.places.AutocompleteSessionToken();
        } catch (err) {
            console.error("Failed to lazy init Google Maps", err);
        }
    }

    if (val.length <= 1) {
        setShowSuggestions(false);
        return;
    }

    debounceTimeout.current = setTimeout(() => {
        if (autocompleteService.current) {
            autocompleteService.current.getPlacePredictions({
                input: val,
                componentRestrictions: { country: 'us' },
                sessionToken: sessionToken.current
            }, (predictions: any[], status: any) => {
                if (status === window.google.maps.places.PlacesServiceStatus.OK && predictions) {
                    setSuggestions(predictions.map(p => ({
                        name: p.structured_formatting?.main_text || p.description.split(',')[0],
                        address: p.structured_formatting?.secondary_text || p.description,
                        fullText: p.description,
                        source: 'google',
                        id: p.place_id
                    })));
                    setShowSuggestions(true);
                } else {
                    // Fallback to mock if API returns no results or fails
                    setSuggestions(ROBUST_MOCK_LOCATIONS.filter(loc => 
                      loc.name.toLowerCase().includes(val.toLowerCase()) || loc.address.toLowerCase().includes(val.toLowerCase())
                    ).map(loc => ({ name: loc.name, address: loc.address, fullText: `${loc.name}, ${loc.address}`, source: 'mock' })));
                    setShowSuggestions(true);
                }
            });
        } else {
             // Fallback if Google object not found
             setSuggestions(ROBUST_MOCK_LOCATIONS.filter(loc => 
               loc.name.toLowerCase().includes(val.toLowerCase()) || loc.address.toLowerCase().includes(val.toLowerCase())
             ).map(loc => ({ name: loc.name, address: loc.address, fullText: `${loc.name}, ${loc.address}`, source: 'mock' })));
             setShowSuggestions(true);
        }
    }, 300);
  };

  const selectLocation = (loc: LocationSuggestion) => {
     const isDynamic = loc.source === 'mock' && loc.address === 'Address';
     setDraft(prev => ({ ...prev, locationName: loc.name, address: isDynamic ? loc.name : (loc.fullText || loc.address) }));
     setShowSuggestions(false);
     if (window.google && window.google.maps && window.google.maps.places) {
         sessionToken.current = new window.google.maps.places.AutocompleteSessionToken();
     }
  };
  
  const handleLocationBlur = () => setTimeout(() => setShowSuggestions(false), 200);

  const handleLocationKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
          e.preventDefault();
          if (suggestions.length > 0) selectLocation(suggestions[0]);
          else setShowSuggestions(false);
      }
  };

  const handleConceptMagic = () => {
    if (!draft.concept?.trim()) return;
    setIsMagicLoading(true);
    setTimeout(() => {
      const c = draft.concept;
      const cLower = c.toLowerCase();
      let category: EventDraft['category'] = 'other';
      let themeColor = '#9ca3af';
      let hat: VibemojiConfig['hat'] = 'none', outfit: VibemojiConfig['outfit'] = 'none', pants: VibemojiConfig['pants'] = 'jeans', shoes: VibemojiConfig['shoes'] = 'skate', expression: VibemojiConfig['expression'] = 'happy', glasses: VibemojiConfig['glasses'] = 'none', jewelry: VibemojiConfig['jewelry'] = 'none';
      let suggestedTitle = '';
      
      const has = (keywords: string[]) => keywords.some(k => cLower.includes(k));
      if (has(['rave', 'techno', 'party', 'club', 'dj', 'dance', 'disco', 'edm'])) { category = 'party'; themeColor = CATEGORY_COLORS.party; hat = 'backwards'; outfit = 'jacket'; pants = 'cargo'; shoes = 'neon'; expression = 'hype'; glasses = 'star'; jewelry = 'chain'; }
      else if (has(['food', 'dinner', 'tasting', 'brunch'])) { category = 'food'; themeColor = CATEGORY_COLORS.food; hat = 'beanie'; outfit = 'flannel'; shoes = 'boots'; }
      else if (has(['art', 'gallery', 'paint', 'film'])) { category = 'art'; themeColor = CATEGORY_COLORS.art; hat = 'bucket'; outfit = 'tee'; pants = 'skirt'; expression = 'chill'; glasses = 'retro'; jewelry = 'hoops'; }
      else if (has(['music', 'concert', 'band', 'live'])) { category = 'music'; themeColor = CATEGORY_COLORS.music; hat = 'cap'; outfit = 'hoodie'; shoes = 'high-tops'; expression = 'hype'; glasses = 'sunnies'; }
      else if (has(['yoga', 'meditation', 'wellness'])) { category = 'wellness'; themeColor = CATEGORY_COLORS.wellness; hat = 'halo'; outfit = 'tee'; pants = 'shorts'; shoes = 'neon'; expression = 'chill'; }
      else if (has(['outdoor', 'park', 'nature'])) { category = 'outdoor'; themeColor = CATEGORY_COLORS.outdoor; hat = 'cap'; outfit = 'tee'; pants = 'shorts'; expression = 'happy'; glasses = 'sunnies'; }
      else if (has(['fashion', 'style', 'clothes', 'market'])) { category = 'fashion'; themeColor = CATEGORY_COLORS.fashion; outfit = 'jacket'; pants = 'skirt'; shoes = 'boots'; expression = 'wink'; glasses = 'retro'; jewelry = 'studs'; }
      else if (has(['sports', 'game', 'match', 'football', 'soccer', 'basketball', 'baseball', 'hockey', 'seahawks', 'kraken', 'mariners', 'sounders', 'huskies', 'stadium'])) { category = 'sports'; themeColor = CATEGORY_COLORS.sports; hat = 'cap'; outfit = 'tee'; pants = 'shorts'; expression = 'hype'; }
      else if (has(['comedy', 'standup', 'stand-up', 'improv', 'laugh', 'joke', 'funny', 'comedian'])) { category = 'comedy'; themeColor = CATEGORY_COLORS.comedy; hat = 'beanie'; outfit = 'hoodie'; expression = 'happy'; glasses = 'nerd'; }
      
      // Smart title: filter stop words + generic event words, pick 2 vivid nouns/adjectives + category suffix
      const STOP_WORDS = new Set(['want','will','have','that','this','with','from','they','there','about','which','where','when','into','over','also','some','just','what','like','then','more','very','much','such','even','well','most','would','could','should','their','other','these','those','both','each','many','after','before','while','being','doing','going','come','take','make','know','look','think','give','starting','featuring','planning','hosting','located','event','events','night','thing','said','good','back','time','year','great','little','right','still','made','place','hand','high','part','help','hold','turn','open','next','week','last','long','same','late','late','dear','away','done','full','life','live','play','real','runs','show','side','feel','keep','left','seen','read','tell','used','ways','goes','lets','puts','told','well','gets','seen','area','able','want','need','find','here','from','them','your','been','were','when','just','than','only','over','then','into','also','back','came','each','most','much','near','once','upon','went','with','said','take','will','have','this','that','they','what','from','into','than','also','some','more','make','know','look','even','well','many','give','most','only','such','does','says','tell','each','less','ever','very','must','need','felt','help','feel','come','seem','kind','kept','half','else','done','goes']);
      const GENERIC_WORDS = new Set(['dance','music','food','event','party','show','night','drop','secret','having','really','about','after','again','where','there','these','those','other','being','going']);
      const CATEGORY_SUFFIXES: Record<string, string> = { party:'Night', music:'Session', art:'Collective', food:'Feast', wellness:'Ritual', outdoor:'Wild', comedy:'Laughs', sports:'Day', fashion:'Drop', other:'Experience' };
      const cleanConcept = cLower.replace(/[^\w\s]|_/g, ' ').replace(/\s+/g, ' ');
      const contentWords = cleanConcept.trim().split(' ').filter((w: string) => w.length >= 4 && !STOP_WORDS.has(w) && !GENERIC_WORDS.has(w));
      const titleWords = contentWords.slice(0, 2).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1));
      const suffix = CATEGORY_SUFFIXES[category] || 'Experience';
      suggestedTitle = titleWords.length >= 2 ? `${titleWords.join(' ')} ${suffix}` : titleWords.length === 1 ? `${titleWords[0]} ${suffix}` : 'Untitled Drop';
      
      // --- EXTRACTION MAGIC (Date, Time, Location, Price) ---
      let detectedLocation = '';
      let detectedTime = '';
      let detectedDate = '';
      let detectedPrice = '';
      let detectedIsFree = false;

      // 1. Time Extraction
      const timeMatch = c.match(/\b((?:1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(?:am|pm))\b/i);
      if (timeMatch) {
          const timeStr = timeMatch[0].toLowerCase();
          const isPM = timeStr.includes('pm');
          let [hours, minutes] = timeStr.replace(/[^0-9:]/g, '').split(':').map(Number);
          if (isNaN(minutes)) minutes = 0;
          if (isPM && hours < 12) hours += 12;
          if (!isPM && hours === 12) hours = 0;
          detectedTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
      }

      // 2. Date Extraction
      const explicitDateMatch = c.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
      if (explicitDateMatch) {
          const monthMap: Record<string, number> = {jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11};
          const monthKey = explicitDateMatch[1].toLowerCase().substring(0,3);
          const day = parseInt(explicitDateMatch[2]);
          const now = new Date();
          let year = now.getFullYear();
          let proposedDate = new Date(year, monthMap[monthKey], day);
          
          const today = new Date();
          today.setHours(0,0,0,0);
          if (proposedDate < today) {
              year++;
              proposedDate = new Date(year, monthMap[monthKey], day);
          }
          detectedDate = getLocalISO(proposedDate);
      }

      if (!detectedDate) {
          if (/\b(tonight|today)\b/i.test(c)) {
             detectedDate = getLocalISO(new Date());
          } else if (/\btomorrow\b/i.test(c)) {
             const d = new Date();
             d.setDate(d.getDate() + 1);
             detectedDate = getLocalISO(d);
          }
      }

      if (!detectedDate) {
          const dayMatch = c.match(/\b(?:on|this|next)?\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
          if (dayMatch) {
              const targetDay = dayMatch[1].toLowerCase();
              const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
              const targetIndex = days.indexOf(targetDay);
              if (targetIndex !== -1) {
                  const today = new Date();
                  const currentDay = today.getDay();
                  let daysUntil = targetIndex - currentDay;
                  if (daysUntil <= 0) daysUntil += 7; // Next occurrence
                  
                  const nextDate = new Date(today);
                  nextDate.setDate(today.getDate() + daysUntil);
                  detectedDate = getLocalISO(nextDate);
              }
          }
      }

      // 3. Location Extraction
      const locMatch = c.match(/\b(?:at|@)\s+(?!(?:\d|night|noon|midnight))([A-Z0-9][\w\s'.]+?)(?=\s(?:on|from|with|starting|featuring|\.|,|$))/);
      if (locMatch) {
          detectedLocation = locMatch[1].trim();
      } else {
         const looseLocMatch = c.match(/\b(?:at|@)\s+(?!(?:\d|night|noon|midnight))([\w\s'.]+?)(?=\s(?:on|from|with|starting|featuring|\.|,|$))/i);
         if (looseLocMatch && looseLocMatch[1].length > 3 && looseLocMatch[1].length < 40) {
             detectedLocation = looseLocMatch[1].trim().replace(/\b\w/g, l => l.toUpperCase());
         }
      }

      // 4. Price Extraction
      const freeMatch = c.match(/\b(free|no cover|gratis)\b/i);
      if (freeMatch) {
          detectedIsFree = true;
          detectedPrice = '0';
      } else {
          const priceMatch = c.match(/\$(\d+)/) || c.match(/\b(\d+)\s*(?:dollars|bucks)\b/i);
          if (priceMatch) {
              detectedPrice = priceMatch[1];
              detectedIsFree = parseInt(detectedPrice) === 0;
          }
      }

      // --- VIBE DESCRIPTION MAGIC ---
      let vibeText = c;
      vibeText = vibeText.replace(/\b((?:1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(?:am|pm))\b/gi, '');
      vibeText = vibeText.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi, '');
      vibeText = vibeText.replace(/\b(tonight|tomorrow|today)\b/gi, '');
      vibeText = vibeText.replace(/\b(?:on|this|next)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi, '');
      vibeText = vibeText.replace(/\$(\d+)/g, '');
      vibeText = vibeText.replace(/\b(free|no cover|gratis)\b/gi, '');
      vibeText = vibeText.replace(/\b(?:at|@)\s+(?!(?:\d|night|noon|midnight))([A-Z0-9][\w\s'.]+?)(?=\s(?:on|from|with|starting|featuring|\.|,|$))/g, '');
      vibeText = vibeText.replace(/^(I want to|I'm|We are|Hosting a|Planning a|There is a)\s+/i, '');
      vibeText = vibeText.replace(/\b(starting|starts|doors|begins)\s+(at|@)?/gi, '');
      vibeText = vibeText.replace(/\s+/g, ' ').trim();
      vibeText = vibeText.replace(/\s+([,.])/g, '$1'); 
      vibeText = vibeText.replace(/^[^a-zA-Z0-9]+/, ''); 
      
      let finalVibe = vibeText.split(/[.!?](?:\s|$)/)[0];
      if (finalVibe.length < 15 && vibeText.length > 20) {
         finalVibe = vibeText; 
      }
      
      if (finalVibe.length > 0) {
          finalVibe = finalVibe.charAt(0).toUpperCase() + finalVibe.slice(1);
          if (!/[.!?]$/.test(finalVibe)) finalVibe += '.';
      } else {
          finalVibe = "Just good vibes.";
      }

      const finalizeUpdate = (finalLocName: string, finalAddress: string) => {
          setDraft(prev => ({
            ...prev, 
            title: suggestedTitle, 
            category, 
            themeColor, 
            vibeDescription: finalVibe, 
            locationName: finalLocName || prev.locationName,
            address: finalLocName ? finalAddress : prev.address,
            startTime: detectedTime || prev.startTime,
            startDate: detectedDate || prev.startDate,
            endDate: detectedDate || prev.startDate,
            isFree: detectedIsFree || (detectedPrice === '0'),
            price: detectedPrice || prev.price,
            vibemoji: { ...prev.vibemoji, hat, outfit, pants, shoes, expression, glasses, jewelry, primaryColor: themeColor }
          }));
          setIsMagicLoading(false);
      };

      if (detectedLocation) {
         if (window.google && window.google.maps && window.google.maps.places) {
             if (!autocompleteService.current) {
                 autocompleteService.current = new window.google.maps.places.AutocompleteService();
                 sessionToken.current = new window.google.maps.places.AutocompleteSessionToken();
             }
             autocompleteService.current.getPlacePredictions({
                 input: detectedLocation,
                 componentRestrictions: { country: 'us' },
                 sessionToken: sessionToken.current
             }, (predictions: any[], status: any) => {
                 if (status === window.google.maps.places.PlacesServiceStatus.OK && predictions && predictions.length > 0) {
                     const p = predictions[0];
                     const name = p.structured_formatting?.main_text || p.description.split(',')[0];
                     const address = p.structured_formatting?.secondary_text || p.description;
                     finalizeUpdate(name, address);
                 } else {
                     const mock = ROBUST_MOCK_LOCATIONS.find(l => l.name.toLowerCase().includes(detectedLocation.toLowerCase()));
                     if (mock) finalizeUpdate(mock.name, mock.address);
                     else finalizeUpdate(detectedLocation, '');
                 }
             });
         } else {
             const mock = ROBUST_MOCK_LOCATIONS.find(l => l.name.toLowerCase().includes(detectedLocation.toLowerCase()));
             if (mock) finalizeUpdate(mock.name, mock.address);
             else finalizeUpdate(detectedLocation, '');
         }
      } else {
         finalizeUpdate('', '');
      }
    }, 800);
  };

  const handleMediaUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      
      // Strict Size Limit Check (10MB) for this version to prevent base64 bloat
      if (file.size > 10 * 1024 * 1024) {
          alert("File is too large (Limit: 10MB). Please upload a compressed video or image.");
          e.target.value = '';
          return;
      }

      setIsUploading(true);

      const reader = new FileReader();
      reader.onload = (ev) => {
          const url = ev.target?.result as string;
          setDraft(prev => ({ 
              ...prev, 
              media: [...(prev.media || []), { type: file.type.startsWith('video') ? 'video' : 'image', url, file }] 
          }));
          setIsUploading(false);
      };
      
      reader.onerror = () => {
          console.error("File reading failed");
          alert("Failed to process file. Please try again.");
          setIsUploading(false);
      };

      reader.readAsDataURL(file);
      e.target.value = '';
    }
  };
  
  const removeMedia = (index: number) => {
      const mediaItem = draft.media[index];
      if (mediaItem.url.startsWith('blob:')) {
          URL.revokeObjectURL(mediaItem.url);
      }
      setDraft(prev => ({ ...prev, media: prev.media.filter((_, i) => i !== index) }));
  };

  const formatTime = (time: string) => {
      if (!time) return '';
      const [h, m] = time.split(':');
      const hour = parseInt(h);
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const hour12 = hour % 12 || 12;
      return `${hour12}:${m} ${ampm}`;
  };

  // Preview event derivation - Robust description fallback
  const previewEvent: KickflipEvent = {
    id: draft.id || 'preview',
    title: draft.title || 'Untitled Event',
    date: `${getFormattedDate(draft.startDate)}, ${formatTime(draft.startTime)}`,
    location: draft.locationName || 'TBD Location',
    address: draft.address,
    city: draft.address?.split(',')[1]?.trim() || 'Seattle',
    // Fallback logic: Use Card Headline (vibeDescription) first, then Event Description (overview)
    description: draft.vibeDescription || draft.overview || 'No vibe set yet.',
    category: draft.category,
    vibeTags: ['#preview', `#${draft.category}`, '#kickflip'],
    link: '#',
    price: draft.isFree ? 'Free' : `$${draft.price}`,
    organizer: draft.providerName || 'You',
    media: (draft.media && draft.media.length > 0) ? draft.media : undefined,
    overview: draft.overview,
    vibemoji: draft.vibemoji,
    locationName: draft.locationName,
    startDate: draft.startDate,
    startTime: draft.startTime,
    vibeDescription: draft.vibeDescription
  };

  return (
    <div className="h-screen bg-black text-white flex flex-col md:flex-row overflow-hidden animate-in fade-in duration-500">
      <div className={`w-full md:w-1/2 lg:w-3/5 p-6 md:p-12 overflow-y-auto h-full custom-scrollbar ${showPreviewMobile ? 'hidden md:block' : 'block'}`}>
        <div className="flex justify-between items-center mb-8">
           <button onClick={onCancel} className="text-white/50 hover:text-white flex items-center gap-2 transition-colors font-bold uppercase tracking-widest text-xs">
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
             Exit
           </button>
        </div>
        <div className="max-w-xl mx-auto flex flex-col gap-12 pb-24">
           {/* ... (Concept Section) ... */}
           <section>
              <label className="text-[10px] font-black uppercase tracking-[0.4em] mb-4 block" style={{color: draft.themeColor}}>Step 1: The Concept</label>
              <h2 className="text-4xl font-black mb-4 tracking-tighter uppercase">{initialDraft ? 'Update Your Drop' : 'Ready? Your event starts here.'}</h2>
              <p className="text-white/40 mb-6 text-sm leading-relaxed">Tell us what you’re planning. We’ll handle the rest.</p>
              <textarea 
                className="w-full bg-white/5 border border-white/10 rounded-2xl p-6 text-xl placeholder:text-base text-white focus:outline-none focus:border-white/40 transition-all h-40 resize-none font-medium"
                placeholder="A secret rooftop rave in Cap Hill with lo-fi house music, neon art installations, and a dress code of 'Cyberpunk Chic'. Starting at 10pm..."
                value={draft.concept || ''}
                onChange={(e) => setDraft({...draft, concept: e.target.value})}
                onBlur={handleConceptMagic}
              />
              {isMagicLoading && (
                 <div className="mt-4 text-[10px] font-black uppercase tracking-[0.2em] text-white/40 animate-pulse flex items-center gap-3">
                    <span className="w-2 h-2 bg-pink-500 rounded-full animate-ping"/>
                    Updating visuals...
                 </div>
              )}
           </section>

           {/* --- STEP 2: MEDIA DECK --- */}
           <section>
              <label className="text-[10px] font-black uppercase tracking-[0.4em] mb-4 block" style={{color: draft.themeColor}}>Step 2: Media Deck</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <label className={`aspect-[3/4] bg-white/5 border-2 border-dashed border-white/10 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-white/10 hover:border-white/30 transition-all group ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                      <input 
                        type="file" 
                        className="hidden" 
                        accept="image/*,video/mp4,video/webm,video/ogg,video/*" 
                        onChange={handleMediaUpload} 
                        disabled={isUploading} 
                      />
                      {isUploading ? (
                          <div className="flex flex-col items-center gap-2">
                              <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                              <span className="text-[9px] font-black uppercase tracking-widest text-white/60">Processing...</span>
                          </div>
                      ) : (
                          <>
                            <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform border border-white/10">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                            </div>
                            <span className="text-[9px] font-black uppercase tracking-widest text-white/40 group-hover:text-white">Upload Media</span>
                          </>
                      )}
                  </label>
                  {(draft.media || []).map((item, idx) => (
                      <div key={idx} className="relative aspect-[3/4] rounded-2xl overflow-hidden border border-white/10 bg-black group">
                          {item.type === 'video' ? <video src={item.url} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" muted loop autoPlay playsInline /> : <img src={item.url} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt="preview" />}
                          <button onClick={() => removeMedia(idx)} className="absolute top-3 right-3 p-2 rounded-full bg-black/60 text-white hover:bg-red-500 transition-all backdrop-blur-md opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                      </div>
                  ))}
              </div>
           </section>

           <section className="space-y-12">
              <label className="text-[10px] font-black uppercase tracking-[0.4em] block" style={{color: draft.themeColor}}>Step 3: Logistics</label>
              <div className="space-y-6">
                  <div>
                    <label className="block text-[10px] font-black text-white/30 uppercase tracking-widest mb-3">Drop Title</label>
                    <input type="text" value={draft.title} onChange={(e) => setDraft({...draft, title: e.target.value})} className="w-full bg-transparent border-b-2 border-white/10 pb-4 text-4xl font-black uppercase tracking-tighter focus:outline-none focus:border-white placeholder-white/10 transition-colors" placeholder="EVENT NAME" />
                    
                    <div className="flex flex-wrap gap-2 mt-4 animate-in fade-in slide-in-from-top-1">
                        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
                            <button
                                key={cat}
                                onClick={() => setDraft(prev => ({...prev, category: cat as any, themeColor: color, vibemoji: {...prev.vibemoji, primaryColor: color} }))}
                                className={`px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest border transition-all ${
                                    draft.category === cat 
                                        ? 'text-black border-transparent scale-105 shadow-lg' 
                                        : 'text-white/40 border-white/10 hover:border-white/30 hover:text-white bg-white/5'
                                }`}
                                style={{ backgroundColor: draft.category === cat ? color : 'transparent' }}
                            >
                                {cat}
                            </button>
                        ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black text-white/30 uppercase tracking-widest mb-3">Card Headline (Short Vibe)</label>
                    <input type="text" value={draft.vibeDescription} onChange={(e) => setDraft({...draft, vibeDescription: e.target.value})} className="w-full bg-white/5 border border-white/10 rounded-xl px-6 py-4 text-white focus:outline-none focus:border-white/30 transition-all" placeholder="The general energy..." />
                  </div>
              </div>
              
              <div className="bg-white/5 p-8 rounded-[2rem] border border-white/10 space-y-8">
                 <div className="flex justify-between items-center">
                    <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Entry Fee?</label>
                    {/* Toggle ON (green) = has entry fee (isFree=false); Toggle OFF = free event (isFree=true) */}
                    <button onClick={() => setDraft({...draft, isFree: !draft.isFree})} className={`w-12 h-7 rounded-full relative transition-colors ${!draft.isFree ? 'bg-green-500' : 'bg-white/10'}`}>
                       <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all ${!draft.isFree ? 'left-6' : 'left-1'}`} />
                    </button>
                 </div>
                 {!draft.isFree && (
                   <div className="animate-in slide-in-from-top-2 duration-300">
                       <label className="block text-[10px] font-black text-white/30 uppercase tracking-widest mb-3">Ticket Price ($)</label>
                       <input type="number" value={draft.price} onChange={(e) => setDraft({...draft, price: e.target.value})} className="w-full bg-white/5 border border-white/10 rounded-xl px-6 py-4 text-white font-bold" placeholder="20" />
                   </div>
                 )}
                 <div className="h-px bg-white/10" />
                 <div className="flex justify-between items-center">
                    <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Unlimited Capacity?</label>
                    <button onClick={() => setDraft({...draft, isUnlimitedCapacity: !draft.isUnlimitedCapacity})} className={`w-12 h-7 rounded-full relative transition-colors ${draft.isUnlimitedCapacity ? 'bg-green-500' : 'bg-white/10'}`}>
                       <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all ${draft.isUnlimitedCapacity ? 'left-6' : 'left-1'}`} />
                    </button>
                 </div>
                 {!draft.isUnlimitedCapacity && (
                    <div className="animate-in slide-in-from-top-2 duration-300">
                        <label className="block text-[10px] font-black text-white/30 uppercase tracking-widest mb-3">Available Tickets</label>
                        <input type="number" value={draft.capacity} onChange={(e) => setDraft({...draft, capacity: parseInt(e.target.value) || 0})} className="w-full bg-white/5 border border-white/10 rounded-xl px-6 py-4 text-white font-bold" placeholder="100" />
                    </div>
                 )}
              </div>
              <div className="bg-white/5 p-8 rounded-[2rem] border border-white/10 space-y-6">
                 <label className="block text-[10px] font-black text-white/40 uppercase tracking-widest">Calendar Data</label>
                 <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-[9px] font-black text-white/20 uppercase tracking-widest mb-2">Starts</label>
                        <div className="flex flex-col gap-2">
                            <input type="date" value={draft.startDate} onChange={(e) => setDraft({...draft, startDate: e.target.value})} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:outline-none [color-scheme:dark]" />
                            <input type="time" value={draft.startTime} onChange={(e) => setDraft({...draft, startTime: e.target.value})} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:outline-none [color-scheme:dark]" />
                        </div>
                    </div>
                    <div>
                        <label className="block text-[9px] font-black text-white/20 uppercase tracking-widest mb-2">Ends</label>
                        <div className="flex flex-col gap-2">
                            <input type="date" value={draft.endDate} onChange={(e) => setDraft({...draft, endDate: e.target.value})} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:outline-none [color-scheme:dark]" />
                            <input type="time" value={draft.endTime} onChange={(e) => setDraft({...draft, endTime: e.target.value})} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:outline-none [color-scheme:dark]" />
                        </div>
                    </div>
                 </div>
              </div>
              <div className="relative">
                 <label className="block text-[10px] font-black text-white/30 uppercase tracking-widest mb-3">Venue / Coordinates</label>
                 <div className="relative">
                   <input type="text" value={draft.locationName} onChange={handleLocationChange} onBlur={handleLocationBlur} onKeyDown={handleLocationKeyDown} className="w-full bg-white/5 border border-white/10 rounded-xl pl-14 pr-6 py-5 text-white focus:outline-none focus:border-white/30 transition-all font-medium" placeholder="Venue or Address..." />
                   <div className="absolute left-5 top-5 text-white/30"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></div>
                 </div>
                 {showSuggestions && (
                    <ul className="absolute z-50 w-full bg-[#0a0a0a] border border-white/20 rounded-2xl mt-3 shadow-2xl max-h-64 overflow-y-auto custom-scrollbar animate-in fade-in slide-in-from-top-2 duration-300">
                       {suggestions.map((place, i) => (
                         <li key={i} onMouseDown={() => selectLocation(place)} className="px-6 py-4 hover:bg-white/5 cursor-pointer flex items-center gap-4 border-b border-white/5 last:border-0 group transition-all">
                           <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-lg group-hover:bg-white/10 transition-all"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg></div>
                           <div className="flex-1 min-w-0"><div className="text-sm font-black uppercase tracking-tight text-white group-hover:text-pink-400 transition-colors truncate">{place.name}</div><div className="text-[10px] text-white/30 uppercase font-bold tracking-widest truncate">{place.address}</div></div>
                         </li>
                       ))}
                       {suggestions.length > 0 && suggestions[0].source === 'google' && (
                           <li className="px-6 py-2 flex justify-end bg-[#050505] border-t border-white/10">
                               <img src="https://developers.google.com/maps/documentation/images/powered_by_google_on_non_white.png" alt="Powered by Google" className="h-4 opacity-50 grayscale hover:grayscale-0 transition-all" />
                           </li>
                       )}
                    </ul>
                 )}
                 {draft.address && <div className="flex items-center gap-3 mt-4 px-2 animate-in fade-in"><div className="text-green-500"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><polyline points="20 6 9 17 4 12"></polyline></svg></div><p className="text-[10px] font-black uppercase tracking-widest text-white/30">{draft.address}</p></div>}
              </div>
              
              <div>
                  <label className="block text-[10px] font-black text-white/30 uppercase tracking-widest mb-3">Event Description</label>
                  <textarea value={draft.overview} onChange={(e) => setDraft({...draft, overview: e.target.value})} className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-6 text-white focus:outline-none h-64 font-medium leading-relaxed" />
              </div>
           </section>
           <div className="pt-12 border-t border-white/10 flex flex-col gap-3">
              <button onClick={() => onPublish(draft)} className="w-full py-6 rounded-3xl text-black font-black text-xl uppercase tracking-widest hover:scale-[1.02] active:scale-[0.98] transition-all shadow-2xl shadow-white/5" style={{backgroundColor: draft.themeColor}}>{initialDraft ? 'Update Live Drop' : 'Launch Drop'}</button>
              <button onClick={() => onPublish({...draft, status: 'draft'})} className="w-full py-4 rounded-3xl text-white/50 font-black text-sm uppercase tracking-widest border border-white/10 hover:border-white/30 hover:text-white transition-all bg-white/5">Save as Draft</button>
           </div>
        </div>
      </div>
      <div className={`w-full md:w-1/2 lg:w-2/5 bg-[#050505] border-l border-white/5 relative items-center justify-center ${!showPreviewMobile ? 'hidden md:flex h-full' : 'flex h-screen fixed inset-0 z-50'}`}>
         {showPreviewMobile && <button onClick={() => setShowPreviewMobile(false)} className="absolute top-6 right-6 z-50 bg-white text-black font-black px-6 py-3 rounded-full shadow-2xl uppercase tracking-widest text-xs">Exit Preview</button>}
         <div className="relative w-[340px] h-[640px] scale-90 md:scale-100 transition-all">
             <div className="absolute -inset-6 border-2 border-white/5 rounded-[3rem] pointer-events-none z-0 shadow-2xl"></div>
             <EventCard event={previewEvent} variant="details" className="w-full h-full shadow-2xl" onTagClick={() => {}} />
         </div>
      </div>
      <button onClick={() => setShowPreviewMobile(true)} className="md:hidden fixed bottom-8 right-8 z-40 bg-white text-black font-black px-8 py-4 rounded-full shadow-2xl flex items-center gap-3 uppercase tracking-widest text-xs" style={{backgroundColor: draft.themeColor}}><span>Preview</span></button>
    </div>
  );
}
