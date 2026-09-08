/* ---------------------------------------------------------------------------
   Carr Athletics configuration.

   Everything here is safe to publish. The publishable key is a *public* key by
   design: every table is protected by row-level security plus an email
   allow-list, so holding this key on its own gets you nothing at all. The keys
   that must never appear in this file are the ones labelled "secret" or
   "service_role" — tools/deploy.mjs refuses to publish if one turns up.

   Supabase project: checkmark  (twfwkcmwvwdnbavrsang, ca-central-1)
   Account: personal (AriaNova613) -> org "AriaNova"
   Find these under Supabase -> Project Settings -> API Keys.
   --------------------------------------------------------------------------- */
window.CHECKMARK_CONFIG = {
  SUPABASE_URL: 'https://twfwkcmwvwdnbavrsang.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_sI1OBe9cepL5kQfr3bJtAA_PQYIrbIs',

  /* Flip to true only after the Google provider is configured in Supabase
     (Authentication -> Providers -> Google). Until then the sign-in email is
     the way in and the Google button stays hidden.
     See docs/SETUP.md -> "One-tap sign-in with Google". */
  GOOGLE_ENABLED: false,

  /* Does the sign-in email actually contain a six-digit code?

     Magic link and email OTP are the same request in Supabase — they differ
     only in what the email says. The default template shows a link and nothing
     else, so promising a code before the template has {{ .Token }} in it would
     send somebody hunting through an email for a number that is not there.

     Flip this to true at the same time as adding {{ .Token }} to the template,
     which needs custom SMTP first. See docs/SETUP.md -> "Better email".

     This matters most on an iPhone: an installed home-screen app has storage
     separate from Safari and cannot receive a link at all, so until this is
     true, an iPhone has to be signed in from Safari — or the sign-in link
     pasted into the app by hand, which the app offers as a fallback. */
  EMAIL_HAS_CODE: false,
};
