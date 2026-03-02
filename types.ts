
export interface KickflipEvent {
  id: string;
  title: string;
  date: string; // legacy display string (fallback)
  location: string; // legacy display string (fallback)
  address?: string; // Full address for display
  city?: string;    // Short city name for card display
  description: string; // legacy display string (fallback)
  category: 'music' | 'food' | 'art' | 'outdoor' | 'party' | 'wellness' | 'fashion' | 'sports' | 'comedy' | 'other';
  vibeTags: string[];
  link: string;
  imageUrl?: string;
  organizer?: string; 
  price?: string;     
  videoUrl?: string;
  media?: { type: 'image' | 'video'; url: string; file?: File }[];
  overview?: string;
  vibemoji?: VibemojiConfig;
  status?: 'active' | 'draft' | 'completed';

  // Unified Fields from Creation Flow (Priority Display)
  locationName?: string;
  startDate?: string; // YYYY-MM-DD
  startTime?: string; // HH:MM
  vibeDescription?: string;
  themeColor?: string;
  
  // Admin / Crawl Fields
  origin?: 'user' | 'crawl';
  crawlSource?: string;
  iframeUrl?: string; // If we embed the site directly
  creatorId?: string; // Owner ID for dashboard filtering
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  events?: KickflipEvent[];
}

export interface NotificationPreferences {
  eventUpdates: boolean;
  bookingConfirmations: boolean;
  reminders: boolean;
  productAnnouncements: boolean;
}

export interface OnboardingPreferences {
  vibes: string[];
  location: string;
  timing: string[];
  completed: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatar: string;
  createdEvents?: string[]; // IDs of created events
  stripeConnected?: boolean;
  // Profile Fields
  phoneNumber?: string;
  profileVideoUrl?: string; // Legacy support
  profileCoverUrl?: string; // New field for generic cover (image or video)
  profileCoverType?: 'image' | 'video'; // New field to distinguish type
  notificationPreferences?: NotificationPreferences;
  onboardingPreferences?: OnboardingPreferences;
  isBanned?: boolean; // Admin action
}

export interface ChatSession {
  id: string;
  timestamp: number;
  preview: string;
  messages: ChatMessage[];
}

export enum LoadingState {
  IDLE = 'IDLE',
  THINKING = 'THINKING',
  SEARCHING = 'SEARCHING',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR'
}

export interface ThemeConfig {
  font: 'font-sans' | 'font-serif' | 'font-mono';
  accentColor: string; // Hex code
  backgroundType: 'video' | 'image';
  backgroundUrl: string;
  vibemoji: string; // id of the selected emoji
  music?: string | null; // URL of background music track, null = off
}

// --- NEW TYPES FOR CREATION FLOW ---

export type ViewState = 'home' | 'create-event' | 'dashboard' | 'profile' | 'admin' | 'event-detail';

export interface VibemojiConfig {
  baseId: string;
  hat?: 'none' | 'beanie' | 'bucket' | 'cap' | 'crown' | 'backwards' | 'halo';
  outfit?: 'none' | 'tee' | 'hoodie' | 'jacket' | 'flannel';
  pants?: 'none' | 'jeans' | 'shorts' | 'cargo' | 'skirt';
  shoes?: 'none' | 'skate' | 'boots' | 'high-tops' | 'neon';
  expression?: 'neutral' | 'happy' | 'hype' | 'chill' | 'wink';
  // New Accessories
  glasses?: 'none' | 'sunnies' | 'retro' | 'nerd' | 'star';
  jewelry?: 'none' | 'chain' | 'studs' | 'hoops';
  // Colors
  primaryColor?: string;
  skinTone?: string;
  // Brand Logo
  logoUrl?: string;
  // Dashboard Styling (Separate from Home Theme)
  font?: 'font-sans' | 'font-serif' | 'font-mono';
  backgroundType?: 'video' | 'image';
  backgroundUrl?: string;
}

export interface EventDraft {
  id: string;
  concept: string; // The magic prompt
  title: string;
  category: KickflipEvent['category'];
  vibeDescription: string;
  tone: 'hype' | 'minimal' | 'artsy';
  locationName: string;
  address: string;
  
  startDate: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endDate: string;   // YYYY-MM-DD
  endTime: string;   // HH:MM
  
  isFree: boolean;
  price: string;          // Single price string (e.g. "15")
  isUnlimitedCapacity: boolean;
  capacity: number;
  
  overview: string;
  collaborators: string[]; // emails
  providerName: string;
  socialLinks: {
    instagram?: string;
    tiktok?: string;
  };
  media: {
    type: 'image' | 'video';
    url: string; // DataURL for previews
    file?: File;
  }[];
  vibemoji: VibemojiConfig;
  themeColor: string;
  
  // Dashboard fields
  status: 'active' | 'draft' | 'completed';
  ticketsSold: number;
  payoutStatus?: 'paid' | 'processing' | 'scheduled';
  payoutDate?: string;

  // Admin Fields
  origin?: 'user' | 'crawl';
  crawlSource?: string;
  iframeUrl?: string;
  creatorId?: string; // New field for global registry filtering
}

// --- ADMIN TYPES ---

export interface CrawlJob {
  id: string;
  targetUrl: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  eventsFound: number;
  eventsCreated: number;
  logs: string[];
  timestamp: number;
}

export interface AdminLog {
  id: string;
  adminEmail: string;
  action: string;
  targetId?: string;
  timestamp: number;
}
