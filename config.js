// SACCI Portal — Supabase connection config.
// The anon key below is meant to be public: Supabase's security model relies
// on Row Level Security (see supabase/schema.sql), not on hiding this key.
//
// Fill these in from your Supabase project: Project Settings → API.
const SUPABASE_URL = 'https://jsyzilcdozqajczpynnp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzeXppbGNkb3pxYWpjenB5bm5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxODcyOTksImV4cCI6MjA5OTc2MzI5OX0.aa0_Lcw4OGhP59k-lor7wLuWCQsqR-H7wRbXGCX7qRo';

// Named `sb`, not `supabase` — the CDN bundle itself declares a top-level
// `supabase` binding, so reusing that name throws a SyntaxError at parse time.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
