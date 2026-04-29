# Voice Spoofing Mitigation Options

## Why I Am Looking At This

Right now, a returning caller can be recognized mostly by phone number. That is useful for a smooth call, but it is not strong identity proof by itself.

If someone can spoof a user phone number, they may be able to make the bot think they are that user. This does not mean a normal person who simply knows the number can do it. It means the risk comes from caller ID spoofing, SIM swap, or some VoIP setups that can fake caller ID.

My goal is to reduce that risk without making normal users feel blocked.

## What STIR/SHAKEN Can And Cannot Do

Twilio can pass a `StirVerstat` value on voice calls when the call has SHAKEN/STIR identity data.

The rough meaning is:

| Level | Meaning | How I Should Treat It |
|---|---|---|
| A | Strongest. The carrier knows the caller and believes they can use that caller ID. | Best case for loading full context. |
| B | The caller is known, but the carrier is not fully saying they have the right to use that caller ID. | Medium trust. Good for some context, maybe not all. |
| C | Weakest. It does not meet A or B. This can include international calls. | Low trust. I should be careful. |
| Missing | No STIR/SHAKEN data was passed. | In Canada, this may happen for normal calls, so blocking all missing values may hurt real users. |
| Failed | Caller ID validation failed. | I should not load private context. |

Because my number and users are Canada based, I should not assume every normal call will be A-level. If I require A-level only, I may block legitimate returning users.

## Option 1: Keep The Current Flow, But Use STIR/SHAKEN Rules

What I would do:

- A-level calls get full memory, document context, and recent history.
- B-level calls get most context, but David avoids private details unless the user asks generally.
- C-level and missing calls get a warning style greeting and limited context.
- Failed calls get no private context.

Example call start for C or missing:

> Hi, I’m your Director Compass. I can help with board questions, but for privacy I’ll keep this call general until I can confirm it’s you.

Pros:

- Low friction.
- No extra PIN or code.
- Easy to understand.
- Good first step.

Cons:

- Does not fully stop a caller who can spoof a number and still comes through as missing or B/C.
- Canada support may be uneven, so trust level may not always tell the full story.

Best use:

- Good as a base layer, but I would not rely on it alone for private memory and document access.

## Option 2: Web Login With OAuth And Phone 2FA Only

What I would do:

- Add proper web login using OAuth, such as Google or Microsoft.
- Add phone 2FA during login.
- Link the verified web account to the user phone number.
- Let users manage their profile, email, phone number, and maybe voice security settings in the web portal.

Pros:

- Stronger web account security.
- Helps stop stolen web sessions and weak OTP workflows.
- Gives users a secure place to set voice preferences.
- Good foundation for account recovery and admin workflows.

Cons:

- It does not fully solve voice spoofing by itself.
- A caller could still spoof the phone number unless the voice call also checks something.

Best use:

- I should do this for web security, but I should pair it with a voice-specific check if I want to protect calls.

## Option 3: User-Set Voice PIN

What I would do:

- In the web portal, the user sets a 4 to 6 digit voice PIN.
- The PIN is stored as a hash, not plaintext.
- When a returning caller wants personal context, David asks for the PIN.
- If the PIN is correct, David loads memory, document context, and recent history.
- If the PIN is wrong or skipped, David still helps generally but does not use private context.

Example call flow:

> Welcome back. Before I pull in your private context, please say your voice PIN.

Pros:

- Strong protection against caller ID spoofing.
- Does not depend on STIR/SHAKEN.
- Works in Canada.
- Simple mental model for users.
- The user can choose and remember it.

Cons:

- Adds friction to returning calls.
- Some users may forget the PIN.
- Speaking a PIN out loud can be awkward if they are not alone.

Best use:

- This is the strongest simple option for voice security.

## Option 4: One-Time Code Sent To Email On Every Call

What I would do:

- When a returning user calls, David sends a one-time code to the user email.
- The caller must say the code during the call.
- The code expires after a short time, such as 5 to 10 minutes.

Pros:

- Stronger than caller ID.
- No long-term PIN to remember.
- If someone only spoofed the phone number, they still need the email inbox.

Cons:

- Slower call start.
- Some users may not have email open.
- The bot may not wait long enough if the user is searching for the code.
- Bad experience if the user is driving or away from a computer.
- Email delivery delays can happen.

How to handle the wait problem:

- David can say: “I sent the code. I can wait while you check.”
- If the user takes too long, David can stay in general mode.
- The user can say: “I have the code now.”
- The code stays valid for a few minutes, so they can call back and continue.

Best use:

- Good for high-risk actions, like transcript sending, changing email, or discussing uploaded documents.
- I would not use this on every normal call unless users accept the extra step.

## Option 5: Risk-Based Voice Access

What I would do:

Use different rules based on `StirVerstat`, account state, and the sensitivity of the request.

Suggested rules:

| Call Trust | What David Can Do |
|---|---|
| A-level | Load full context if the account has no extra risk flags. |
| B-level | Load basic memory, but require PIN before documents, transcripts, or sensitive history. |
| C-level | Start in general mode and require PIN before private context. |
| Missing | Treat like C-level in the U.S., but in Canada maybe allow basic memory and require PIN for documents and transcripts. |
| Failed | No private context. General advice only. |

Pros:

- Better user experience than asking every caller for a PIN.
- Still protects higher-risk calls.
- Lets me be more lenient for Canada without fully trusting caller ID.

Cons:

- More logic to build and test.
- Users need a clear message when context is limited.

Best use:

- This is a good balanced approach.

## Option 6: Full Stack Security Path

What I would do:

- Web login uses OAuth.
- Web login also uses phone 2FA or authenticator app MFA.
- User sets a voice PIN in the web portal.
- Voice calls use STIR/SHAKEN as a risk signal.
- A-level calls can be smoother.
- B, C, missing, or risky calls require PIN before private context.
- Failed caller verification never gets private context.

Pros:

- Best overall protection.
- Web account and voice account support each other.
- Users can manage the PIN securely.
- Works better for Canada than A-level-only blocking.

Cons:

- More work.
- More testing.
- Some added friction.

Best use:

- This is the path I would pick if I want strong security without breaking the main experience.

## My Recommended Plan

I would not rely on STIR/SHAKEN alone.

My best path is:

1. Add OAuth login and 2FA to the web portal.
2. Add a user-set voice PIN in the web portal.
3. Use `StirVerstat` as a risk signal, not as the only lock.
4. Let A-level calls feel smooth when possible.
5. Require PIN for B, C, missing, and any call asking for documents, transcripts, or private memory.
6. Always block private context on failed caller verification.

This gives me a good balance:

- Normal users still get a good call experience.
- Canadian calls are not unfairly blocked just because STIR/SHAKEN data is missing.
- A spoofed phone number alone is not enough to access private context.

## User-Facing Wording

If context is limited:

> Hi, I’m your Director Compass. For privacy, I’ll keep this call general until I confirm it’s you.

If PIN is needed:

> Before I pull in your private notes and documents, please say your voice PIN.

If PIN fails:

> I couldn’t verify that PIN. I can still help with general board questions, but I won’t use private account context on this call.

If STIR/SHAKEN failed:

> I can help with general board questions, but I can’t access private account context because this call could not be verified.

## Testing Checklist

- Call with a normal known number and confirm David can greet the user normally.
- Simulate missing `StirVerstat` and confirm the Canada-friendly behavior works.
- Simulate `TN-Validation-Passed-A` and confirm full context behavior.
- Simulate `TN-Validation-Passed-B` and confirm PIN is required before private context.
- Simulate `TN-Validation-Passed-C` and confirm PIN is required before private context.
- Simulate `TN-Validation-Failed-*` and confirm no private context is sent.
- Enter the correct PIN and confirm memory and documents load.
- Enter the wrong PIN and confirm David stays in general mode.
- Confirm PIN is stored hashed, not plaintext.
- Confirm the web portal lets the user reset the PIN after OAuth and 2FA.

## Sources I Used

- Twilio, Trusted Calling with SHAKEN/STIR: https://www.twilio.com/docs/voice/trusted-calling-with-shakenstir
- Twilio Verify docs: https://www.twilio.com/docs/verify
- Twilio Verify SMS docs: https://www.twilio.com/docs/verify/sms
- Supabase Auth docs: https://supabase.com/docs/guides/auth
- Supabase MFA TOTP docs: https://supabase.com/docs/guides/auth/auth-mfa/totp
