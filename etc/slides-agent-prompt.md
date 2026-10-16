You are helping me build a 4-minute Product Studio crit deck (Cornell Tech). Audience: product people, not engineers. Keep it product-oriented and non-technical: user pain, the experience, why people would trust it, the business, and honest open questions. No cryptography jargon on slides (one plain-language line on "why it's trustworthy" is enough). I own the story and the final wording; draft options for me to choose from, don't decide for me.

## The product (one line)
A life-admin assistant for people moving to a new city. It works through the forms with you, step by step, and proves who you are using the chip already in your passport, without your documents leaving your phone.

## The problem
- Moving to New York means a pile of admin: home internet, utilities, renters insurance, change of address, the DMV, the lease.
- Newcomers without a Social Security number hit the same wall every time: "upload a photo of your passport, take a selfie, wait 1–2 days".
- People don't trust AI agents with this. Background agents act out of sight, and recent incidents (an assistant leaking a user's address on a marketplace) make it worse.

## Our angle (from our mentor, Burke)
- Not a background agent: a visible assistant. You see each step, it pauses for anything only you should do, and nothing happens without your approval.
- Solves an immediate need everyone in a NYC room understands.
- It's a two-sided product: businesses must accept it. Revenue comes from businesses (verification "as a service" instead of their current upload-and-selfie vendor); free for people.
- Be honest: we haven't spoken to government agencies or ISPs yet.

## What exists today (real, demoable)
1. FreeID app (iPhone): scan your passport (the printed code, then tap the chip). The app reads the chip's data and photo, checks it was genuinely issued by the country, does a blink check, and keeps everything on the phone. No upload.
2. The assistant (web): sign in with FreeID, tell it "I'm moving to NYC, what admin do I need to do?", get a checklist, pick "home internet". You approve what it's allowed to do (which site, how many actions, approve each step). It then fills the signup form on screen, step by step, asking you to approve each action, with a full activity log.
3. NYC Fibre (prototype internet provider): a realistic signup with the newcomer's choice — enter an SSN, upload passport + selfie (the old way), or "Verify with FreeID". The FreeID step is simulated in this prototype: the provider shows what it verified (passport chip checked, holder matched, genuine app) and receives only what it needs — name, date of birth, "passport valid", a masked passport number (••••123Z), with "request full number" needing a separate approval on your phone. It states plainly that credit history isn't covered (so a deposit applies).

## Honest status (say it, don't hide it)
- Live: passport scan on the phone; the assistant driving a real website with approvals.
- Prototype: the provider site is a mock, and the FreeID approval step on it is simulated. Real phone-to-provider verification is being built next.
- Not yet: face matching against the passport photo is in development; iPhone only.

## Demo flow to support (≈90 seconds of the 4 minutes)
1. Phone: scan a passport live → details appear on the phone, "nothing uploaded".
2. Assistant: "I'm moving to NYC…" → checklist → "home internet" → approve permissions.
3. Watch it fill NYC Fibre (address, plan, contact) with approvals.
4. Identity step: it chooses "Verify with FreeID" and stops for the human → (simulated) approval → provider shows "Identity verified", masked passport number.
5. Account created; show the activity log.

## Slide outline to draft (5–7 slides)
1. Hook: the newcomer admin wall (a real-feeling NYC moment).
2. The experience: a visible assistant that does it with you (not behind your back).
3. Why you'd trust it: your passport chip, verified on your phone; share only what's needed; you approve every release.
4. Demo.
5. Business: free for people, businesses pay to accept it instead of upload-and-selfie verification; start with ISPs and landlords.
6. What's real vs. prototype, and the open questions (business adoption, agencies we haven't spoken to).
Optional: competitive contrast (background agents vs. ours; KYC vendors vs. ours).

Ask me before inventing statistics, quotes, or market numbers.
