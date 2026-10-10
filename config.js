// Public settings for the browser. The anon key is meant to be public:
// what each person can read or change is controlled by row-level security
// and login-token checks in supabase/002_parliament.sql, not by hiding this key.
window.PARL_CONFIG = {
  SUPABASE_URL: "https://wmfcpcugyvwhvyfztnwp.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtZmNwY3VneXZ3aHZ5Znp0bndwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5MjcwMTEsImV4cCI6MjEwNjUwMzAxMX0.XCfQj9U-IFhltEWIVDMWXo8Qe4BJgcBk_Sv0rJKXMAw"
};
