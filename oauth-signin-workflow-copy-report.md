# OAuth Sign In And Account Creation Copy Report

## Why I Made This

This document is a copy review worksheet for the web sign in, create account, OAuth, phone verification, forgot password, email confirmation, and reset password flow.

Each section has:

1. A screenshot placeholder.
2. A short note about when the user sees that screen.
3. Text boxes for every visible user-facing line.

The goal is to let me and my team freely rewrite the wording without searching through the code.

## 1. Main Sign In Screen

### Screenshot Placeholder

```text
[Add screenshot: Main Sign In screen]
```

### When The User Sees This

The user sees this when they first open the web portal and are not logged in.

### Text Boxes

Title:

```text
Director Compass
```

Subtitle:

```text
Powered by David Beatty C.M., O.B.E., F.ICD, CFA
```

Sign in heading:

```text
Sign In
```

Sign in subheading:

```text
Access your always available board advisor.
```

Left tab:

```text
Sign In
```

Right tab:

```text
Create Account
```

Google button:

```text
Continue with Google
```

Divider:

```text
or
```

Email label:

```text
Email Address
```

Email placeholder:

```text
you@example.com
```

Password label:

```text
Password
```

Password placeholder:

```text
Your password
```

Primary button:

```text
Sign In
```

Forgot password link:

```text
Forgot password?
```

Terms checkbox:

```text
I have read and agree to the Disclaimer & Terms.
```

Terms link text:

```text
Disclaimer & Terms
```

Terms link URL:

```text
https://www.boardchair.com/director-compass-ai-disclaimer
```

## 2. Create Account Screen

### Screenshot Placeholder

```text
[Add screenshot: Create Account tab]
```

### When The User Sees This

The user sees this after selecting the Create Account tab.

### Text Boxes

Title:

```text
Director Compass
```

Subtitle:

```text
Powered by David Beatty C.M., O.B.E., F.ICD, CFA
```

Create account heading:

```text
Sign Up
```

Create account subheading:

```text
Create your always available board advisor account.
```

Left tab:

```text
Sign In
```

Right tab:

```text
Create Account
```

Google button:

```text
Continue with Google
```

Divider:

```text
or
```

Full name label:

```text
Full Name
```

Full name placeholder:

```text
Jane Doe
```

Email label:

```text
Email Address
```

Email placeholder:

```text
you@example.com
```

Password label:

```text
Password
```

Password placeholder:

```text
Your password
```

Primary button:

```text
Create Account
```

Primary button loading state:

```text
Creating...
```

Forgot password link:

```text
Forgot password?
```

Terms checkbox:

```text
I have read and agree to the Disclaimer & Terms.
```

## 3. OAuth Redirect Screen

### Screenshot Placeholder

```text
[Add screenshot: Google OAuth screen]
```

### When The User Sees This

The user sees this after clicking Continue with Google. This screen is controlled by Google and Supabase, not the local app.

### Text Boxes

App button that starts this flow:

```text
Continue with Google
```

Possible browser/provider page:

```text
Sign in with Google
```

Team notes:

```text
The exact Google screen text is controlled outside the app. Review screenshots after production OAuth is configured.
```

## 4. Email Confirmation Required Popup

### Screenshot Placeholder

```text
[Add screenshot: Check Your Email popup after account creation]
```

### When The User Sees This

The user sees this when they create an account and Supabase requires them to confirm their email before signing in.

### Text Boxes

Popup title:

```text
Check Your Email
```

Popup message:

```text
Confirm your email, then come back and sign in.
```

Popup button:

```text
OK
```

## 5. Confirm Email Email

### Screenshot Placeholder

```text
[Add screenshot: Confirm email message in the user's inbox]
```

### When The User Sees This

The user receives this email after creating an account if Supabase email confirmation is enabled.

### Text Boxes

Sender name:

```text
David Beatty
```

Sender email:

```text
davidbeatty@boardchair.ca
```

Subject:

```text
Confirm your Director Compass email
```

Email brand title:

```text
Director Compass
```

Email brand subtitle:

```text
Powered by David Beatty
```

Email heading:

```text
Confirm your email
```

Email body:

```text
Please confirm this email address to finish setting up your Director Compass account.
```

Email button:

```text
Confirm Email
```

Email footer:

```text
If you did not create this account, you can safely ignore this email.
```

Required Supabase link variable:

```text
{{ .ConfirmationURL }}
```

Team notes:

```text
Keep {{ .ConfirmationURL }} attached to the Confirm Email button.
```

## 6. Phone Verification Screen Before Code Is Sent

### Screenshot Placeholder

```text
[Add screenshot: Verify Phone screen before SMS code is sent]
```

### When The User Sees This

The user sees this after OAuth or email/password login succeeds and before entering the web portal.

### Text Boxes

Heading:

```text
Verify Phone
```

Subheading:

```text
Use your phone number to protect your account.
```

Intro text:

```text
Confirm your phone number to finish signing in.
```

Phone field label:

```text
Phone Number
```

Phone code button:

```text
Send Phone Code
```

Button loading state:

```text
Sending...
```

Terms checkbox if needed:

```text
I have read and agree to the Disclaimer & Terms.
```

## 7. Phone Verification Screen After Code Is Sent

### Screenshot Placeholder

```text
[Add screenshot: Verify Phone screen after SMS code field appears]
```

### When The User Sees This

The user sees this after clicking Send Phone Code.

### Text Boxes

Heading:

```text
Verify Phone
```

Subheading:

```text
Use your phone number to protect your account.
```

Code field label:

```text
Enter 6-Digit Code
```

Code field placeholder:

```text
123456
```

Enter portal button:

```text
Enter Portal
```

Enter portal loading state:

```text
Verifying...
```

Back link:

```text
Back to sign in
```

## 8. Linked Phone Verification Screen

### Screenshot Placeholder

```text
[Add screenshot: Verify Phone screen for an already linked account]
```

### When The User Sees This

The user sees this if their OAuth/email login is already linked to a phone number. The phone field is hidden and the app sends the code to the existing phone.

### Text Boxes

Heading:

```text
Verify Phone
```

Subheading:

```text
Use your phone number to protect your account.
```

Intro text:

```text
For your security, enter the code sent to {maskedPhone}.
```

Send button:

```text
Send Code
```

Code field label:

```text
Enter 6-Digit Code
```

Enter portal button:

```text
Enter Portal
```

Back link:

```text
Back to sign in
```

## 9. Phone Login Code SMS

### Screenshot Placeholder

```text
[Add screenshot: SMS code received on phone]
```

### When The User Sees This

The user receives this SMS after requesting the phone verification code.

### Text Boxes

SMS body:

```text
{code} is your Director Compass web login code. It expires in 10 minutes. Only enter this at compass.boardchair.com.
```

Example SMS:

```text
394135 is your Director Compass web login code. It expires in 10 minutes. Only enter this at compass.boardchair.com.
```

## 10. Forgot Password Start

### Screenshot Placeholder

```text
[Add screenshot: Sign In screen with Forgot password link]
```

### When The User Sees This

The user starts this flow from the Sign In screen by typing their email and clicking Forgot password.

### Text Boxes

Forgot password link:

```text
Forgot password?
```

Email required popup title:

```text
Email Required
```

Email required popup message:

```text
Enter your email address first.
```

Email required popup button:

```text
OK
```

## 11. Forgot Password Email Sent Popup

### Screenshot Placeholder

```text
[Add screenshot: Check Your Email popup after reset request]
```

### When The User Sees This

The user sees this after requesting a password reset email.

### Text Boxes

Popup title:

```text
Check Your Email
```

Popup message:

```text
Use the reset link we sent to create a new password.
```

Popup button:

```text
OK
```

## 12. Reset Password Email

### Screenshot Placeholder

```text
[Add screenshot: Reset password email in the user's inbox]
```

### When The User Sees This

The user receives this email after requesting a password reset.

### Text Boxes

Sender name:

```text
David Beatty
```

Sender email:

```text
davidbeatty@boardchair.ca
```

Subject:

```text
Reset your Director Compass password
```

Email brand title:

```text
Director Compass
```

Email brand subtitle:

```text
Powered by David Beatty
```

Email heading:

```text
Reset your password
```

Email body:

```text
We received a request to reset the password for your Director Compass account.
```

Email button:

```text
Reset Password
```

Email footer line 1:

```text
This link is time-sensitive. If you did not request a password reset, you can safely ignore this email.
```

Email footer line 2:

```text
For security, never share this email or reset link with anyone.
```

Required Supabase link variable:

```text
{{ .ConfirmationURL }}
```

Team notes:

```text
Keep {{ .ConfirmationURL }} attached to the Reset Password button.
```

## 13. Reset Password Screen

### Screenshot Placeholder

```text
[Add screenshot: New Password and Confirm Password screen]
```

### When The User Sees This

The user sees this after clicking the reset password email link.

### Text Boxes

New password label:

```text
New Password
```

New password placeholder:

```text
New password
```

Confirm password label:

```text
Confirm Password
```

Confirm password placeholder:

```text
Confirm password
```

Button:

```text
Update Password
```

## 14. Password Updated Popup

### Screenshot Placeholder

```text
[Add screenshot: Password Updated popup]
```

### When The User Sees This

The user sees this after successfully setting a new password.

### Text Boxes

Popup title:

```text
Password Updated
```

Popup message:

```text
Now confirm your phone number to enter the portal.
```

Popup button:

```text
OK
```

## 15. Common Popup And Error Text

### Screenshot Placeholder

```text
[Add screenshot: Example popup style]
```

### Text Boxes

Login unavailable title:

```text
Login Unavailable
```

Login unavailable message:

```text
Authentication is still loading. Please try again.
```

Terms required title:

```text
Required
```

Terms required message:

```text
You must agree to the Disclaimer & Terms before logging in.
```

Phone step terms required title:

```text
Required
```

Phone step terms required message:

```text
Check the Disclaimer & Terms box before requesting your phone code.
```

Missing info title:

```text
Missing Info
```

Missing info message:

```text
Enter your email and password.
```

Password title:

```text
Password
```

Password too short message:

```text
Use at least 8 characters.
```

Password mismatch message:

```text
Passwords do not match.
```

Login error title:

```text
Login Error
```

Login error fallback message:

```text
Could not sign in.
```

Invalid phone title:

```text
Invalid Number
```

Invalid phone message:

```text
Please enter a valid phone number.
```

Code error title:

```text
Code Error
```

Verification error title:

```text
Verification Error
```

Reset error title:

```text
Reset Error
```

## 16. Server Error Text From Phone Verification

### Screenshot Placeholder

```text
[Add screenshot: Example phone verification error popup]
```

### Text Boxes

Phone missing:

```text
Phone number is required
```

Unsupported country code:

```text
This phone country code is not supported for SMS verification.
```

Too many code requests:

```text
Too many code requests for this number. Please try again in 1 hour.
```

Global SMS cap hit:

```text
Service temporarily unavailable. Please try again later.
```

Phone already linked:

```text
This phone number is already linked to a different login.
```

Missing security code:

```text
Security code is required.
```

No active code:

```text
No active code. Please request a new one.
```

User not found:

```text
User not found.
```

Wrong code:

```text
Invalid code. {attemptsRemaining} attempts remaining.
```

Too many failed attempts:

```text
Too many failed attempts. Please request a new code.
```

Temporary lockout:

```text
Too many failed attempts. Account locked for {minutesLeft} more minutes.
```

Expired code:

```text
Code expired. Please request a new one.
```

## 17. Workflow Summary

### Sign In With Google

1. User checks Disclaimer and Terms.
2. User clicks `Continue with Google`.
3. Supabase handles Google login.
4. User returns to the app.
5. App asks for phone verification.
6. User receives SMS code.
7. User enters code.
8. User enters the portal.

### Create Account With Email And Password

1. User switches to `Create Account`.
2. Heading changes to `Sign Up`.
3. User enters full name, email, and password.
4. User checks Disclaimer and Terms.
5. User clicks `Create Account`.
6. If Supabase requires email confirmation, user sees `Check Your Email`.
7. User confirms email from Supabase email.
8. User signs in and completes phone verification.

### Sign In With Email And Password

1. User stays on `Sign In`.
2. User enters email and password.
3. User checks Disclaimer and Terms.
4. User clicks `Sign In`.
5. User completes phone verification.
6. User enters the portal.

### Forgot Password

1. User enters email.
2. User clicks `Forgot password?`.
3. Supabase sends reset password email.
4. User clicks reset link.
5. User enters new password and confirmation.
6. App asks for phone verification.
7. User enters the portal.

## 18. Editing Notes

When changing copy, I should keep these things clear:

- The user must know they need to accept the Disclaimer and Terms before continuing.
- The phone code is for web login only.
- The user should not enter the SMS code anywhere except the real Director Compass site.
- Email confirmation and password reset emails must keep `{{ .ConfirmationURL }}`.
- The phone verification step should feel like account protection, not a second account creation step.
