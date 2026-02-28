
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { VideoBackground } from './components/VideoBackground';
import { ChatInput } from './components/ChatInput';
import { EventCard } from './components/EventCard';
import { ThemeWidget } from './components/ThemeWidget';
import { SideDrawer } from './components/SideDrawer';
import { CreateEventView } from './components/CreateEventView';
import { DashboardView } from './components/DashboardView';
import { ProfileView } from './components/ProfileView';
import { AdminDashboardView } from './components/AdminDashboardView';
import { OnboardingModal } from './components/OnboardingModal';
import { BackendConfigModal } from './components/BackendConfigModal';
import { PublicEventView } from './components/PublicEventView';
import { CheckoutModal } from './components/CheckoutModal';
import { ChatMessage, KickflipEvent, LoadingState, ThemeConfig, User, ChatSession, ViewState, EventDraft, VibemojiConfig, OnboardingPreferences } from './types';
import { searchSeattleEvents } from './services/claudeService';
import { BACKGROUND_OPTIONS, FEATURED_EVENTS, CATEGORY_COLORS, DEFAULT_INITIAL_DRAFT, draftToEvent } from './constants';
import { fetchRemoteEvents, fetchEventById, syncEventToRemote, deleteRemoteEvent, isBackendConfigured, subscribeToEvents, unsubscribeEvents, getBackendDiagnostics } from './services/supabaseClient';

const QUESTION_PROMPTS = [
  "What's happening tonight?",
  "Show me free events",
  "Any concerts this weekend?",
  "Outdoor activities today",
  "Best date night ideas?",
  "I want to dance",
  "Chill weekend vibes",
  "Where's the move?",
  "Any late night eats?",
  "Art events this week",
  "Seahawks game tickets?",
  "Who is playing tonight?"
];

const CATEGORY_CHIPS = [
  "Coffee Raves",
  "Hidden Gems",
  "Speakeasies",
  "Techno",
  "Game Day",
  "Vintage Markets",
  "Jazz Bars",
  "Rooftops",
  "Night Markets",
  "Art Walks",
  "Live Music",
  "Pop-up Food",
  "Underground DJs",
  "Wine Tastings",
  "Retro Gaming",
  "Sports Bars"
];

const generateSessionChips = () => {
  const shuffle = (arr: string[]) => [...arr].sort(() => Math.random() - 0.5);
  const count = Math.floor(Math.random() * 3) + 2; // random 2–4
  
  const qCount = Math.floor(count / 2) + (count % 2 === 1 ? (Math.random() > 0.5 ? 1 : 0) : 0);
  const cCount = count - qCount;
  
  const qs = shuffle(QUESTION_PROMPTS).slice(0, qCount);
  const cs = shuffle(CATEGORY_CHIPS).slice(0, cCount);
  
  return shuffle([...qs, ...cs]);
};

const InstagramIcon = () => (
  <svg 
    width="24" 
    height="24" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className="text-white drop-shadow-md"
  >
    <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path>
    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line>
  </svg>
);

// --- SKELETON GENERATOR ---
const createSkeletonEvent = (id: string): KickflipEvent => ({
    id,
    title: 'Loading Drop...',
    date: 'Loading...',
    location: 'Locating Venue...',
    description: 'Fetching event details from the network. Hang tight.',
    category: 'other',
    vibeTags: ['#loading'],
    link: '#',
    videoUrl: 'https://videos.pexels.com/video-files/3121459/3121459-hd_1920_1080_24fps.mp4', 
    price: '',
    organizer: 'Kickflip',
    origin: 'user'
});

declare global {
  interface Window {
    google: any;
  }
}

const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// Time-based greeting logic
const getPersonalizedGreeting = (name: string): string => {
  const hour = new Date().getHours();
  const firstName = name.split(' ')[0];
  
  if (hour >= 5 && hour < 12) {
    return `Good morning, ${firstName}.`;
  } else if (hour >= 12 && hour < 18) {
    return `What are you up to, ${firstName}?`;
  } else {
    return `Good evening, ${firstName}.`;
  }
};

const App: React.FC = () => {
  // --- STATE ---
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'model', text: "Your City. Unlocked" }
  ]);
  const [suggestionChips, setSuggestionChips] = useState<string[]>([]);
  const [loadingState, setLoadingState] = useState<LoadingState>(LoadingState.IDLE);
  const [currentEvents, setCurrentEvents] = useState<KickflipEvent[]>([]);
  
  // Persistent Created Events
  const [createdEvents, setCreatedEvents] = useState<EventDraft[]>(() => {
    const saved = localStorage.getItem('kickflip_created_events');
    try {
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // --- OPTIMISTIC ROUTING ---
  const [targetEventId] = useState<string | null>(() => {
      const params = new URLSearchParams(window.location.search);
      return params.get('event');
  });

  const [initialRoute] = useState(() => {
      if (!targetEventId) return { view: 'home' as ViewState, event: null };

      // 1. Check Featured (Instant)
      const featured = FEATURED_EVENTS.find(e => e.id === targetEventId);
      if (featured) return { view: 'event-detail' as ViewState, event: featured };

      // 2. Check Local Storage (Instant)
      const local = createdEvents.find(e => e.id === targetEventId);
      if (local) return { view: 'event-detail' as ViewState, event: draftToEvent(local) };

      // 3. Fallback: Skeleton (Instant Visual, Async Data)
      return { view: 'event-detail' as ViewState, event: createSkeletonEvent(targetEventId) };
  });

  const [currentView, setCurrentView] = useState<ViewState | 'resolving-router'>(initialRoute.view);
  const [viewingEvent, setViewingEvent] = useState<KickflipEvent | null>(initialRoute.event);
  const [showBackendConfig, setShowBackendConfig] = useState(false);
  
  // --- BOOKING STATE ---
  const [bookingEvent, setBookingEvent] = useState<KickflipEvent | null>(null);

  const createdEventsRef = useRef(createdEvents);
  useEffect(() => { createdEventsRef.current = createdEvents; }, [createdEvents]);

  // --- SAFEGUARD: WATCH LIST FOR ARRIVAL ---
  useEffect(() => {
      if (viewingEvent?.title === 'Loading Drop...' && targetEventId) {
          const foundInList = createdEvents.find(e => e.id === targetEventId);
          if (foundInList) {
              console.log("Kickflip Router: Event arrived via global sync.");
              setViewingEvent(draftToEvent(foundInList));
          }
      }
  }, [createdEvents, targetEventId, viewingEvent]);

  // --- BACKGROUND FETCH EFFECT ---
  useEffect(() => {
      if (viewingEvent && viewingEvent.title === 'Loading Drop...' && targetEventId) {
          let isMounted = true;
          console.log("Kickflip Router: Hydrating Skeleton for", targetEventId);

          const hydrate = async () => {
              // 1. Critical Config Check
              if (!isBackendConfigured()) {
                  console.log("Kickflip: Backend check failed. Retrying in 1s...");
                  // Wait a brief moment in case init is lazy
                  await new Promise(r => setTimeout(r, 1000));
                  if (!isBackendConfigured()) {
                      console.error("Kickflip: Backend still not configured. Diagnostics:", getBackendDiagnostics());
                      if (isMounted) {
                          setViewingEvent({
                              ...createSkeletonEvent(targetEventId),
                              title: "System Offline",
                              description: "Database connection failed. Please configure the connection to load remote events.",
                              vibeTags: ['#config_error', '#offline'],
                              videoUrl: 'https://videos.pexels.com/video-files/3163534/3163534-hd_1920_1080_30fps.mp4',
                              // Use the overview field to pass a custom action in this edge case (handled below)
                              overview: "__SYSTEM_OFFLINE_ACTION__" 
                          });
                      }
                      return;
                  }
              }

              // 2. Retry Loop
              const MAX_RETRIES = 10;
              let attempt = 0;

              while (attempt < MAX_RETRIES) {
                  if (!isMounted) return;

                  // A. Fast Check: Global List
                  const inList = createdEventsRef.current.find(e => e.id === targetEventId);
                  if (inList) {
                      if (isMounted) setViewingEvent(draftToEvent(inList));
                      return;
                  }

                  // B. Network Fetch
                  try {
                      let draft = await fetchEventById(targetEventId);
                      // Fallback Strategy: If single fetch fails (RLS?), try list fetch
                      if (!draft) {
                          const all = await fetchRemoteEvents();
                          if (all) draft = all.find(e => e.id === targetEventId) || null;
                      }

                      if (isMounted && draft) {
                          setViewingEvent(draftToEvent(draft));
                          return;
                      }
                  } catch (e) {
                      console.warn(`Kickflip Router: Fetch failed`, e);
                  }

                  await new Promise(r => setTimeout(r, 1500));
                  attempt++;
              }

              // 3. Final Failure
              if (isMounted) {
                  setViewingEvent({
                      ...createSkeletonEvent(targetEventId),
                      title: "Drop Not Found",
                      description: "We couldn't locate this event ID in the database. It may have been deleted or the link is invalid.",
                      vibeTags: ['#404', '#missing'],
                      videoUrl: 'https://videos.pexels.com/video-files/3163534/3163534-hd_1920_1080_30fps.mp4'
                  });
                  setTimeout(() => {
                      if (isMounted) {
                          window.history.replaceState(null, '', '/');
                          setCurrentView('home');
                      }
                  }, 5000);
              }
          };

          hydrate();
          return () => { isMounted = false; };
      }
  }, [viewingEvent?.id, targetEventId]);


  const [pendingDraft, setPendingDraft] = useState<EventDraft | null>(null);
  const pendingDraftRef = useRef<EventDraft | null>(null);
  const [editingDraft, setEditingDraft] = useState<EventDraft | null>(null);
  const [isBackendConnected, setIsBackendConnected] = useState(isBackendConfigured());
  const [isPublishing, setIsPublishing] = useState(false);
  
  const [sessionFeaturedEvents] = useState<KickflipEvent[]>(() => {
      const shuffled = [...FEATURED_EVENTS];
      for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
  });

  const [user, setUser] = useState<User | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatSession[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string>(Date.now().toString());
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    setSuggestionChips(generateSessionChips());
  }, []);

  // --- SUPABASE SYNC ---
  const syncWithBackend = async () => {
      const remoteEvents = await fetchRemoteEvents();
      if (remoteEvents !== null) {
          setCreatedEvents(prev => {
              const idMap = new Map();
              remoteEvents.forEach(e => {
                  const localEquivalent = prev.find(p => p.id === e.id);
                  if (localEquivalent && localEquivalent.creatorId && !e.creatorId) {
                      console.warn("Retaining local version of event due to missing remote creatorId:", e.title);
                      idMap.set(e.id, localEquivalent); 
                  } else {
                      idMap.set(e.id, e);
                  }
              });
              
              prev.forEach(e => {
                  if (!idMap.has(e.id)) idMap.set(e.id, e);
              });
              return Array.from(idMap.values()) as EventDraft[];
          });
      }
  };

  useEffect(() => {
    syncWithBackend();
    const onFocus = () => syncWithBackend();
    window.addEventListener('focus', onFocus);

    if (isBackendConfigured()) {
        subscribeToEvents(
            (newEvent) => {
                setCreatedEvents(prev => {
                     if (prev.some(e => e.id === newEvent.id)) {
                         return prev.map(e => e.id === newEvent.id ? newEvent : e);
                     }
                     return [newEvent, ...prev];
                });
            },
            (updatedEvent) => {
                setCreatedEvents(prev => prev.map(e => e.id === updatedEvent.id ? updatedEvent : e));
            },
            (deletedId) => {
                setCreatedEvents(prev => prev.filter(e => e.id !== deletedId));
            }
        );
    }
    
    return () => {
        window.removeEventListener('focus', onFocus);
        unsubscribeEvents();
    };
  }, [isBackendConnected]);

  useEffect(() => {
    pendingDraftRef.current = pendingDraft;
  }, [pendingDraft]);

  const [theme, setTheme] = useState<ThemeConfig>(() => {
    const saved = localStorage.getItem('kickflip_theme');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse theme", e);
      }
    }
    return {
      font: 'font-sans',
      accentColor: '#34d399',
      backgroundType: 'video', 
      backgroundUrl: BACKGROUND_OPTIONS[0].url,
      vibemoji: 'duck'
    };
  });

  const [brandIdentity, setBrandIdentity] = useState<VibemojiConfig>(() => {
    const saved = localStorage.getItem('kickflip_brand_identity');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return {
      baseId: 'duck',
      hat: 'cap',
      outfit: 'hoodie',
      expression: 'happy',
      primaryColor: '#34d399',
      skinTone: '#fca5a5',
      font: 'font-sans',
      backgroundType: 'image',
      backgroundUrl: 'https://images.pexels.com/photos/3165335/pexels-photo-3165335.jpeg'
    };
  });

  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterTime, setFilterTime] = useState<'all' | 'tonight' | 'weekend' | 'custom'>('all');
  const [filterVibe, setFilterVibe] = useState<string>('');
  
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  const latestUserMessageRef = useRef<HTMLDivElement>(null);

  const getHistoryKey = (u: User | null) => u ? `kickflip_history_${u.id}` : 'kickflip_history_guest';
  const isSuperAdmin = user?.email === 'bryce@kickflip.co';

  const allActiveEvents = useMemo(() => {
    const now = new Date();
    const featured = sessionFeaturedEvents.map(fe => {
       const override = createdEvents.find(ce => ce.id === fe.id);
       if (override) {
           return draftToEvent(override);
       }
       return fe;
    }).filter(fe => {
        if (fe.startDate) {
            const eventDate = new Date(fe.startDate);
            const today = new Date();
            today.setHours(0,0,0,0);
            const eventDay = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
            if (eventDay < today) return false;
        }
        return true;
    });

    const custom = createdEvents
        .filter(ce => {
            if (ce.status !== 'active') return false;
            if (FEATURED_EVENTS.some(fe => fe.id === ce.id)) return false;
            if (ce.endDate) {
                const endDateTime = new Date(`${ce.endDate}T${ce.endTime || '23:59'}`);
                const visibilityCutoff = new Date(endDateTime.getTime() + 24 * 60 * 60 * 1000); 
                if (visibilityCutoff < now) return false;
            } else if (ce.startDate) {
                const startDateTime = new Date(`${ce.startDate}T${ce.startTime || '00:00'}`);
                const visibilityCutoff = new Date(startDateTime.getTime() + 24 * 60 * 60 * 1000); 
                if (visibilityCutoff < now) return false;
            }
            return true;
        })
        .map(draft => draftToEvent(draft));
    
    return [...featured, ...custom];
  }, [createdEvents, sessionFeaturedEvents]);

  // ... (auth functions preserved) ...
  const parseJwt = (token: string) => {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function(c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(jsonPayload);
    } catch (e) {
      console.error("Failed to parse JWT", e);
      return null;
    }
  };

  const handleCredentialResponse = async (response: any) => {
    try {
      const payload = parseJwt(response.credential);
      if (payload) {
        const authenticatedUser: User = {
            id: payload.sub,
            name: payload.name,
            email: payload.email,
            avatar: payload.picture,
            stripeConnected: false
        };
        
        const existingStored = localStorage.getItem('kickflip_user');
        const finalUser = existingStored ? { ...JSON.parse(existingStored), ...authenticatedUser } : authenticatedUser;

        setCreatedEvents(prev => {
            const updated = prev.map(evt => {
                if (!evt.creatorId) return { ...evt, creatorId: authenticatedUser.id };
                return evt;
            });
            updated.forEach(evt => {
                if (!evt.creatorId || evt.creatorId === authenticatedUser.id) {
                    syncEventToRemote({ ...evt, creatorId: authenticatedUser.id });
                }
            });
            return updated;
        });

        setUser(finalUser);
        localStorage.setItem('kickflip_user', JSON.stringify(finalUser));
        setIsDrawerOpen(false);
        
        if (!finalUser.onboardingPreferences?.completed) {
            setShowOnboarding(true);
        }

        if (pendingDraftRef.current) handleFinalizePublish(finalUser, pendingDraftRef.current);
      }
    } catch (error) {
      console.error("Login Error:", error);
    }
  };

  useEffect(() => {
    const savedUser = localStorage.getItem('kickflip_user');
    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser);
        setUser(parsed);
        if (!parsed.onboardingPreferences?.completed) {
            setShowOnboarding(true);
        }
      } catch (e) {}
    }

    const initGoogleAuth = () => {
        if (window.google && window.google.accounts && window.google.accounts.id) {
             try {
                window.google.accounts.id.initialize({
                  client_id: GOOGLE_CLIENT_ID,
                  callback: handleCredentialResponse,
                  auto_select: false,
                  cancel_on_tap_outside: true,
                  use_fedcm_for_prompt: true
                });
                return true;
             } catch (e) {
                console.warn("Google Auth Init Failed:", e);
                return false;
             }
        }
        return false;
    };

    if (window.google) initGoogleAuth();

    const intervalId = setInterval(() => {
        const success = initGoogleAuth();
        if (success) clearInterval(intervalId);
    }, 800);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (messages.length === 1 && messages[0].role === 'model') {
       if (user) {
           if (messages[0].text === "Your City. Unlocked") {
               setMessages([{ role: 'model', text: getPersonalizedGreeting(user.name) }]);
           }
       } else {
           if (messages[0].text !== "Your City. Unlocked") {
               setMessages([{ role: 'model', text: "Your City. Unlocked" }]);
           }
       }
    }
  }, [user, messages]);

  useEffect(() => {
    localStorage.setItem('kickflip_theme', JSON.stringify(theme));
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem('kickflip_created_events', JSON.stringify(createdEvents));
    } catch (e) {
      console.warn("Failed to save events to localStorage", e);
    }
  }, [createdEvents]);

  useEffect(() => {
    localStorage.setItem('kickflip_brand_identity', JSON.stringify(brandIdentity));
  }, [brandIdentity]);

  useEffect(() => {
    const key = getHistoryKey(user);
    const savedHistory = localStorage.getItem(key);
    if (savedHistory) {
      try {
        setChatHistory(JSON.parse(savedHistory));
      } catch (e) {
        setChatHistory([]);
      }
    } else {
        setChatHistory([]);
    }
  }, [user]);

  useEffect(() => {
    const key = getHistoryKey(user);
    localStorage.setItem(key, JSON.stringify(chatHistory));
  }, [chatHistory, user]);

  const handleGoogleLogin = () => {
    if (window.google && window.google.accounts) {
      try {
        window.google.accounts.id.prompt((notification: any) => {
            if (notification.isNotDisplayed()) {
                 console.log("One Tap suppressed:", notification.getNotDisplayedReason());
            }
        });
      } catch (error) {
        console.error("Google Prompt Failed:", error);
      }
    } else {
        console.warn("Google Sign-In script not loaded yet.");
    }
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('kickflip_user');
    setCurrentView('home');
    setShowOnboarding(false);
    if (window.google) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch (e) { }
    }
  };

  const handleUpdateUser = (updates: Partial<User>) => {
    if (user) {
        const updatedUser = { ...user, ...updates };
        setUser(updatedUser);
        localStorage.setItem('kickflip_user', JSON.stringify(updatedUser));
    }
  };

  const handleConnectStripe = () => {
    handleUpdateUser({ stripeConnected: true });
  };

  const handleOnboardingComplete = async (prefs: OnboardingPreferences) => {
      setShowOnboarding(false);
      handleUpdateUser({ onboardingPreferences: prefs });
      const firstName = user?.name ? user.name.split(' ')[0] : 'Explorer';
      setLoadingState(LoadingState.SEARCHING);
      setMessages([{ role: 'model', text: `Welcome to the crew, ${firstName}. Searching for ${prefs.vibes.join(', ')} vibes in ${prefs.location} for ${prefs.timing.join(' & ')}.` }]);
      
      try {
          const query = `Find specific ${prefs.vibes.join(', ')} events in ${prefs.location} happening ${prefs.timing.join(' or ')}. Include a mix of hidden gems, popular spots, and unique experiences.`;
          const result = await searchSeattleEvents(query, allActiveEvents);
          setMessages(prev => [
              { role: 'model', text: "Welcome to Kickflip. Here is your personalized mix.", events: result.events }
          ]);
          setCurrentEvents(result.events);
          setLoadingState(LoadingState.IDLE);
      } catch (e) {
          setLoadingState(LoadingState.IDLE);
          setMessages(prev => [...prev, { role: 'model', text: "Welcome! Start typing to find events." }]);
      }
  };

  const saveCurrentSession = () => {
    if (messages.length > 1) {
      const firstUserMsg = messages.find(m => m.role === 'user');
      const previewText = firstUserMsg ? firstUserMsg.text : 'New Conversation';
      const newSession: ChatSession = {
        id: currentSessionId,
        timestamp: Date.now(),
        preview: previewText,
        messages: [...messages]
      };
      setChatHistory(prev => {
        const filtered = prev.filter(s => s.id !== currentSessionId);
        return [newSession, ...filtered];
      });
    }
  };

  const startNewChat = () => {
    saveCurrentSession();
    setCurrentSessionId(Date.now().toString());
    
    if (user?.name) {
        setMessages([{ role: 'model', text: getPersonalizedGreeting(user.name) }]);
    } else {
        setMessages([
          { role: 'model', text: "Your City. Unlocked" }
        ]);
    }

    setSuggestionChips(generateSessionChips());
    setCurrentEvents([]);
    setLoadingState(LoadingState.IDLE);
    setFilterCategory('all');
    setFilterTime('all');
    setSelectedDate(null);
    setFilterVibe('');
    setCurrentView('home');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setIsDrawerOpen(false);
  };

  const handleLoadSession = (session: ChatSession) => {
    saveCurrentSession();
    setCurrentSessionId(session.id);
    setMessages(session.messages);
    const lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg.events) {
      setCurrentEvents(lastMsg.events);
    } else {
      setCurrentEvents([]);
    }
    setLoadingState(LoadingState.IDLE);
    setCurrentView('home');
    setIsDrawerOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const generateUUID = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
  };

  const handlePublishClick = (draft: EventDraft) => {
      const finalDraft = { ...draft, id: draft.id || generateUUID() };
      setPendingDraft(finalDraft);
      if (user) {
          handleFinalizePublish(user, finalDraft);
      } else {
          handleGoogleLogin();
      }
  };

  const handleFinalizePublish = async (u: User, draft: EventDraft) => {
      setIsPublishing(true);
      const isUpdate = createdEvents.some(e => e.id === draft.id);
      
      const publishedDraft: EventDraft = { 
        ...draft, 
        status: 'active' as const, 
        ticketsSold: isUpdate ? (createdEvents.find(e => e.id === draft.id)?.ticketsSold || 0) : Math.floor(Math.random() * 5),
        creatorId: u.id // Explicitly ensure user ID is set on publish
      };
      
      // Update Local State Optimistically
      if (isUpdate) {
        setCreatedEvents(prev => prev.map(e => e.id === draft.id ? publishedDraft : e));
      } else {
        setCreatedEvents(prev => [...prev, publishedDraft]);
      }

      // Sync to Remote
      const syncResult = await syncEventToRemote(publishedDraft);
      setIsPublishing(false);

      if (!syncResult.success) {
          const msg = syncResult.error?.message || syncResult.error || "Unknown error";
          const isLargePayload = msg.includes("Payload too large") || msg.toString().includes("413");
          
          let alertText = "Network Error: Your drop failed to sync to the cloud. It is saved locally on this device.";
          if (isLargePayload) alertText += "\n\nReason: The media files are too large for the database. Try using smaller images/video.";
          else alertText += "\n\nReason: " + msg;

          alert(alertText);
      }

      setPendingDraft(null);
      setEditingDraft(null);
      setCurrentView('dashboard');
  };

  const handleDeleteEvent = (eventId: string) => {
    setCreatedEvents(prev => prev.filter(e => e.id !== eventId));
    deleteRemoteEvent(eventId);
  };

  const handleAdminInject = (events: EventDraft[]) => {
      setCreatedEvents(prev => [...prev, ...events]);
      events.forEach(e => syncEventToRemote(e));
  };

  const handleAdminEdit = (event: KickflipEvent) => {
      const baseDraft = DEFAULT_INITIAL_DRAFT;
      const editingDraft: EventDraft = {
          ...baseDraft,
          id: event.id,
          title: event.title,
          category: event.category,
          vibeDescription: event.vibeDescription || event.description,
          locationName: event.locationName || event.location,
          address: event.address || '',
          startDate: event.startDate || baseDraft.startDate,
          startTime: event.startTime || baseDraft.startTime,
          price: (event.price && event.price.replace('$', '')) || baseDraft.price,
          isFree: event.price === 'Free',
          media: event.media || (event.videoUrl ? [{ type: 'video', url: event.videoUrl }] : (event.imageUrl ? [{ type: 'image', url: event.imageUrl }] : [])),
          vibemoji: event.vibemoji || baseDraft.vibemoji,
          overview: event.overview || '',
          origin: event.origin,
          iframeUrl: event.iframeUrl,
          crawlSource: event.crawlSource
      };

      setEditingDraft(editingDraft);
      setCurrentView('create-event');
  };

  // --- BOOKING HANDLERS ---
  const handleBookEvent = (event: KickflipEvent) => {
      setBookingEvent(event);
  };

  const handleCheckoutSuccess = async (quantity: number) => {
      if (!bookingEvent) return;
      
      console.log(`Successfully booked ${quantity} tickets for ${bookingEvent.title}`);
      
      // Update local stats for immediate feedback if it's a known draft
      setCreatedEvents(prev => prev.map(draft => {
          if (draft.id === bookingEvent.id) {
              const updated = { ...draft, ticketsSold: (draft.ticketsSold || 0) + quantity };
              // Fire and forget sync
              syncEventToRemote(updated);
              return updated;
          }
          return draft;
      }));
      
      // Clear booking state (Modal will close itself via props, but we reset here for safety)
      setBookingEvent(null);
  };

  const handleSendMessage = async (text: string) => {
    const userMsg: ChatMessage = { role: 'user', text };
    setMessages(prev => [...prev, userMsg]);
    setLoadingState(LoadingState.SEARCHING);
    setCurrentEvents([]);

    try {
      const result = await searchSeattleEvents(text, allActiveEvents);
      const modelMsg: ChatMessage = {
        role: 'model',
        text: result.text,
        events: result.events
      };
      setMessages(prev => [...prev, modelMsg]);
      setCurrentEvents(result.events);
      setLoadingState(LoadingState.COMPLETE);
    } catch (error) {
      setMessages(prev => [...prev, { role: 'model', text: "My bad, I tripped up finding that. Try again?" }]);
      setLoadingState(LoadingState.ERROR);
    }
  };

  // ... (View/Edit handlers)
  const handleEditEvent = (event: EventDraft) => {
    setEditingDraft(event);
    setCurrentView('create-event');
  };

  const handleViewPublicPage = (event: EventDraft) => {
    alert(`Public page for ${event.title} would open here.`);
  };

  const handleDownloadGuestList = (event: EventDraft) => {
     alert(`Downloading guest list for ${event.title}...`);
  };

  const filteredEvents = useMemo(() => {
    const combined = new Map<string, KickflipEvent>();
    allActiveEvents.forEach(evt => combined.set(evt.id, evt));
    
    currentEvents.forEach(evt => {
       if (!combined.has(evt.id)) combined.set(evt.id, evt);
    });

    const allDisplayEvents = Array.from(combined.values());

    return allDisplayEvents.filter(event => {
      if (filterCategory !== 'all' && event.category.toLowerCase() !== filterCategory.toLowerCase()) return false;
      
      if (filterTime === 'custom' && selectedDate) {
        const dateStr = event.date.toLowerCase();
        const structuredDateStr = event.startDate ? new Date(event.startDate).toDateString().toLowerCase() : '';
        const selectedDateStr = selectedDate.toDateString().toLowerCase();
        
        const matchesLegacy = dateStr.includes('daily');
        const matchesStructured = structuredDateStr === selectedDateStr;
        
        if (!matchesLegacy && !matchesStructured) return false;
      } else if (filterTime === 'tonight') {
        const dateStr = event.date.toLowerCase();
        const structuredDateStr = event.startDate ? new Date(event.startDate).toDateString() : '';
        const todayStr = new Date().toDateString();
        
        if (!dateStr.includes('tonight') && !dateStr.includes('daily') && structuredDateStr !== todayStr) return false;
      } else if (filterTime === 'weekend') {
        const dateStr = event.date.toLowerCase();
        const isWknd = event.startDate ? [5,6,0].includes(new Date(event.startDate).getDay()) : false;
        
        if (!['fri', 'sat', 'sun', 'weekend', 'daily'].some(kw => dateStr.includes(kw)) && !isWknd) return false;
      }

      if (filterVibe && !event.vibeTags.some(tag => tag.toLowerCase().includes(filterVibe.toLowerCase()))) return false;
      return true;
    });
  }, [currentEvents, filterCategory, filterVibe, filterTime, selectedDate, allActiveEvents]);

  // --- DAY TABS (kickflip-psi style: Anytime + next 7 days) ---
  const dayTabs = useMemo(() => {
    const tabs: Array<{ label: string; date: Date | null; count: number }> = [];
    tabs.push({ label: 'Anytime', date: null, count: allActiveEvents.length });
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      const dayNum = d.getDate();
      const count = allActiveEvents.filter(evt => {
        if (evt.startDate) {
          const [y, m, day] = evt.startDate.split('-').map(Number);
          return new Date(y, m - 1, day).toDateString() === d.toDateString();
        }
        return false;
      }).length;
      tabs.push({ label: `${dayName} ${dayNum}`, date: new Date(d), count });
    }
    return tabs;
  }, [allActiveEvents]);

  // --- CATEGORY COUNTS ---
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allActiveEvents.length };
    allActiveEvents.forEach(evt => {
      const cat = evt.category.toLowerCase();
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }, [allActiveEvents]);

  const handleTagClick = (tag: string) => {
    setFilterVibe(tag.replace(/^#/, ''));
  };

  const isHome = messages.length <= 1 && loadingState === LoadingState.IDLE;

  // --- ROUTER VIEW SWITCHING ---

  if (currentView === 'event-detail' && viewingEvent) {
      if (viewingEvent.overview === "__SYSTEM_OFFLINE_ACTION__") {
          return (
              <div className="fixed inset-0 z-50 bg-black flex items-center justify-center p-6">
                  <div className="bg-[#111] border border-white/20 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
                      <h2 className="text-2xl font-black text-white mb-4 uppercase tracking-tighter">System Offline</h2>
                      <p className="text-white/60 mb-8 text-sm leading-relaxed">
                          The database connection is missing. Use the settings below to manually connect your Supabase instance.
                      </p>
                      <button 
                          onClick={() => setShowBackendConfig(true)}
                          className="w-full py-4 bg-white text-black font-black uppercase tracking-widest rounded-xl hover:scale-105 transition-all"
                      >
                          Connect Database
                      </button>
                      <button 
                          onClick={() => { window.history.replaceState(null, '', '/'); setCurrentView('home'); }}
                          className="mt-4 text-xs font-bold text-white/40 hover:text-white uppercase tracking-widest"
                      >
                          Return Home
                      </button>
                  </div>
                  {showBackendConfig && (
                    <BackendConfigModal 
                        onClose={() => setShowBackendConfig(false)}
                        onConfigSaved={() => {
                            window.location.reload(); 
                        }}
                    />
                  )}
              </div>
          );
      }

      return (
          <>
            <PublicEventView 
                event={viewingEvent} 
                theme={theme}
                onBack={() => { 
                    setCurrentView('home'); 
                    setViewingEvent(null); 
                    window.history.pushState(null, '', '/'); 
                }}
                onBook={handleBookEvent}
            />
            {bookingEvent && (
                <CheckoutModal 
                    event={bookingEvent}
                    onClose={() => setBookingEvent(null)}
                    onSuccess={handleCheckoutSuccess}
                    accentColor={theme.accentColor}
                />
            )}
          </>
      );
  }

  if (currentView === 'create-event') {
    return <CreateEventView 
      onPublish={handlePublishClick} 
      onCancel={() => { 
        if (editingDraft) setCurrentView('dashboard');
        else setCurrentView('home');
        setEditingDraft(null); 
      }} 
      initialDraft={editingDraft} 
    />;
  }

  if (currentView === 'dashboard') {
    return user ? (
        <DashboardView 
          user={user} 
          createdEvents={createdEvents.filter(e => e.creatorId === user.id)} 
          onBackHome={() => setCurrentView('home')} 
          onConnectStripe={handleConnectStripe}
          brandIdentity={brandIdentity}
          onUpdateBrand={setBrandIdentity}
          onEditEvent={handleEditEvent}
          onViewPublicPage={handleViewPublicPage}
          onDownloadGuestList={handleDownloadGuestList}
          onDeleteEvent={handleDeleteEvent}
        />
    ) : (
        <>{setCurrentView('home')}</>
    );
  }

  if (currentView === 'admin') {
      return user ? (
          <AdminDashboardView 
             user={user}
             allEvents={createdEvents} 
             onUpdateEvent={(evt) => setCreatedEvents(prev => prev.map(e => e.id === evt.id ? evt : e))}
             onDeleteEvent={handleDeleteEvent}
             onInjectEvents={handleAdminInject}
             onBackHome={() => setCurrentView('home')}
          />
      ) : (
          <>{setCurrentView('home')}</>
      );
  }

  if (currentView === 'profile') {
      return user ? (
          <ProfileView 
             user={user}
             createdEvents={createdEvents.filter(e => e.creatorId === user.id)}
             onLogout={handleLogout}
             onNavigateDashboard={() => setCurrentView('dashboard')}
             onNavigateCreate={() => setCurrentView('create-event')}
             onUpdateUser={handleUpdateUser}
             onUpdateBrand={setBrandIdentity}
             brandIdentity={brandIdentity}
             onBackHome={() => setCurrentView('home')}
          />
      ) : (
        <>{setCurrentView('home')}</>
      );
  }

  return (
    <div className={`relative min-h-screen w-full antialiased text-white selection:bg-white/30 selection:text-white ${theme.font}`}>
      {/* Loading Overlay when publishing */}
      {isPublishing && (
          <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-md flex items-center justify-center flex-col gap-4">
              <div className="w-16 h-16 border-4 border-white/20 border-t-white rounded-full animate-spin"></div>
              <p className="text-white font-bold uppercase tracking-widest animate-pulse">Publishing Drop...</p>
          </div>
      )}

      {showOnboarding && (
        <OnboardingModal 
          theme={theme}
          onComplete={handleOnboardingComplete}
          onSkip={() => setShowOnboarding(false)}
        />
      )}

      {showBackendConfig && (
        <BackendConfigModal 
            onClose={() => setShowBackendConfig(false)}
            onConfigSaved={() => {
                syncWithBackend(); 
                setIsBackendConnected(isBackendConfigured()); 
            }}
        />
      )}

      {bookingEvent && (
        <CheckoutModal 
            event={bookingEvent}
            onClose={() => setBookingEvent(null)}
            onSuccess={handleCheckoutSuccess}
            accentColor={theme.accentColor}
        />
      )}

      <SideDrawer 
        isOpen={isDrawerOpen} 
        onClose={() => setIsDrawerOpen(false)}
        user={user}
        chatHistory={chatHistory}
        onSelectSession={handleLoadSession}
        onLogin={handleGoogleLogin}
        onLogout={handleLogout}
        accentColor={theme.accentColor}
        vibemoji={theme.vibemoji}
        onNavigateCreate={() => { setIsDrawerOpen(false); setEditingDraft(null); setCurrentView('create-event'); }}
        onNavigateDashboard={() => { setIsDrawerOpen(false); setCurrentView('dashboard'); }}
        onNavigateProfile={() => { setIsDrawerOpen(false); setCurrentView('profile'); }}
        onNavigateAdmin={() => { setIsDrawerOpen(false); setCurrentView('admin'); }}
        onOpenSettings={() => { setIsDrawerOpen(false); setShowBackendConfig(true); }}
        hasEvents={createdEvents.some(e => e.creatorId === user?.id)}
      />

      <VideoBackground key={theme.backgroundUrl} src={theme.backgroundUrl} type={theme.backgroundType} isOverlayDark={currentEvents.length > 0 || messages.length > 1} />

      <div className="relative z-10 w-full max-w-5xl mx-auto flex flex-col pb-64">
        {/* Persistent Top Navigation */}
        <header className="sticky top-0 z-50 p-6 w-full flex justify-between items-start transition-all">
          <div className="flex items-center gap-4">
             <button onClick={() => setIsDrawerOpen(true)} className="p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-md transition-all text-white">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
             </button>
             <div className="relative z-50 cursor-pointer active:scale-95 transition-transform flex items-center gap-3" onClick={startNewChat}>
                <div className="flex flex-col">
                    <span className="text-3xl md:text-4xl font-black tracking-tighter text-white drop-shadow-md leading-none">Kickflip</span>
                    <span className="text-[10px] font-bold uppercase tracking-[0.4em] text-white/50 ml-1">Seattle</span>
                </div>
             </div>
          </div>
          <div className="relative z-50 flex items-center gap-4 pt-4 pr-2">
            <ThemeWidget currentTheme={theme} onUpdate={setTheme} />
            <a href="https://www.instagram.com/kickflip_experience/" target="_blank" rel="noopener noreferrer" className="hover:opacity-80 transition-opacity" style={{ color: theme.accentColor }}><InstagramIcon /></a>
          </div>
        </header>

        <div className={`flex flex-col gap-2 px-6 transition-all duration-700 ${isHome ? 'min-h-[60vh] justify-center' : 'pt-0'}`}>
          {messages.map((msg, idx) => (
            <div key={idx} ref={msg.role === 'user' ? latestUserMessageRef : null} className={`w-full flex flex-col gap-2 ${msg.role === 'user' ? 'items-end mt-2' : 'items-start'} animate-in fade-in slide-in-from-bottom-4 duration-500`}>
              <div className={`max-w-[95%] md:max-w-[90%] ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                  <p className="inline-block whitespace-pre-line text-4xl md:text-7xl font-bold leading-[1.1] tracking-tighter drop-shadow-md" style={{ color: msg.role === 'model' ? theme.accentColor : 'white' }}>{msg.text}</p>
              </div>
              {msg.events && msg.events.length > 0 && (
                <div className="w-full mt-12 mb-4 animate-in slide-in-from-bottom-10 fade-in duration-700">
                  <div className="flex gap-4 overflow-x-auto no-scrollbar pb-8 snap-x snap-mandatory pl-1">
                    {msg.events.map((event, i) => (
                      <EventCard 
                        key={event.id} 
                        event={event} 
                        theme={theme} 
                        className={`${i % 3 === 0 ? 'w-[320px] sm:w-[360px]' : 'w-[300px] sm:w-[320px]'}`}
                        onTagClick={handleTagClick}
                        isSuperAdmin={isSuperAdmin}
                        onEdit={handleAdminEdit}
                        onBook={handleBookEvent}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          
          {isHome && (
            <>
              <div className="flex flex-wrap gap-3 mt-4 animate-in fade-in slide-in-from-bottom-6 duration-700 delay-300 justify-start">
                {suggestionChips.map((chip, index) => (
                  <button
                    key={index} onClick={() => handleSendMessage(chip)}
                    className="px-5 py-2.5 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white font-medium text-sm sm:text-base transition-all duration-300 hover:bg-white hover:text-black"
                  >
                    {chip}
                  </button>
                ))}
              </div>

              <div id="featured-drops" className="w-full mt-20 animate-in fade-in slide-in-from-bottom-12 duration-1000 delay-500">
                <div className="mb-2">
                    <h3 className="text-xl font-bold uppercase tracking-widest text-white/50 mb-4">Featured Events</h3>
                </div>

                <div className="mb-6 border-b border-white/10 pb-4">
                    {/* Day-of-week tabs — kickflip-psi style */}
                    <div className="flex gap-1 overflow-x-auto no-scrollbar bg-white/5 rounded-lg p-1 w-fit max-w-full">
                      {dayTabs.map((tab, idx) => {
                        const isActive = tab.date === null
                          ? (filterTime === 'all' || filterTime === 'tonight' || filterTime === 'weekend')
                          : filterTime === 'custom' && selectedDate?.toDateString() === tab.date.toDateString();
                        return (
                          <button
                            key={idx}
                            onClick={() => {
                              if (tab.date === null) {
                                setFilterTime('all'); setSelectedDate(null);
                              } else {
                                setFilterTime('custom'); setSelectedDate(tab.date);
                              }
                            }}
                            className={`flex-shrink-0 px-3 py-2 rounded-md text-xs font-bold uppercase tracking-wider transition-all whitespace-nowrap ${
                              isActive ? 'bg-white text-black shadow-lg' : 'text-white/60 hover:text-white hover:bg-white/10'
                            }`}
                          >
                            {tab.label}
                            {!isActive && tab.count > 0 && (
                              <span className="ml-1 opacity-50 font-normal">{tab.count}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    {filterVibe && (
                      <div className="flex items-center gap-2 px-4 py-2 mt-3 rounded-full bg-white/10 border border-white/20 animate-in fade-in w-fit">
                          <span className="text-xs text-white/60 uppercase font-bold">Vibe:</span>
                          <span className="text-sm font-bold text-white">#{filterVibe}</span>
                          <button onClick={() => setFilterVibe('')} className="p-0.5 rounded-full hover:bg-white/20 text-white/50 hover:text-white">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                          </button>
                      </div>
                    )}

                    {/* Category tabs with event counts */}
                    <div className="flex gap-2 mt-4 justify-start overflow-x-auto no-scrollbar pb-2 snap-x">
                      <button
                        onClick={() => setFilterCategory('all')}
                        className={`flex-shrink-0 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider border transition-all snap-start ${
                          filterCategory === 'all'
                            ? 'bg-white text-black border-white'
                            : 'bg-transparent text-white/60 border-white/20 hover:border-white hover:text-white'
                        }`}
                      >
                        All {categoryCounts.all > 0 && <span className="ml-1 opacity-60 font-normal">{categoryCounts.all}</span>}
                      </button>
                      {Object.keys(CATEGORY_COLORS).map(cat => (
                        <button
                          key={cat}
                          onClick={() => setFilterCategory(cat)}
                          className="flex-shrink-0 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider border transition-all snap-start"
                          style={{
                            backgroundColor: filterCategory === cat ? CATEGORY_COLORS[cat] : 'transparent',
                            borderColor: CATEGORY_COLORS[cat],
                            color: filterCategory === cat ? '#000' : 'white',
                            opacity: filterCategory === 'all' || filterCategory === cat ? 1 : 0.6
                          }}
                        >
                          {cat}{categoryCounts[cat] ? <span className="ml-1 opacity-60 font-normal">{categoryCounts[cat]}</span> : null}
                        </button>
                      ))}
                    </div>
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pb-32">
                  {filteredEvents.length > 0 ? (
                    filteredEvents.map((event) => (
                      <div key={event.id}>
                          <EventCard 
                            event={event} 
                            theme={theme} 
                            className="w-full"
                            onTagClick={handleTagClick}
                            isSuperAdmin={isSuperAdmin}
                            onEdit={handleAdminEdit}
                            onBook={handleBookEvent}
                          />
                      </div>
                    ))
                  ) : (
                    <div className="col-span-full py-12 text-center text-white/30 text-lg font-medium">
                        No upcoming drops found. Check back soon.
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      
      {currentView === 'home' && (
        <div className="fixed bottom-0 left-0 w-full z-50 pointer-events-none bg-gradient-to-t from-black via-black/90 to-transparent pt-20 pb-0">
          <div className="w-full max-w-5xl mx-auto pointer-events-auto px-4 md:px-0">
            <ChatInput onSend={handleSendMessage} isLoading={loadingState === LoadingState.SEARCHING} theme={theme} />
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
