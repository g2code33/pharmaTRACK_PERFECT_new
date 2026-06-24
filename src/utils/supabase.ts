import { createClient } from '@supabase/supabase-js';

// Forcefully use your real Supabase URL as the fallback!
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://ltpwedxcvbejiywmwrwc.supabase.co";

// REPLACE THE TEXT BELOW WITH YOUR ACTUAL SUPABASE ANON KEY!
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_VYF1gRvyI3EMCfon1hHK4A_vbWgPknx";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);