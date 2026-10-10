export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export function arenaApiUrl(action: string): string {
  return `${supabaseUrl}/functions/v1/arena-api?action=${action}`;
}

export function edgeUrl(fn: string): string {
  return `${supabaseUrl}/functions/v1/${fn}`;
}

export function edgeHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${supabaseAnonKey}`,
    'Content-Type': 'application/json',
  };
}
