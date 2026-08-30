/* ---------------------------------------------------------------------------
   Checkmark configuration.

   These values are safe to publish. The publishable key is a *public* key by
   design — every table is locked down by row-level security plus an email
   allow-list, so holding this key alone gets you nothing. The keys that must
   never appear here are the ones labelled "secret" / "service_role".

   Supabase project: checkmark  (twfwkcmwvwdnbavrsang, ca-central-1)
   Account: personal (AriaNova613) -> org "AriaNova"
   Find these under Supabase -> Project Settings -> API Keys.
   --------------------------------------------------------------------------- */
window.CHECKMARK_CONFIG = {
  SUPABASE_URL: 'https://twfwkcmwvwdnbavrsang.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_sI1OBe9cepL5kQfr3bJtAA_PQYIrbIs',

  // Flip to true only after the Google provider is configured in Supabase
  // (Authentication -> Providers -> Google). Until then the email sign-in link
  // is the way in, and the Google button stays hidden.
  // See docs/SETUP.md -> "Nicer sign-in".
  GOOGLE_ENABLED: false,
};
