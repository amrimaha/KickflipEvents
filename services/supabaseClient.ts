
import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { EventDraft } from '../types';
import { DEFAULT_INITIAL_DRAFT } from '../constants';

// Key for LocalStorage
const STORAGE_KEY = 'kickflip_backend_config';

let supabase: SupabaseClient | null = null;
let subscription: RealtimeChannel | null = null;

// Initialization Logic
const initFromEnv = () => {
    let url = '';
    let key = '';

    // 1. Vite Static Replacement
    // CRITICAL: We use @ts-ignore and direct access (import.meta.env.VAR) 
    // so that bundlers like Vite can statically replace these strings at build time.
    try {
        // @ts-ignore
        if (import.meta.env) {
            // @ts-ignore
            url = import.meta.env.VITE_SUPABASE_URL || import.meta.env.SUPABASE_URL || '';
            // @ts-ignore
            key = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.SUPABASE_ANON_KEY || '';
        }
    } catch (e) {}

    // 2. Process Env (Node/Webpack/Runtime Injection)
    if (!url || !key) {
        try {
            if (typeof process !== 'undefined' && process.env) {
                // Direct access for Webpack/CRA replacement
                url = process.env.REACT_APP_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
                key = process.env.REACT_APP_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
            }
        } catch (e) {}
    }

    // 3. Window injection (Runtime config pattern for Dockerized frontends)
    if (!url || !key) {
        try {
             if (typeof window !== 'undefined') {
                const win = window as any;
                const env = win._env_ || win.env || win.__ENV__;
                if (env) {
                    url = env.SUPABASE_URL || env.VITE_SUPABASE_URL || env.REACT_APP_SUPABASE_URL || '';
                    key = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || env.REACT_APP_SUPABASE_ANON_KEY || '';
                }
             }
        } catch(e) {}
    }

    if (url && key && url !== 'https://your-project.supabase.co') {
        try {
            supabase = createClient(url, key);
            console.log("Kickflip: Backend DB Connected via Environment Variables.");
            return true;
        } catch (e) {
            console.error("Kickflip: Failed to initialize Supabase from Env Vars", e);
        }
    }
    return false;
};

const initFromStorage = () => {
    try {
        const savedConfig = localStorage.getItem(STORAGE_KEY);
        if (savedConfig) {
            const { url, key } = JSON.parse(savedConfig);
            if (url && key) {
                supabase = createClient(url, key);
                console.log("Kickflip: Backend DB Connected via LocalStorage Config.");
                return true;
            }
        }
    } catch (e) {
        console.error("Kickflip: LocalStorage DB Init Failed", e);
    }
    return false;
};

// Attempt init order: Env -> Storage
if (!initFromEnv()) {
    initFromStorage();
}

export const isBackendConfigured = (): boolean => {
    return !!supabase;
};

export const getBackendDiagnostics = () => {
    let envUrl = '';
    try { 
        // @ts-ignore
        envUrl = import.meta.env?.VITE_SUPABASE_URL || process.env?.SUPABASE_URL || ''; 
    } catch(e) {}
    
    return {
        isConfigured: !!supabase,
        hasEnvVars: !!envUrl && envUrl !== 'https://your-project.supabase.co',
        connectionType: supabase ? (envUrl ? 'Environment' : 'Manual') : 'None'
    };
};

export const initSupabase = (url: string, key: string): boolean => {
    try {
        if (!url || !key) return false;
        const safeUrl = url.startsWith('http') ? url : `https://${url}`;
        supabase = createClient(safeUrl, key);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: safeUrl, key }));
        return true;
    } catch (e) {
        console.error("Failed to init Supabase", e);
        return false;
    }
};

export const checkConnection = async (): Promise<{ success: boolean; message?: string }> => {
    if (!supabase) return { success: false, message: 'Client not initialized' };
    try {
        const { count, error } = await supabase.from('kickflip_events').select('*', { count: 'exact', head: true });
        
        if (error) {
            if (error.code === 'PGRST301' || error.message?.includes('does not exist')) {
                return { success: false, message: 'Connected, but table "kickflip_events" missing. Run SQL script.' };
            }
            return { success: false, message: error.message || 'Connection failed' };
        }
        return { success: true };
    } catch (e: any) {
        return { success: false, message: e.message || 'Network error' };
    }
};

export const clearSupabaseConfig = () => {
    supabase = null;
    localStorage.removeItem(STORAGE_KEY);
};

const mapRowToDraft = (row: any): EventDraft => {
    const base = row.payload || {};
    return {
        ...DEFAULT_INITIAL_DRAFT,
        ...base,
        id: row.id,
    };
};

export const fetchRemoteEvents = async (): Promise<EventDraft[] | null> => {
  if (!supabase) return null;
  
  try {
    const { data, error } = await supabase
      .from('kickflip_events')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) {
        console.error("Supabase Fetch Error:", error.message);
        return null;
    }
    return data.map(mapRowToDraft);
  } catch (e) {
    console.warn("Fetch Exception:", e);
    return null;
  }
};

export const fetchEventById = async (id: string): Promise<EventDraft | null> => {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('kickflip_events')
            .select('*')
            .eq('id', id)
            .maybeSingle(); // Use maybeSingle to avoid errors on 0 rows

        if (error) {
            console.warn(`Supabase Fetch Error for ${id}:`, error.message);
            return null;
        }
        if (!data) {
            console.warn(`Supabase: Event ${id} not found (404).`);
            return null;
        }
        return mapRowToDraft(data);
    } catch (e) {
        console.warn("Fetch Single Exception:", e);
        return null;
    }
};

export const syncEventToRemote = async (event: EventDraft): Promise<{ success: boolean; error?: any }> => {
    if (!supabase) return { success: false, error: 'No backend connection' };

    try {
        // Prepare payload
        const media = event.media || [];
        // Strip Files and huge data if necessary (basic sanity check)
        const sanitizedMedia = media.map(m => {
            // If URL is base64 and > 5MB, we might have issues, but we try anyway.
            // Ideally we'd upload to storage, but for this demo we inline.
            return { ...m, file: undefined };
        });
        
        const safeEvent = { ...event };
        delete (safeEvent as any).file; 

        const payload = { ...safeEvent, media: sanitizedMedia };
        const recordId = String(event.id);

        // Check payload size estimate (rough)
        const payloadString = JSON.stringify(payload);
        if (payloadString.length > 5 * 1024 * 1024) {
            console.warn("Kickflip: Payload is very large (>5MB). Sync might fail.");
        }

        const { error } = await supabase
            .from('kickflip_events')
            .upsert({ 
                id: recordId, 
                title: event.title, 
                category: event.category,
                payload: payload,
                updated_at: new Date().toISOString()
            }, { onConflict: 'id' });

        if (error) {
            console.error("Supabase Sync Error:", error);
            return { success: false, error: error.message };
        }
        
        console.log("Event successfully synced to DB:", event.title, recordId);
        return { success: true };
    } catch (e: any) {
        console.error("Supabase Sync Exception:", e);
        return { success: false, error: e.message || e };
    }
}

export const deleteRemoteEvent = async (id: string) => {
    if (!supabase) return;
    try {
        await supabase.from('kickflip_events').delete().eq('id', id);
    } catch (e) {
         console.error("Supabase Delete Error:", e);
    }
}

export const subscribeToEvents = (
    onInsert: (event: EventDraft) => void,
    onUpdate: (event: EventDraft) => void,
    onDelete: (id: string) => void
) => {
    if (!supabase) return null;
    unsubscribeEvents();

    const channel = supabase
        .channel('kickflip_global_events')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'kickflip_events' },
            (payload) => { if(payload.new) onInsert(mapRowToDraft(payload.new)); }
        )
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'kickflip_events' },
            (payload) => { if(payload.new) onUpdate(mapRowToDraft(payload.new)); }
        )
        .on(
            'postgres_changes',
            { event: 'DELETE', schema: 'public', table: 'kickflip_events' },
            (payload) => { if(payload.old) onDelete(payload.old.id); }
        )
        .subscribe();

    subscription = channel;
    return channel;
};

export const unsubscribeEvents = () => {
    if (subscription && supabase) {
        supabase.removeChannel(subscription);
        subscription = null;
    }
};
