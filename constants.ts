
import { KickflipEvent, EventDraft, VibemojiConfig } from "./types";

export const ADMIN_EMAILS = [
  "amrita@kickflip.co",
  "amritamahapatra13@gmail.com",
  "bryceanderson551@gmail.com",
  "halim@kickflip.co",
  "jhr8713@gmail.com",
  "vbhutkar@gmail.com",
  "vidya@kickflip.co",
  "bryce@kickflip.co" // Maintained for dev
];

export const DEFAULT_SYSTEM_INSTRUCTION = `You are Kickflip, Seattle's premier event discovery AI.
Your persona is cool, connected, and in-the-know.
Your mission is to connect users with experiences that match their vibe.

CRITICAL: KEEP RESPONSES EXTREMELY SHORT. MAX 12 WORDS.
No fluff. No "Here are some events". Just the vibe.

PROTOCOL:
1. ABUNDANCE: Always prefer showing MORE events rather than fewer. Do not artificially cap results.
2. DIVERSITY: Mix high-profile events with underground/niche hidden gems.
3. BREADTH: Ensure results cover different neighborhoods, prices, and categories if possible.
4. ACCURACY: Prioritize INTERNAL RECORDS but use Google Search to fill gaps and ensure freshness.
`;

export const HERO_VIDEOS = [
  "https://videos.pexels.com/video-files/3121459/3121459-hd_1920_1080_24fps.mp4",
  "https://videos.pexels.com/video-files/5049303/5049303-hd_1920_1080_24fps.mp4",
  "https://videos.pexels.com/video-files/2418525/2418525-hd_1920_1080_30fps.mp4",
  "https://videos.pexels.com/video-files/3929497/3929497-hd_1920_1080_30fps.mp4"
];

export const BACKGROUND_OPTIONS = [
  {
    label: 'Seattle Skyline',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1502175353174-a7a70e73b362?auto=format&fit=crop&w=2560&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1502175353174-a7a70e73b362?auto=format&fit=crop&w=400&q=60',
  },
  {
    label: 'City Life',
    type: 'video',
    url: 'https://videos.pexels.com/video-files/3121459/3121459-hd_1920_1080_24fps.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=400&q=60',
  },
  {
    label: 'Night Sky',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=2560&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=400&q=60',
  },
  {
    label: 'History Lesson',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=2560&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=400&q=60',
  },
  {
    label: 'Video Game',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?auto=format&fit=crop&w=2560&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?auto=format&fit=crop&w=400&q=60',
  },
  {
    label: 'Urban Legend',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=2560&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=400&q=60',
  },
  {
    label: 'Misty Forest',
    type: 'image',
    url: 'https://images.pexels.com/photos/167699/pexels-photo-167699.jpeg',
    thumbnail: 'https://images.pexels.com/photos/167699/pexels-photo-167699.jpeg?w=400',
  },
];

export const MUSIC_OPTIONS = [
  { label: 'Off', url: null },
  { label: 'City Pulse',       url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
  { label: 'Neon Nights',      url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
  { label: 'Rooftop Vibes',    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
  { label: 'Late Night Drive', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3' },
  { label: 'Underground Beats',url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3' },
  { label: 'Golden Hour',      url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-17.mp3' },
];

export const BRAND_COLORS = [
  '#ec4899', // Pink
  '#fb923c', // Orange
  '#a78bfa', // Violet
  '#22d3ee', // Cyan
  '#34d399', // Emerald
  '#facc15', // Yellow
  '#60a5fa', // Blue
  '#f87171', // Red
];

export const FONTS = [
  { label: 'Modern', value: 'font-sans' },
  { label: 'Classic', value: 'font-serif' },
  { label: 'Typewriter', value: 'font-mono' },
];

export const CATEGORY_COLORS: Record<string, string> = {
  music: '#ec4899',
  food: '#fb923c',
  art: '#a78bfa',
  party: '#22d3ee',
  outdoor: '#34d399',
  wellness: '#60a5fa',
  fashion: '#facc15',
  sports: '#ef4444',
  comedy: '#84cc16', // Lime
  other: '#9ca3af'
};

export const DEFAULT_INITIAL_DRAFT: EventDraft = {
  id: '',
  concept: '',
  title: '',
  category: 'other',
  vibeDescription: '',
  tone: 'hype',
  locationName: '',
  address: '',
  startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  startTime: '19:00',
  endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  endTime: '22:00',
  isFree: false,
  price: '20',
  isUnlimitedCapacity: true,
  capacity: 100,
  overview: '',
  collaborators: [],
  providerName: '',
  socialLinks: {},
  media: [],
  vibemoji: {
    baseId: 'event', hat: 'none', outfit: 'none', pants: 'jeans', shoes: 'skate', expression: 'happy',
    glasses: 'none', jewelry: 'none', skinTone: '#fca5a5', primaryColor: '#ec4899'
  },
  themeColor: '#ec4899',
  status: 'draft',
  ticketsSold: 0,
};

// CATEGORY_VIDEOS_MAP and getVideoForEvent removed — Pexels videos caused blank cards
// (videos failed to load → no imageUrl fallback → gradient). Use imageUrl with Unsplash instead.
//
// Unsplash category fallbacks (matches server.js UNSPLASH_FALLBACK):
//   music:    photo-1493225457124-a3eb161ffa5f
//   art:      photo-1547891654-e66ed7ebb968
//   food:     photo-1414235077428-338989a2e8c0
//   outdoor:  photo-1441974231531-c6227db76b6e
//   comedy:   photo-1527224538127-2104bb71c51b
//   sports:   photo-1461896836934-ffe607ba8211
//   wellness: photo-1544367567-0f2fcb009e0b
//   party:    photo-1516450360452-9312f5e86fc7
//   other:    photo-1492684223066-81342ee5ff30

export const draftToEvent = (draft: EventDraft): KickflipEvent => {
    // Check if the user has uploaded specific media
    const hasCustomMedia = draft.media && draft.media.length > 0;

    // User-created events use their uploaded media; no Pexels video fallback
    const fallbackVideo = (hasCustomMedia || draft.iframeUrl) ? undefined : undefined;

    // Determine correct link strategy:
    // 1. If it's a crawled/imported event with an explicit source URL, use that.
    // 2. Otherwise, use internal deep link.
    const externalLink = (draft.origin === 'crawl' && (draft.iframeUrl || draft.crawlSource))
        ? (draft.iframeUrl || '#')
        : undefined;

    return {
        ...draft,
        id: draft.id,
        title: draft.title,
        date: draft.startDate || 'TBD',
        location: draft.locationName || 'TBD',
        // Fallback to overview if short vibe description is missing
        description: draft.vibeDescription || draft.overview || '',
        category: draft.category,
        vibeTags: [`#${draft.category}`, '#my-event', draft.isFree ? '#free' : '#paid'],
        link: externalLink || `/?event=${draft.id}`, // Prioritize external for crawled events
        price: draft.isFree ? 'Free' : `$${draft.price}`,
        media: draft.media,
        organizer: draft.providerName || (draft.origin === 'crawl' ? draft.crawlSource : 'Me'),
        vibemoji: draft.vibemoji,
        // Ensure legacy fields are only populated if custom media is absent
        videoUrl: fallbackVideo,
        imageUrl: undefined,
        origin: draft.origin,
        crawlSource: draft.crawlSource,
        iframeUrl: draft.iframeUrl
    };
};

const defaultVibemoji = (color: string): VibemojiConfig => ({
    baseId: 'duck', primaryColor: color, hat: 'cap', outfit: 'hoodie', expression: 'happy', skinTone: '#fca5a5'
});

export const FEATURED_EVENTS: KickflipEvent[] = [
    {
      id: "emerald-city-music-1",
      title: "Emerald City Music Season",
      date: "See Calendar",
      location: "Various Locations",
      description: "Eclectic, intimate chamber music experiences in non-traditional venues.",
      category: "music",
      vibeTags: ["#classical", "#chambermusic", "#intimate"],
      link: "https://emeraldcitymusic.org/calendar",
      price: "Varies",
      organizer: "Emerald City Music",
      imageUrl: "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Emerald City Music"
    },
    {
      id: "af-seattle-780",
      title: "Alliance Française: French Culture",
      date: "See Calendar",
      location: "Alliance Française de Seattle",
      description: "Cinema, conversation, and cultural events celebrating all things French.",
      category: "art",
      vibeTags: ["#french", "#culture", "#cinema"],
      link: "https://www.afseattle.org/community/event-rsvp/?event_id=780",
      price: "Varies",
      organizer: "AF Seattle",
      imageUrl: "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "AF Seattle"
    },
    {
      id: "handstamp-ritual-mates",
      title: "Ritual of Mates",
      date: "Upcoming",
      location: "Seattle",
      description: "A gathering for connection and music. Check the link for location drop.",
      category: "party",
      vibeTags: ["#ritual", "#social", "#music"],
      link: "https://www.handstamp.com/e/ritual-of-mates-zvqu48jh",
      price: "See Link",
      organizer: "Handstamp",
      imageUrl: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Handstamp"
    },
    {
      id: "the-improv-place-1",
      title: "The Improv Place",
      date: "See Schedule",
      location: "The Improv Place",
      description: "Drop-in improv classes and jams. Connect through comedy.",
      category: "comedy",
      vibeTags: ["#improv", "#comedy", "#workshop"],
      link: "https://theimprovplace.org/",
      price: "Varies",
      organizer: "The Improv Place",
      imageUrl: "https://images.unsplash.com/photo-1527224538127-2104bb71c51b?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "The Improv Place"
    },
    {
      id: "fremont-abbey-1",
      title: "Live at Fremont Abbey",
      date: "See Calendar",
      location: "Fremont Abbey Arts Center",
      description: "Community arts center hosting concerts, storytelling, and dance in a historic building.",
      category: "music",
      vibeTags: ["#acoustic", "#community", "#fremont"],
      link: "https://www.fremontabbey.org/events/",
      price: "Varies",
      organizer: "Fremont Abbey",
      imageUrl: "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Fremont Abbey"
    },
    {
      id: "spin-seattle-1",
      title: "SPIN Seattle Ping Pong",
      date: "Daily",
      location: "Downtown Seattle",
      description: "Ping pong social club with cocktails, food, and plenty of tables.",
      category: "party", // or sports
      vibeTags: ["#pingpong", "#social", "#drinks"],
      link: "https://wearespin.com/location/seattle/",
      price: "Varies",
      organizer: "SPIN",
      imageUrl: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "SPIN"
    },
    {
      id: "tractor-tavern-1",
      title: "Tractor Tavern Shows",
      date: "See Calendar",
      location: "Ballard",
      description: "Historic Ballard venue for folk, country, rock, and Americana.",
      category: "music",
      vibeTags: ["#ballard", "#folk", "#livemusic"],
      link: "https://tractortavern.com/calendar/",
      price: "Varies",
      organizer: "Tractor Tavern",
      imageUrl: "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Tractor Tavern"
    },
    {
      id: "fountainhead-gallery-1",
      title: "Fountainhead Gallery Presents",
      date: "See Exhibits",
      location: "Queen Anne",
      description: "Fine art gallery featuring Pacific Northwest artists.",
      category: "art",
      vibeTags: ["#gallery", "#fineart", "#queenanne"],
      link: "https://www.fountainheadgallery.com/fountainhead-presents",
      price: "Free",
      organizer: "Fountainhead Gallery",
      imageUrl: "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Fountainhead"
    },
    {
      id: "stonington-michael-nicoll-1",
      title: "Michael Nicoll Yahgulanaas Exhibit",
      date: "Current Exhibit",
      location: "Stonington Gallery",
      description: "Contemporary indigenous art from the Pacific Northwest Coast.",
      category: "art",
      vibeTags: ["#indigenous", "#art", "#exhibit"],
      link: "https://stoningtongallery.com/exhibit/michael-nicoll-yahgulanaas/",
      price: "Free",
      organizer: "Stonington Gallery",
      imageUrl: "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Stonington"
    },
    {
      id: "seattle-rep-blueberries-1",
      title: "Here There Are Blueberries",
      date: "2025/26 Season",
      location: "Seattle Rep",
      description: "A powerful new play examining photography and history.",
      category: "art",
      vibeTags: ["#theater", "#drama", "#seattlerep"],
      link: "https://www.seattlerep.org/plays/202526-season/here-there-are-blueberries",
      price: "Tickets Required",
      organizer: "Seattle Rep",
      imageUrl: "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Seattle Rep"
    },
    {
      id: "siff-programs-1",
      title: "SIFF Programs & Events",
      date: "See Schedule",
      location: "SIFF Cinema",
      description: "Year-round film programs, festivals, and special screenings.",
      category: "art", // Film
      vibeTags: ["#film", "#cinema", "#siff"],
      link: "https://www.siff.net/programs-and-events",
      price: "Varies",
      organizer: "SIFF",
      imageUrl: "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "SIFF"
    },
    {
      id: "mariners-tours-1",
      title: "T-Mobile Park Tours",
      date: "See Schedule",
      location: "T-Mobile Park",
      description: "Go behind the scenes of the home of the Seattle Mariners.",
      category: "sports",
      vibeTags: ["#baseball", "#tours", "#mariners"],
      link: "https://www.mlb.com/mariners/ballpark/tours",
      price: "$15+",
      organizer: "Seattle Mariners",
      imageUrl: "https://images.unsplash.com/photo-1461896836934-ffe607ba8211?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Mariners"
    },
    {
      id: "chop-yoga-1",
      title: "Yoga with Jennifer Isaacson",
      date: "See Dates",
      location: "Chophouse Row",
      description: "Community yoga sessions in the heart of Capitol Hill.",
      category: "wellness",
      vibeTags: ["#yoga", "#caphill", "#community"],
      link: "https://www.chophouserow.com/events/yoga-with-jennifer-isaacson-x-sweatbox",
      price: "Varies",
      organizer: "Chophouse Row",
      imageUrl: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Chophouse Row"
    },
    {
      id: "chop-stitch-poke-1",
      title: "Stitch & Poke Maker Meetup",
      date: "See Dates",
      location: "Chophouse Row",
      description: "Bring your craft projects and meet other makers.",
      category: "fashion", // or art/other
      vibeTags: ["#craft", "#maker", "#social"],
      link: "https://www.chophouserow.com/events/stitch-and-poke-maker-meetup",
      price: "Free",
      organizer: "Chophouse Row",
      imageUrl: "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Chophouse Row"
    },
    {
      id: "chop-celine-studio-1",
      title: "Celine Waldmann Open Studio",
      date: "Feb 1",
      location: "Chophouse Row",
      description: "Visit the studio of artist Celine Waldmann.",
      category: "art",
      vibeTags: ["#openstudio", "#art", "#local"],
      link: "https://www.chophouserow.com/events/celine-waldmann-studio-kaylee-davis-feb1",
      price: "Free",
      organizer: "Chophouse Row",
      imageUrl: "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Chophouse Row"
    },
    {
      id: "friend-museum-popups-1",
      title: "The Friend Museum Events",
      date: "See Schedule",
      location: "The Friend Museum",
      description: "Classes, pop-ups, and creative events.",
      category: "art",
      vibeTags: ["#classes", "#museum", "#creative"],
      link: "https://www.friendmuseum.com/events-classes-popups",
      price: "Varies",
      organizer: "Friend Museum",
      imageUrl: "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Friend Museum"
    },
    {
      id: "ig-post-DT0uleaDH74",
      title: "Trending: Seattle Vibes",
      date: "Just Posted",
      location: "Seattle, WA",
      description: "Trending on the Seattle social scene. Click to watch on Instagram.",
      category: "party",
      vibeTags: ["#instagram", "#trending", "#seattle"],
      link: "https://www.instagram.com/p/DT0uleaDH74/",
      price: "Free",
      organizer: "IG Spotlight",
      imageUrl: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&fit=crop&auto=format",
      vibemoji: { baseId: 'bolt', primaryColor: '#E1306C', hat: 'cap', outfit: 'jacket', glasses: 'sunnies', skinTone: '#fca5a5' }
    },
    {
      id: "fb-reel-1206838077633415",
      title: "Trending: Seattle Social Reel",
      date: "Just Spotted",
      location: "Seattle, WA",
      description: "A viral moment from the local scene. Click to watch the full reel on Facebook.",
      category: "party",
      vibeTags: ["#trending", "#viral", "#social"],
      link: "https://www.facebook.com/reel/1206838077633415",
      price: "Free",
      organizer: "Social Spotlight",
      imageUrl: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&fit=crop&auto=format",
      vibemoji: { baseId: 'bolt', primaryColor: '#1877F2', hat: 'backwards', outfit: 'hoodie', glasses: 'sunnies', skinTone: '#eac086' }
    },
    {
      id: "tuli-lodge-1",
      title: "Tuli Lodge",
      date: "Daily",
      location: "Tuli Lodge",
      description: "A wood-fired sauna and cold plunge sanctuary designed for deep relaxation.",
      category: "wellness",
      vibeTags: ["#sauna", "#coldplunge", "#wellness"],
      link: "https://www.tuli-lodge.com/",
      price: "From $35",
      organizer: "Tuli Lodge",
      imageUrl: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800&fit=crop&auto=format",
      vibemoji: { baseId: 'duck', primaryColor: '#34d399', hat: 'beanie', outfit: 'none', skinTone: '#fca5a5' }
    },
    {
      id: "the-wild-haus-1",
      title: "The Wild Haus",
      date: "See Calendar",
      location: "The Wild Haus",
      description: "A gathering space for wild ideas, community events, and good times.",
      category: "party",
      vibeTags: ["#community", "#venue", "#social"],
      link: "https://thewildhaus.com/",
      price: "Varies",
      organizer: "The Wild Haus",
      imageUrl: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&fit=crop&auto=format",
      vibemoji: { baseId: 'bolt', primaryColor: '#facc15', hat: 'cap', outfit: 'jacket', glasses: 'sunnies', skinTone: '#eac086' }
    },
    {
      id: "von-sauna-1",
      title: "Von Sauna",
      date: "Book Online",
      location: "Various Locations",
      description: "Mobile wood-fired sauna bringing the heat and community to the streets.",
      category: "wellness",
      vibeTags: ["#mobile", "#sauna", "#social"],
      link: "https://vonsauna.co/",
      price: "$$",
      organizer: "Von Sauna",
      imageUrl: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800&fit=crop&auto=format",
      vibemoji: { baseId: 'ghost', primaryColor: '#fb923c', hat: 'none', outfit: 'none', skinTone: '#d2996e' }
    },
    {
      id: "sbp-poplar-1",
      title: "SBP: Poplar",
      date: "Daily",
      location: "Poplar",
      description: "Massive bouldering gym with yoga studios, fitness areas, and community vibes.",
      category: "sports",
      vibeTags: ["#climbing", "#fitness", "#community"],
      link: "https://boulderingproject.com/",
      price: "$25",
      organizer: "SBP",
      imageUrl: "https://images.unsplash.com/photo-1461896836934-ffe607ba8211?w=800&fit=crop&auto=format",
      vibemoji: { baseId: 'bolt', primaryColor: '#ef4444', hat: 'backwards', outfit: 'tee', skinTone: '#9f7959' }
    },
    {
      id: "seattle-sauna-co-1",
      title: "Seattle Sauna Co",
      date: "Daily",
      location: "Lake Union",
      description: "Floating sauna on Lake Union. Sweat it out, then plunge into the lake.",
      category: "wellness",
      vibeTags: ["#floating", "#lakeunion", "#sauna"],
      link: "https://www.seattlesauna.com/",
      price: "From $45",
      organizer: "Seattle Sauna Co",
      imageUrl: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800&fit=crop&auto=format",
      vibemoji: { baseId: 'duck', primaryColor: '#22d3ee', hat: 'none', outfit: 'none', skinTone: '#ffe0bd' }
    },
    {
      id: "good-day-sauna-1",
      title: "Good Day Sauna",
      date: "Daily",
      location: "Seattle",
      description: "A neighborhood sauna house focused on community, health, and relaxation.",
      category: "wellness",
      vibeTags: ["#neighborhood", "#sauna", "#reset"],
      link: "https://www.gooddaysauna.com/",
      price: "$$",
      organizer: "Good Day",
      imageUrl: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800&fit=crop&auto=format",
      vibemoji: { baseId: 'pizza', primaryColor: '#facc15', hat: 'bucket', outfit: 'none', skinTone: '#eac086' }
    },
    {
      id: "rendezvous-jewelbox-1",
      title: "Cabaret at The Jewelbox",
      date: "See Calendar",
      location: "The Rendezvous",
      description: "Intimate cabaret, comedy, and burlesque in Belltown's most historic velvet-draped theater.",
      category: "art",
      vibeTags: ["#cabaret", "#belltown", "#historic"],
      link: "https://rendezvous.squarespace.com/events",
      price: "Varies",
      organizer: "The Rendezvous",
      imageUrl: "https://images.pexels.com/photos/713149/pexels-photo-713149.jpeg",
      vibemoji: { baseId: 'ghost', primaryColor: '#f87171', hat: 'none', outfit: 'jacket', glasses: 'retro', skinTone: '#ffe0bd' }
    },
    {
      id: "space-needle-loupe-1",
      title: "The Loupe Lounge",
      date: "Daily, 5pm",
      location: "Space Needle",
      description: "Sip cocktails on the world's first revolving glass floor. Unbeatable views.",
      category: "party",
      vibeTags: ["#views", "#cocktails", "#iconic"],
      link: "https://sn.web.ticketing.siaticketing.com/attractions",
      price: "$$$",
      organizer: "Space Needle",
      imageUrl: "https://images.pexels.com/photos/3121459/pexels-photo-3121459.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#22d3ee', hat: 'none', outfit: 'jacket', glasses: 'sunnies', skinTone: '#eac086' }
    },
    {
      id: "jet-city-improv-1",
      title: "Jet City Improv",
      date: "Fri & Sat",
      location: "West of Lenin",
      description: "Seattle's best improv comedians creating hilarious scenes on the spot.",
      category: "comedy",
      vibeTags: ["#comedy", "#improv", "#fun"],
      link: "https://jetcityimprov.my.salesforce-sites.com/ticket/PatronTicket__PublicTicketApp#/",
      price: "$18",
      organizer: "Jet City Improv",
      imageUrl: "https://images.pexels.com/photos/713149/pexels-photo-713149.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#facc15', hat: 'beanie', outfit: 'hoodie', expression: 'happy', skinTone: '#fca5a5' }
    },
    {
      id: "crocodile-ticketweb-1",
      title: "Live at The Crocodile",
      date: "See Lineup",
      location: "The Crocodile",
      description: "Catch the latest touring acts and local legends at Seattle's rock 'n' roll landmark.",
      category: "music",
      vibeTags: ["#livemusic", "#rock", "#belltown"],
      link: "https://www.ticketweb.com/venue/the-crocodile-seattle-wa/10352",
      price: "Varies",
      organizer: "The Crocodile",
      imageUrl: "https://images.pexels.com/photos/167636/pexels-photo-167636.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#ef4444', hat: 'cap', outfit: 'jacket', glasses: 'star', skinTone: '#d2996e' }
    },
    {
      id: "mopop-soundoff-2025",
      title: "Sound Off! 2025",
      date: "Coming Soon",
      location: "MoPOP",
      description: "The Pacific Northwest's premier 21-and-under music showcase. Support local youth talent.",
      category: "music",
      vibeTags: ["#livemusic", "#showcase", "#allages"],
      link: "https://www.mopop.org/programs/sound-off?fbclid=IwY2xjawPdQiJleHRuA2FlbQEwAGFkaWQBqyqY6_4MXXNydGMGYXBwX2lkEDIyMjAzOTE3ODgyMDA4OTIAAR4sMsKPdkLS0baZUNlY1Ik63sDw5Y1PlVJ3m06qBJwR01Zn8eMt-vUsRpb8dg_aem_lIKPWoNnxbAp4s5_ETzvaw#tickets",
      price: "From $20",
      organizer: "MoPOP",
      imageUrl: "https://images.pexels.com/photos/167636/pexels-photo-167636.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#ec4899', hat: 'beanie', outfit: 'jacket', skinTone: '#fca5a5' }
    },
    {
      id: "yambambo-salsa-1",
      title: "Yambambo Salsa Live",
      date: "See Schedule",
      location: "Various Locations",
      description: "High energy salsa orchestra bringing the heat to Seattle's dance floors.",
      category: "music",
      vibeTags: ["#salsa", "#latin", "#dance"],
      link: "https://yambambosalsa.com/shows/",
      price: "Varies",
      organizer: "Yambambo",
      imageUrl: "https://images.pexels.com/photos/12312/pexels-photo-12312.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#ef4444', hat: 'none', outfit: 'tee', skinTone: '#eac086' }
    },
    {
      id: "pnw-markets-1",
      title: "PNW Neighborhood Market",
      date: "Next Market",
      location: "Seattle Area",
      description: "Community market featuring local vendors, food trucks, and good vibes.",
      category: "fashion",
      vibeTags: ["#market", "#shoplocal", "#community"],
      link: "https://www.pnwneighborhoodmarkets.com/events/event-one-28nrh",
      price: "Free",
      organizer: "PNW Markets",
      imageUrl: "https://images.pexels.com/photos/1855214/pexels-photo-1855214.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#34d399', hat: 'bucket', outfit: 'flannel', skinTone: '#fca5a5' }
    },
    {
      id: "puppy-yoga-club-1",
      title: "Puppy Yoga Club",
      date: "Sat & Sun",
      location: "Seattle (Secret Location)",
      description: "Yoga + Puppies. The cutest wellness trend has arrived in Seattle.",
      category: "wellness",
      vibeTags: ["#puppyyoga", "#wellness", "#cute"],
      link: "https://puppy-yogaclub.com/products/seattle",
      price: "From $45",
      organizer: "Puppy Yoga Club",
      imageUrl: "https://images.pexels.com/photos/4056535/pexels-photo-4056535.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#facc15', hat: 'halo', outfit: 'tee', skinTone: '#fca5a5' }
    },
    {
      id: "puppies-yoga-studio-2",
      title: "Puppies & Yoga",
      date: "Select Weekends",
      location: "Studio 2, Seattle",
      description: "Get your serotonin fix. 45 mins of yoga, 30 mins of puppy playtime.",
      category: "wellness",
      vibeTags: ["#yoga", "#puppies", "#relax"],
      link: "https://puppies-yoga.com/products/seattle-studio-2?variant=53012672414036",
      price: "$35+",
      organizer: "Puppies & Yoga",
      imageUrl: "https://images.pexels.com/photos/3760259/pexels-photo-3760259.jpeg",
      vibemoji: { baseId: 'ghost', primaryColor: '#60a5fa', hat: 'none', outfit: 'hoodie', skinTone: '#ffe0bd' }
    },
    {
      id: "kraken-climate-1",
      title: "Seattle Kraken vs. Canucks",
      date: "Thu, 7pm",
      location: "Climate Pledge Arena",
      description: "Release the Kraken! Fast-paced hockey in the world's most sustainable arena.",
      category: "sports",
      vibeTags: ["#nhl", "#hockey", "#climatepledge"],
      link: "https://www.ticketmaster.com/discover/seattle?categoryId=KZFzniwnSyZfZ7v7nE",
      price: "From $60",
      organizer: "Seattle Kraken",
      imageUrl: "https://images.pexels.com/photos/976873/pexels-photo-976873.jpeg",
      vibemoji: { baseId: 'ghost', primaryColor: '#99D9D9', hat: 'beanie', outfit: 'hoodie', skinTone: '#fca5a5' }
    },
    {
      id: "bonsai-wa-1",
      title: "Bonsai Bar @ Seattle Brewing",
      date: "Thu-Sun, 6pm",
      location: "Seattle, WA",
      description: "Learn the art of Bonsai while sipping local brews. Perfect for beginners.",
      category: "other",
      vibeTags: ["#workshop", "#bonsai", "#creative"],
      link: "https://bonsaibar.com/collections/washington",
      price: "From $75",
      organizer: "Bonsai Bar",
      imageUrl: "https://images.pexels.com/photos/3015488/pexels-photo-3015488.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#34d399', hat: 'beanie', outfit: 'flannel', skinTone: '#eac086' }
    },
    {
      id: "loft-ave-sewing-1",
      title: "Sip & Sew Workshop",
      date: "Sat & Sun, 2pm",
      location: "Loft on the Ave",
      description: "Hands-on sewing and design classes in a creative studio environment.",
      category: "fashion",
      vibeTags: ["#sewing", "#design", "#workshop"],
      link: "https://loftontheave.com/collections/sewing-design-classes",
      price: "Varies",
      organizer: "Loft on the Ave",
      imageUrl: "https://images.pexels.com/photos/1908658/pexels-photo-1908658.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#facc15', hat: 'cap', outfit: 'tee', skinTone: '#ffe0bd' }
    },
    {
      id: "tamari-bar-hh-1",
      title: "Tamari Bar Happy Hour",
      date: "Daily, 4pm-6pm",
      location: "Tamari Bar",
      description: "Legendary Seattle happy hour with creative Izakaya small bites.",
      category: "food",
      vibeTags: ["#izakaya", "#happyhour", "#caphill"],
      link: "https://www.tamaribarseattle.com/happy-hour-1",
      price: "No Cover",
      organizer: "Tamari Bar",
      imageUrl: "https://images.pexels.com/photos/3205934/pexels-photo-3205934.jpeg",
      vibemoji: { baseId: 'pizza', primaryColor: '#fb923c', hat: 'none', outfit: 'none', skinTone: '#d2996e' }
    },
    {
      id: "populus-gallery-1",
      title: "Populus Art Showcase",
      date: "First Thu & Sat",
      location: "Populus Seattle",
      description: "Community-driven art gallery and event space featuring local creators.",
      category: "art",
      vibeTags: ["#gallery", "#localart", "#community"],
      link: "https://populusseattle.com/events-calendar/",
      price: "Free/Varies",
      organizer: "Populus Seattle",
      imageUrl: "https://images.pexels.com/photos/3754968/pexels-photo-3754968.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#a78bfa', hat: 'bucket', outfit: 'tee', glasses: 'retro', skinTone: '#fca5a5' }
    },
    {
      id: "feat-001",
      title: "Sunset Spin @ Golden Gardens",
      date: "Daily, Sunset",
      location: "Golden Gardens",
      description: "Live DJ sets as the sun dips below the Olympics. Bring a blanket.",
      category: "outdoor",
      vibeTags: ["#sunset", "#chill", "#views"],
      link: "https://seattle.gov/parks",
      price: "Free",
      organizer: "Seattle Parks",
      imageUrl: "https://images.pexels.com/photos/3327672/pexels-photo-3327672.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#34d399', hat: 'cap', outfit: 'hoodie', expression: 'chill', skinTone: '#684b39' }
    },
    {
      id: "kremwerk-complex-1",
      title: "Kremwerk Complex Late Night",
      date: "Fri & Sat, 10pm-4am",
      location: "Kremwerk",
      description: "The heartbeat of Seattle techno. Dark room, loud system, good vibes.",
      category: "party",
      vibeTags: ["#techno", "#queer", "#latenight"],
      link: "https://www.kremwerk.com/",
      price: "$15-25",
      organizer: "Kremwerk",
      imageUrl: "https://images.pexels.com/photos/1587927/pexels-photo-1587927.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#ec4899', hat: 'none', outfit: 'jacket', glasses: 'star', skinTone: '#9f7959' }
    },
    {
      id: "barboza-indie-1",
      title: "Indie Sleaze Dance Night",
      date: "Tonight, 9pm",
      location: "Barboza",
      description: "Sweaty basement dance floor playing 2000s indie hits.",
      category: "music",
      vibeTags: ["#indie", "#dance", "#caphill"],
      link: "https://thebarboza.com/",
      price: "$12",
      organizer: "Barboza",
      imageUrl: "https://images.pexels.com/photos/167636/pexels-photo-167636.jpeg",
      vibemoji: { baseId: 'arcade', primaryColor: '#a78bfa', hat: 'cap', outfit: 'tee', glasses: 'nerd', skinTone: '#fca5a5' }
    },
    {
      id: "fremont-market-1",
      title: "Fremont Sunday Market",
      date: "Sun, 10am-4pm",
      location: "Fremont",
      description: "Vintage finds, street food, and local crafts under the bridge.",
      category: "fashion",
      vibeTags: ["#vintage", "#market", "#foodtrucks"],
      link: "https://www.fremontmarket.com/",
      price: "Free",
      organizer: "Fremont Market",
      imageUrl: "https://images.pexels.com/photos/1855214/pexels-photo-1855214.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#facc15', hat: 'beanie', outfit: 'flannel', skinTone: '#3f2e26' }
    },
    {
      id: "mbar-rooftop-1",
      title: "Sky High DJ Set",
      date: "Daily, 5pm-Late",
      location: "Mbar",
      description: "Rooftop drinks with the best view of the Space Needle.",
      category: "party",
      vibeTags: ["#rooftop", "#views", "#cocktails"],
      link: "https://www.mbarseattle.com/",
      price: "No Cover",
      organizer: "Mbar",
      imageUrl: "https://images.pexels.com/photos/3121459/pexels-photo-3121459.jpeg",
      vibemoji: { baseId: 'ghost', primaryColor: '#22d3ee', hat: 'none', outfit: 'jacket', glasses: 'sunnies', skinTone: '#ffe0bd' }
    },
    {
      id: "laser-dome-1",
      title: "Laser ODESZA",
      date: "Fri & Sat, Midnight",
      location: "Pacific Science Center",
      description: "Mind-melting laser show set to ODESZA's full discography.",
      category: "art",
      vibeTags: ["#lasers", "#trippy", "#music"],
      link: "https://pacificsciencecenter.org/visit/laser-dome/",
      price: "$15",
      organizer: "PacSci",
      imageUrl: "https://images.pexels.com/photos/2422259/pexels-photo-2422259.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#a78bfa', hat: 'halo', outfit: 'none', skinTone: '#d2996e' }
    },
    {
      id: "dicks-broadway-1",
      title: "The Broadway Late Night",
      date: "Daily, until 2am",
      location: "Dick's Drive-In",
      description: "The post-club ritual. Burgers, shakes, and people watching.",
      category: "food",
      vibeTags: ["#burgers", "#latenight", "#iconic"],
      link: "https://www.ddir.com/",
      price: "$",
      organizer: "Dick's",
      imageUrl: "https://images.pexels.com/photos/1633578/pexels-photo-1633578.jpeg",
      vibemoji: { baseId: 'pizza', primaryColor: '#fb923c', hat: 'cap', outfit: 'hoodie', skinTone: '#eac086' }
    },
    {
      id: "crocodile-rock-1",
      title: "The Crocodile: Local Rock Showcase",
      date: "Fri, 8pm",
      location: "The Crocodile",
      description: "Three local bands tearing up the main stage. Loud, raw, and real.",
      category: "music",
      vibeTags: ["#rock", "#livemusic", "#belltown"],
      link: "https://www.thecrocodile.com/",
      price: "$20",
      organizer: "The Crocodile",
      imageUrl: "https://images.pexels.com/photos/167636/pexels-photo-167636.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#ef4444', hat: 'none', outfit: 'jacket', skinTone: '#fca5a5' }
    },
    {
      id: "laughs-comedy-1",
      title: "Laughs Comedy: Open Mic",
      date: "Wed, 8pm",
      location: "Laughs Comedy Club",
      description: "See Seattle's rising comics before they blow up. Drinks and laughs.",
      category: "comedy",
      vibeTags: ["#comedy", "#openmic", "#drinks"],
      link: "https://www.laughscomedy.com/",
      price: "$10",
      organizer: "Laughs Comedy",
      imageUrl: "https://images.pexels.com/photos/713149/pexels-photo-713149.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#facc15', hat: 'beanie', outfit: 'hoodie', skinTone: '#eac086' }
    },
    {
      id: "georgetown-art-attack-1",
      title: "Georgetown Art Attack",
      date: "Second Sat, 6pm",
      location: "Georgetown",
      description: "Seattle's grittiest art walk. Galleries, studios, and beer.",
      category: "art",
      vibeTags: ["#artwalk", "#georgetown", "#culture"],
      link: "https://www.georgetownartattack.com/",
      price: "Free",
      organizer: "Georgetown Merchants",
      imageUrl: "https://images.pexels.com/photos/3754968/pexels-photo-3754968.jpeg",
      vibemoji: { baseId: 'arcade', primaryColor: '#a78bfa', hat: 'bucket', outfit: 'tee', glasses: 'retro', skinTone: '#9f7959' }
    },
    {
      id: "ballard-farmers-market-1",
      title: "Ballard Farmers Market",
      date: "Sun, 9am-2pm",
      location: "Ballard Ave NW",
      description: "The gold standard of Seattle markets. Fresh produce, flowers, and street music.",
      category: "food",
      vibeTags: ["#market", "#local", "#ballard"],
      link: "https://www.sfmamarkets.com/ballard-farmers-market",
      price: "Free",
      organizer: "SFMA",
      imageUrl: "https://images.pexels.com/photos/1855214/pexels-photo-1855214.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#34d399', hat: 'cap', outfit: 'flannel', skinTone: '#ffe0bd' }
    },
    {
      id: "neumos-hiphop-1",
      title: "Neumos: Bass & Bars",
      date: "Fri, 9pm",
      location: "Neumos",
      description: "Heavy bass and lyrical flows in the heart of Cap Hill.",
      category: "music",
      vibeTags: ["#hiphop", "#bass", "#caphill"],
      link: "https://www.neumos.com/",
      price: "$25",
      organizer: "Neumos",
      imageUrl: "https://images.pexels.com/photos/167636/pexels-photo-167636.jpeg",
      vibemoji: { baseId: 'ghost', primaryColor: '#ec4899', hat: 'backwards', outfit: 'hoodie', glasses: 'sunnies', skinTone: '#d2996e' }
    },
    {
      id: "jazz-alley-1",
      title: "Jazz Alley: Dinner Show",
      date: "Daily, 7:30pm",
      location: "Dimitriou's Jazz Alley",
      description: "World-class jazz in an intimate supper club setting.",
      category: "music",
      vibeTags: ["#jazz", "#dinner", "#classy"],
      link: "https://www.jazzalley.com/",
      price: "From $35",
      organizer: "Jazz Alley",
      imageUrl: "https://images.pexels.com/photos/1443564/pexels-photo-1443564.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#facc15', hat: 'none', outfit: 'jacket', skinTone: '#684b39' }
    },
    {
      id: "greenlake-pickleball-1",
      title: "Green Lake Pickleball Open",
      date: "Sat, 10am",
      location: "Green Lake Park",
      description: "Join the craze. Open play for all levels by the lake.",
      category: "sports",
      vibeTags: ["#pickleball", "#active", "#greenlake"],
      link: "https://www.seattle.gov/parks",
      price: "Free",
      organizer: "Seattle Parks",
      imageUrl: "https://images.pexels.com/photos/3327672/pexels-photo-3327672.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#34d399', hat: 'cap', outfit: 'tee', skinTone: '#fca5a5' }
    },
    {
      id: "rat-city-roller-1",
      title: "Rat City Roller Derby",
      date: "Sat, 5pm",
      location: "Team Place",
      description: "Fast, furious, and full of attitude. Seattle's premier roller derby league.",
      category: "sports",
      vibeTags: ["#rollerderby", "#action", "#community"],
      link: "https://ratcityrollerderby.com/",
      price: "$20",
      organizer: "RCRD",
      imageUrl: "https://images.pexels.com/photos/209875/pexels-photo-209875.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#ec4899', hat: 'none', outfit: 'tee', glasses: 'star', skinTone: '#ffe0bd' }
    },
    {
      id: "sl-kayak-1",
      title: "Sunset Kayak Tour",
      date: "Daily, Sunset",
      location: "South Lake Union",
      description: "Paddle out as the city lights turn on. Beautiful views of the Space Needle.",
      category: "outdoor",
      vibeTags: ["#kayak", "#sunset", "#views"],
      link: "https://www.nwoc.com/",
      price: "$40",
      organizer: "NWOC",
      imageUrl: "https://images.pexels.com/photos/635279/pexels-photo-635279.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#22d3ee', hat: 'beanie', outfit: 'jacket', skinTone: '#9f7959' }
    },
    {
      id: "frye-museum-1",
      title: "Frye Museum: Always Free",
      date: "Tue-Sun, 11am-5pm",
      location: "First Hill",
      description: "Stunning collection of 19th and 20th century art. Always free admission.",
      category: "art",
      vibeTags: ["#museum", "#free", "#art"],
      link: "https://fryemuseum.org/",
      price: "Free",
      organizer: "Frye Art Museum",
      imageUrl: "https://images.pexels.com/photos/2123337/pexels-photo-2123337.jpeg",
      vibemoji: { baseId: 'ghost', primaryColor: '#a78bfa', hat: 'none', outfit: 'none', glasses: 'retro', skinTone: '#eac086' }
    },
    {
      id: "q-nightclub-1",
      title: "Q Nightclub: House & Techno",
      date: "Fri & Sat, 10pm",
      location: "Capitol Hill",
      description: "State-of-the-art sound system and world-class DJs. The place to dance.",
      category: "party",
      vibeTags: ["#house", "#techno", "#club"],
      link: "https://qnightclub.com/",
      price: "$20-40",
      organizer: "Q Nightclub",
      imageUrl: "https://images.pexels.com/photos/3196377/pexels-photo-3196377.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#60a5fa', hat: 'none', outfit: 'tee', glasses: 'sunnies', skinTone: '#fca5a5' }
    },
    {
      id: "chinatown-dimsum-1",
      title: "Honey Court: Late Night Dim Sum",
      date: "Daily, until 2am",
      location: "Chinatown-ID",
      description: "Satisfy those late night cravings with authentic dim sum and BBQ pork.",
      category: "food",
      vibeTags: ["#dimsum", "#latenight", "#authentic"],
      link: "https://www.honeycourt.com/",
      price: "$$",
      organizer: "Honey Court",
      imageUrl: "https://images.pexels.com/photos/8523126/pexels-photo-8523126.jpeg",
      vibemoji: { baseId: 'pizza', primaryColor: '#fb923c', hat: 'none', outfit: 'hoodie', skinTone: '#d2996e' }
    },
    {
      id: "siff-cinema-1",
      title: "SIFF: Midnight Movies",
      date: "Fri & Sat, Midnight",
      location: "SIFF Cinema Egyptian",
      description: "Cult classics and weird cinema on the big screen. Popcorn included.",
      category: "art",
      vibeTags: ["#cinema", "#cultclassic", "#movies"],
      link: "https://www.siff.net/",
      price: "$14",
      organizer: "SIFF",
      imageUrl: "https://images.pexels.com/photos/713149/pexels-photo-713149.jpeg",
      vibemoji: { baseId: 'arcade', primaryColor: '#f87171', hat: 'cap', outfit: 'jacket', glasses: 'nerd', skinTone: '#fca5a5' }
    },
    {
      id: "high-dive-1",
      title: "High Dive: Indie Rock",
      date: "Thu-Sat, 8pm",
      location: "Fremont",
      description: "Intimate venue featuring the best up-and-coming indie bands in the PNW.",
      category: "music",
      vibeTags: ["#indie", "#livemusic", "#fremont"],
      link: "https://highdiveseattle.com/",
      price: "$15",
      organizer: "High Dive",
      imageUrl: "https://images.pexels.com/photos/167636/pexels-photo-167636.jpeg",
      vibemoji: { baseId: 'ghost', primaryColor: '#34d399', hat: 'beanie', outfit: 'flannel', skinTone: '#ffe0bd' }
    },
    {
      id: "seattle-bouldering-1",
      title: "SBP: Late Night Climb",
      date: "Daily, until 11pm",
      location: "Seattle Bouldering Project",
      description: "Chalk up and solve some problems. Huge gym, good vibes, late hours.",
      category: "wellness",
      vibeTags: ["#climbing", "#bouldering", "#fitness"],
      link: "https://seattleboulderingproject.com/",
      price: "$25",
      organizer: "SBP",
      imageUrl: "https://images.pexels.com/photos/4057317/pexels-photo-4057317.jpeg",
      vibemoji: { baseId: 'bolt', primaryColor: '#facc15', hat: 'backwards', outfit: 'tee', skinTone: '#9f7959' }
    },
    {
      id: "sofar-secret-1",
      title: "Secret Cap Hill Gig",
      date: "Tonight, 8pm",
      location: "Secret Location",
      description: "Intimate gig with 3 surprise artists. BYOB.",
      category: "music",
      vibeTags: ["#secret", "#acoustic", "#intimate"],
      link: "https://www.sofarsounds.com/cities/seattle",
      price: "$25",
      organizer: "Sofar Sounds",
      imageUrl: "https://images.pexels.com/photos/210922/pexels-photo-210922.jpeg",
      vibemoji: { baseId: 'ghost', primaryColor: '#ec4899', hat: 'beanie', outfit: 'flannel', skinTone: '#fca5a5' }
    },
    {
      id: "paramount-lion-1",
      title: "Broadway at the Paramount",
      date: "Tue-Sun, 7:30pm",
      location: "Paramount Theatre",
      description: "World-class touring Broadway productions in a historic landmark theater.",
      category: "art",
      vibeTags: ["#theater", "#broadway", "#culture"],
      link: "https://www.stgpresents.org/paramount",
      price: "From $45",
      organizer: "STG Presents",
      imageUrl: "https://images.pexels.com/photos/713149/pexels-photo-713149.jpeg",
      vibemoji: { baseId: 'duck', primaryColor: '#f87171', hat: 'crown', outfit: 'jacket', skinTone: '#ffe0bd' }
    },
    {
      id: "mirra-calendar-1",
      title: "Mirra: Immersive Social Gaming",
      date: "See Calendar",
      location: "Bellevue",
      description: "A retro-future social gaming venue with drinks, VR, and immersive party games.",
      category: "party",
      vibeTags: ["#gaming", "#social", "#immersive"],
      link: "https://www.visitmirra.com/calendar",
      price: "Varies",
      organizer: "Mirra",
      imageUrl: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Visit Mirra"
    },
    {
      id: "be-here-now-1",
      title: "Be Here Now: Sound Bath",
      date: "See Schedule",
      location: "Be Here Now",
      description: "Deep relaxation sound baths, meditation circles, and mindfulness workshops.",
      category: "wellness",
      vibeTags: ["#soundbath", "#meditation", "#healing"],
      link: "https://www.beherenowseattle.com/schedule",
      price: "Varies",
      organizer: "Be Here Now",
      imageUrl: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Be Here Now"
    },
    {
      id: "adventures-seattle-hike-1",
      title: "Guided Hiking Adventures",
      date: "Book Online",
      location: "Greater Seattle Area",
      description: "Professional guided hikes to waterfalls, mountain peaks, and temperate rainforests.",
      category: "outdoor",
      vibeTags: ["#hiking", "#nature", "#guidedtour"],
      link: "https://www.adventuresinseattle.com/#hiking-adventures",
      price: "$$$",
      organizer: "Adventures in Seattle",
      imageUrl: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Adventures in Seattle"
    },
    {
      id: "theodora-wine-1",
      title: "Theodora Events",
      date: "See Calendar",
      location: "Ravenna",
      description: "Seasonal dinners, wine tastings, and special culinary events.",
      category: "food",
      vibeTags: ["#wine", "#dinner", "#ravenna"],
      link: "https://www.theodora.wine/events?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAdGRleAPmMfxleHRuA2FlbQIxMQBzcnRjBmFwcF9pZA8xMjQwMjQ1NzQyODc0MTQAAacb3R9uD2KDCkVBQv2D75CcWSLr7WyUsW4nMOKNkOrmfWXdNMNsS-moOEr_9g_aem_0Kx3cP-TuMrs2eJM6H05tA",
      price: "Varies",
      organizer: "Theodora",
      imageUrl: "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&fit=crop&auto=format",
      origin: "crawl",
      crawlSource: "Theodora"
    }
];
