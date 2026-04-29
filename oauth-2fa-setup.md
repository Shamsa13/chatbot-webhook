# OAuth And Phone 2FA Setup

## What I Changed

I added a two-step web login flow:

1. The user signs in with Google, Microsoft, or email and password through Supabase Auth.
2. The user confirms their phone number with an SMS code before the app creates the Director Compass web session.

After the phone code is verified, the app saves the verified email on the existing `users` profile and links the Supabase Auth user to that same profile.

## How Signup Works

OAuth is both sign-in and signup. If someone clicks Google or Microsoft for the first time, Supabase creates the auth account. Then Director Compass asks for the phone code and links that auth account to the phone profile.

Email and password also has a Create Account tab. If email confirmation is enabled in Supabase, the user must confirm the email first, then sign in and complete phone 2FA.

## Forgot Password

The login form has a Forgot password action. Supabase sends the reset email. After the user sets a new password, Director Compass still asks for phone 2FA before letting them into the portal.

## Supabase Setup

Run the updated `security-hardening.sql` migration. It adds:

- `users.auth_user_id`
- `users.auth_provider`
- `users.auth_email_verified_at`
- a unique index on `auth_user_id`

In Supabase Auth:

- Enable Email provider.
- Enable Google provider if I want Google login.
- Enable Azure provider if I want Microsoft login.
- Add my production URL to Site URL and Redirect URLs.

Redirect URL example:

```text
https://compass.boardchair.com
```

## Render Environment Variables

Add this to Render:

```text
SUPABASE_ANON_KEY=your_supabase_anon_key
```

Keep the existing service role key as:

```text
SUPABASE_SECRET_KEY=your_service_role_key
```

## Testing Checklist

- Create an account with email and password.
- Confirm email if Supabase requires it.
- Confirm the phone code.
- Confirm the app opens normally.
- Confirm `users.email` is saved on the profile.
- Confirm `users.auth_user_id` is filled in.
- Sign out and sign in again with the same email.
- Confirm the app sends the SMS code to the linked phone.
- Use Forgot password and confirm the reset flow still asks for phone 2FA.
- Test Google login if the Google provider is enabled.
- Test Microsoft login if the Azure provider is enabled.
