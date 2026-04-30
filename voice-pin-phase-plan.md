# Voice PIN Security Phase Plan

## Why I Am Adding This

Right now, the app already has stronger web login with OAuth and phone verification. That helps protect the web portal.

The next risk is voice access. A phone call can still depend too much on caller ID. If someone can spoof a phone number, they may be able to look like a real returning user.

My goal is to add a user-set Voice PIN without making the normal call experience feel broken.

The main rule is simple:

- If no Voice PIN is set, calls work like they do today.
- If a Voice PIN is set, the user can choose how strict voice security should be.
- If caller verification clearly fails, private context is never loaded.

## What The User Will See

After a user signs into the web portal, I will show a dismissible Voice Security banner.

Example banner text:

> Add a Voice PIN to protect private memory and document context on phone calls.

The banner will have two actions:

- Set Up Voice PIN
- Not Now

If the user clicks Set Up Voice PIN, it opens Profile Settings directly to the Voice Security section.

In Profile Settings, the user can:

- Set a 4-digit Voice PIN.
- Change the Voice PIN.
- Remove the Voice PIN.
- Choose their voice security mode.

After the PIN is set, the app sends the user a text message.

Suggested SMS:

> Your Director Compass voice PIN is now set and secured. You can safely call this number anytime. For privacy, I may ask for your PIN before using private account context.

## Voice Security Modes

The user can choose one of three modes.

| Mode | What It Means | Best For |
|---|---|---|
| Smooth | Calls feel like they do today unless caller verification clearly fails. | Users who want the least friction. |
| Risk-based | Normal trusted calls stay smooth, but weaker or missing caller verification asks for the PIN. | Best default balance. |
| High Security | Every call asks for the PIN before private context is used. | Users who want maximum protection. |

My recommended default after a user sets a PIN is Risk-based.

## How Calls Will Work

### If No PIN Is Set

David works the same way he does now.

The call can still use:

- User memory
- Recent history
- Uploaded document context
- Transcript instructions
- Event context

### If PIN Is Set And Mode Is Smooth

David works mostly like today.

The only hard stop is failed caller verification.

If `StirVerstat` says the call failed verification, David keeps the call general and does not load private context.

### If PIN Is Set And Mode Is Risk-based

This is the recommended mode.

David can stay smooth when the call looks trusted.

David asks for the PIN when:

- `StirVerstat` is missing
- `StirVerstat` is B-level
- `StirVerstat` is C-level
- The call looks higher risk

Because I am based in Canada, missing STIR/SHAKEN should not be treated as automatic failure. It should trigger PIN verification instead.

### If PIN Is Set And Mode Is High Security

David asks for the PIN on every call before using private context.

If the PIN is correct, David can use private context.

If the PIN is wrong, David can still help with general board questions, but does not use private memory, documents, or private history.

### If Caller Verification Fails

Failed caller verification always blocks private context.

Even if the caller knows the PIN, David should stay in general mode.

Example wording:

> I can help with general board questions, but I cannot access private account context because this call could not be verified.

## Same-Call PIN Verification

To unlock private context during the same call, I need an ElevenLabs server tool.

The voice agent will ask:

> Before I pull in your private notes and documents, please say your voice PIN.

Then ElevenLabs calls my server with the PIN.

If the PIN is correct, my server returns the private context for that call.

If the PIN is wrong, my server returns general-only status.

The agent should never repeat the PIN back to the user.

## Backend Changes

I will add these fields to the `users` table:

| Field | Purpose |
|---|---|
| `voice_pin_hash` | Stores the hashed PIN. The raw PIN is never stored. |
| `voice_pin_set_at` | Tracks when the PIN was created or changed. |
| `voice_security_mode` | Stores `smooth`, `risk_based`, or `high_security`. |
| `voice_security_prompt_dismissed_at` | Tracks if the web banner was dismissed. |
| `voice_pin_failed_count` | Tracks wrong PIN attempts. |
| `voice_pin_locked_until` | Temporarily locks PIN checks after too many failures. |

I will add these server endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/web/profile` | Returns profile data plus Voice Security status. It never returns the PIN hash. |
| `PUT /api/web/voice-security` | Sets, changes, removes the PIN, updates the mode, or dismisses the banner. |
| `POST /elevenlabs/voice-security/verify-pin` | Lets ElevenLabs verify a PIN during a call. |

The PIN will be hashed with scrypt, similar to the OTP hashing pattern already used in the app.

I will add a Render environment variable:

```text
PIN_HASH_SECRET=long-random-secret
```

I will also add:

```text
VOICE_SECURITY_TOOL_SECRET=long-random-secret
```

That secret protects the ElevenLabs PIN verification endpoint.

## ElevenLabs Setup

I will create a server tool in ElevenLabs.

Tool name:

```text
verify_voice_pin
```

Method:

```text
POST
```

URL:

```text
https://YOUR_RENDER_URL/elevenlabs/voice-security/verify-pin
```

Header:

```text
x-voice-security-secret: VOICE_SECURITY_TOOL_SECRET
```

Request body:

```json
{
  "pin": "{{pin}}",
  "caller_phone": "{{system__caller_id}}",
  "conversation_id": "{{system__conversation_id}}",
  "identity_status": "{{identity_status}}"
}
```

The tool response should be able to update these dynamic variables:

- `memory_summary`
- `recent_history`
- `user_name`
- `upcoming_events`
- `transcript_protocol`
- `voice_pin_verified`

## Agent Instructions

I will update the ElevenLabs agent instructions so David handles PIN checks naturally.

If PIN is needed:

> Before I pull in your private notes and documents, please say your voice PIN.

If the PIN is correct:

> Thank you. I have confirmed it is you. How can I help?

If the PIN is wrong:

> I could not verify that PIN. I can still help with general board questions, but I will not use private account context on this call.

If caller verification failed:

> I can help with general board questions, but I cannot access private account context because this call could not be verified.

## Testing Checklist

### Web Setup

- Login shows the Voice Security banner.
- Clicking Not Now hides the banner.
- Clicking Set Up Voice PIN opens Profile Settings.
- Setting a 4-digit PIN succeeds.
- Changing the PIN succeeds.
- Removing the PIN succeeds.
- The PIN is stored as a hash, not plaintext.
- The SMS confirmation sends after PIN setup or change.

### Voice Calls

- No PIN set: calls work exactly like today.
- Smooth mode: trusted calls load private context.
- Risk-based mode with missing `StirVerstat`: David asks for PIN before private context.
- Risk-based mode with B or C level: David asks for PIN before private context.
- High Security mode: every call asks for PIN.
- Correct PIN unlocks private context during the same call.
- Wrong PIN keeps the call general-only.
- Too many wrong PIN attempts temporarily lock PIN verification.
- Failed caller verification never loads private context.

### Core Feature Regression

- Web chat still works.
- SMS chat still works.
- Uploaded documents still work in web and SMS.
- Deep Dive still works.
- Transcript email flow still works.
- Profile name and email saving still works.
- Last web login and last call still display.

## Rollout Notes

I should roll this out in stages:

1. Add database fields and Render environment variables.
2. Add web profile controls and the banner.
3. Add PIN hashing and SMS confirmation.
4. Add the ElevenLabs server tool endpoint.
5. Configure the ElevenLabs tool and agent instructions.
6. Test with no PIN, Smooth mode, Risk-based mode, High Security mode, and failed caller verification.

The safest first deployment is to let users set and manage the PIN first, while keeping no-PIN users on the existing call experience.

## Sources I Used

- ElevenLabs Server Tools: https://elevenlabs.io/docs/eleven-agents/customization/tools/server-tools/
- ElevenLabs Dynamic Variables: https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables
- Twilio Trusted Calling with SHAKEN/STIR: https://www.twilio.com/docs/voice/trusted-calling-with-shakenstir
- Supabase Auth: https://supabase.com/docs/guides/auth
