# Project Design System

> This document is the visual source of truth for the entire application.

The system below was implemented in `frontend/src/styles/tokens.css` (tokens) and
`frontend/src/components/ui/` (components). Any UI change must use these tokens and
components; new patterns must be documented here first.

---

# 1. Design Philosophy

## Product Character

* Modern, premium, calm
* Minimal but not boring — "AI workspace", not a dashboard
* Persian-first with excellent mixed RTL/LTR handling
* One recognizable identity: the **Hooshyar spark mark** + a single indigo accent

## Core Principle

> Strong visual identity without sacrificing usability. The UI should feel like a
> commercial AI SaaS product, not a generated template.

---

# 2. Design Tokens

Implemented in `frontend/src/styles/tokens.css` as CSS custom properties.
Semantic tokens are theme-scoped; structure tokens (spacing, radius, motion, z-index)
are theme-independent.

## 2.1 Colors

### Brand

| Token | Light | Dark |
|---|---|---|
| `--accent` | `#4f46e5` | `#5b54ec` |
| `--accent-hover` | `#4338ca` | `#6d66f0` |
| `--accent-active` | `#3730a3` | `#4f46e5` |
| `--accent-text` (links/labels) | `#4f46e5` | `#918bf5` |
| `--accent-soft` (tinted surface) | `#eceafd` | `#26244d` |
| `--accent-soft-border` | `#d8d4fa` | `#3b3768` |
| `--on-accent` | `#ffffff` | `#ffffff` |

### Background & Surfaces

| Token | Light | Dark |
|---|---|---|
| `--bg` (app background) | `#f7f7f4` warm off-white | `#101216` cool near-black |
| `--surface` (panels, cards) | `#ffffff` | `#17191f` |
| `--surface-2` (hover) | `#f1f0ec` | `#1e2128` |
| `--surface-3` (strong hover/pressed) | `#e9e8e3` | `#262a32` |
| `--surface-inset` (code, wells) | `#f4f3f0` | `#14161b` |

### Text

| Token | Light | Dark |
|---|---|---|
| `--text-1` | `#1a1d23` | `#ececf1` |
| `--text-2` | `#5c6370` | `#9ba1ad` |
| `--text-3` | `#878e9b` | `#71778a` |
| `--text-disabled` | `#b3b8c2` | `#4d5261` |
| `--text-on-accent-soft` | `#3d37a8` | `#b6b2f8` |

### Border

| Token | Light | Dark |
|---|---|---|
| `--border` | `#e4e3de` | `#2a2e37` |
| `--border-subtle` | `#edecE8` | `#21242b` |
| `--border-strong` | `#cfcec8` | `#3a3f4b` |

### Semantic

| Token | Light | Dark |
|---|---|---|
| `--success` / `--success-soft` | `#067a55` / `#e2f5ee` | `#34c48c` / `#142b22` |
| `--warning` / `--warning-soft` | `#955205` / `#fbf0d9` | `#e0a33e` / `#2e2410` |
| `--danger` / `--danger-soft` | `#d3232f` / `#fdebec` | `#f0646f` / `#33191d` |
| `--info` / `--info-soft` | `#0e6d95` / `#e3f2f9` | `#58b6dc` / `#122733` |

### Dark Mode Rule

Dark mode is intentionally designed, not inverted: warm-dark surfaces, the same indigo
brand hue (fills stay saturated, text-level accent lightens for contrast), and
theme-specific soft tints. Both themes ship together; never change one without the other.

## 2.2 Structure Tokens

* **Spacing**: 4px scale — use multiples (0.25/0.5/0.75/1/1.5/2rem ≈ 4/8/12/16/24/32px).
* **Radius**: `--radius-xs` 6 · `--radius-sm` 8 · `--radius-md` 12 · `--radius-lg` 16 ·
  `--radius-xl` 22 (composer) · `--radius-full` 999 (pills).
* **Shadows**: `--shadow-1..3`, `--shadow-overlay` — used sparingly; hierarchy comes
  primarily from surface lightening + borders (dark mode), shadows only for floating
  elements (dropdowns, modals, toasts).
* **Motion**: fast 130ms (hover/focus), normal 200ms (enter/leave), slow 320ms (drawer);
  easing `--ease-out` (cubic-bezier(0.22, 1, 0.36, 1)). All motion respects
  `prefers-reduced-motion`.
* **Z-index scale**: dropdown 30 · drawer-overlay 40 · drawer 45 · modal 50 · toast 60.

---

# 3. Typography

## Font Family

```text
Primary: Vazirmatn (self-hosted via @fontsource/vazirmatn, 400/500/600/700)
Latin companion: Inter (@fontsource/inter) — emails, model ids, technical fragments
Monospace: ui-monospace / Cascadia Code / Consolas — code, `.mono` + `.ltr` classes
```

## Scale

```text
Display:  1.7rem / 700      (empty-chat welcome)
H1:       1.25rem / 600     (auth form titles)
H2:       1.1rem / 600      (page titles)
Body:     0.9375rem / 400   (app base, line-height 1.8 for Persian)
Body Small: 0.85rem / 400   (composer text, table cells)
Caption:  0.72rem / 400     (timestamps, meta)
```

## Rules

* Persian text uses the app default (RTL); technical fragments get `.ltr` + optional
  `.mono` so mixed content never breaks layout.
* Weights: 400 body, 500 labels/buttons, 600 headings, 700 display.
* Message markdown is rendered with `markdown-it` (html:false — no raw HTML injection);
  code blocks are forced LTR.

---

# 4–8. Spacing · Radius · Borders · Elevation · Motion

See token values in §2.2 — they are the binding list. Use the closest token; never
introduce arbitrary values.

---

# 9. Layout

## Application Shell

```text
Header height:      3.6rem (chat header, glassy translucent)
Sidebar width:      var(--sidebar-width) = 288px
Sidebar collapsed:  var(--sidebar-collapsed-width) = 56px (rail with toggle)
Chat measure:       var(--chat-measure) = 46rem (message column)
Admin content max:  62rem
Page padding:       1.5rem desktop / 0.9rem mobile
```

## Grid

Chat is a three-part workspace: sidebar (navigation) + main chat column. The admin page
is a single centered column. No permanent right-side context panel in the MVP.

## Alignment

Right-aligned (RTL) content edges; message column centered within the chat area.

---

# 10. Breakpoints

```text
Mobile:   < 640px   (single column, composer compact)
Tablet:   640–1023px (sidebar becomes drawer, admin table becomes cards)
Laptop:   1024px+   (persistent sidebar)
Desktop:  1440px+   (same as laptop; content capped by measure tokens)
```

---

# 11. Core Components

All in `frontend/src/components/ui/` (theme-independent) plus feature components.

## Buttons — `AppButton.vue`

Variants: `primary` (accent fill) · `secondary` (surface + border) · `ghost` ·
`danger` (outline red). Sizes `md` (2.5rem) / `sm` (2rem). States: hover, active,
disabled (0.55 opacity), loading (inline spinner + `aria-busy`, button disabled).
One primary action per screen; everything else secondary/ghost.

## Inputs — `AppInput.vue`

Label (visible, always) + optional `hint`/`error` + password reveal toggle.
Focus: accent border + 3px `--accent-soft` ring. Error: red border + `role="alert"`
message under the field. `dir` prop for LTR fields (email, keys, ids).

## Avatar — `AppAvatar.vue`

Initial letter on `--accent-soft` circle. Used for users (email initial) and AI models
(model name initial).

## Modal — `AppModal.vue`

Teleported overlay; sizes `sm` (26rem) / `md` (34rem). Esc closes, overlay click closes,
focus moves into panel and returns on unmount. Used for model form + destructive confirm.

## Toast — `useToast.ts` + `ToastHost.vue`

`aria-live="polite"`, bottom-center, auto-dismiss (4s; errors 6s), kinds
success/error/info with icons. Non-blocking feedback for admin actions and stream errors.

## Skeleton — `AppSkeleton.vue`

Shimmering placeholder lines; used for conversation list, message history, admin table.

## EmptyState / ErrorState

Centered icon + title + description + optional retry action. `ErrorState` has an
`offline` icon variant for network failures.

## ThemeToggle — `ThemeToggle.vue`

3-way segmented radio: روشن / سیستم / تاریک. Persists to localStorage (`hooshyar.theme`),
resolves `system` via `prefers-color-scheme`, applied pre-paint by an inline script in
`index.html` (no FOUC).

## BrandMark — `BrandMark.vue`

The spark mark: accent rounded square + white four-point spark + small satellite dot.
Used in sidebar, chat header (mobile), auth brand panel, empty chat, admin header.

## Feature components

* `layout/AppSidebar.vue` — brand, new-conversation, search, date-grouped conversation
  list (امروز/دیروز/۷ روز گذشته/قدیمی‌تر), profile menu (theme, admin link, logout).
  Drawer under 1024px with overlay; Esc/click-outside closes.
* `chat/ChatHeader.vue` — conversation title, model selector (compact), mobile menu button.
* `chat/ModelSelector.vue` — pill trigger + listbox dropdown (mark, name, default badge,
  provider, check). Opens up (composer) or down (header). Active models only.
* `chat/EmptyChat.vue` — brand mark, «سلام، آماده‌ای؟», supporting copy, 4 interactive
  prompt cards that send immediately.
* `chat/MessageItem.vue` — user: soft accent block, `dir="auto"`. Assistant: workspace
  content with model avatar/name/time meta, markdown body, streaming caret, copy action.
  Status variants:
    * `completed` — full markdown body, copy action.
    * `streaming` — progressive markdown + caret, no copy.
    * `pending` (server has the row, no deltas yet on this tab) — muted in-progress
      text + animated dots, `aria-live="polite"`.
    * `interrupted` (client bailed out, partial content kept) — italic muted text +
      primary-accent **تلاش مجدد** button as the first action.
    * `failed` (provider / network failure) — red surface + `errorMessage` (server-side
      detail never leaked) + primary-accent **تلاش مجدد** button.
  Retry is disabled while another send is in flight. No heavy bubbles.
* `chat/MessageComposer.vue` — rounded composer (radius-xl, focus ring), autosizing
  textarea (Enter=send, Shift+Enter=newline), model selector, send/stop, char counter near
  the 4000 limit, streaming status line. The attachment button is live and multi-select: it
  rejects unsupported/oversized files locally before upload, and accepts new files even while
  an earlier upload runs. Send is disabled only during an upload — the user keeps typing, and
  a processing file never blocks the message.
* File row (inside `MessageComposer.vue`) — the files being written into the message render
  **inside the composer box**, in a wrapping row above the text row, separated by a hairline
  (`--border-subtle`): the box grows to hold them instead of the chips living in a second
  surface. No title, count, badge or explanatory copy — not even an upload notice: the spinner on
  each chip is the progress, and the disabled Send button explains itself through its title and
  `aria-label`. Typing stays possible while a transfer runs; only sending waits.
* `chat/FileChip.vue` — one file, deliberately small (~125 px) so four to five share one row:
  thumbnail (`--radius-xs`, 1.3rem, `object-fit: cover`) for images, otherwise a compact kind
  icon (document / sheet / image, inline SVG, 11px), an ellipsized name capped at 4.2rem, and an
  **icon-only** status affordance — pulsing spinner while uploading/processing, check when ready,
  cross on failure. No status *words* are rendered: the tooltip (`name — size — status`, plus the
  safe failure reason) and the accessible name carry them, which is what lets several chips fit
  on a line. `flex: 0 0 auto` means chips wrap at their natural width instead of being crushed in
  a narrow panel. Tone follows the semantic palette (`--info-soft` while working,
  `--success-soft` when ready, `--danger-soft` on failure) and matches the admin status pills.
  `role="status"`; a `READY` chip becomes a button that opens the viewer; a removable chip
  carries its own × (aria-label «حذف فایل …») without shifting the layout.
* `chat/FileViewerModal.vue` — full-screen preview sheet: overlay at `--z-modal` with a 10px
  `backdrop-filter: blur` so the conversation stays visible but out of focus; panel
  `min(62rem, 100%)`. Header = kind badge + filename + size + a danger-tinted × close;
  body = the image (`object-fit: contain`) or an embedded PDF page (white page regardless of
  theme), or a short explanation for non-renderable types; footer = primary «دانلود فایل» plus a
  ghost «بستن». Esc, click-outside and both buttons close it; body scroll is locked while open
  and focus returns to the chip afterwards.
* `admin/ModelTable.vue` — dense table ≥768px, stacked cards below. Inactive rows dimmed,
  default model marked and protected from destructive actions. Free access is a pill
  toggle (`role="switch"`, info/warning palette) in its own «دسترسی» column.
* `admin/ModelStatus.vue` — default (spark) + active/inactive badge pair + Free/Premium
  badge (info `--info` / warning `--warning` soft tints).
* `admin/ModelForm.vue` — modal form: provider radio cards (mock / OpenAI-compatible),
  an `isFree` switch (label + explanatory line + knob, `role="switch"`),
  validation, API key note.
* `admin/FileTable.vue` — upload-processing table: name (+kind icon), owner email,
  conversation title, type, size, `FileChip` status, created-at, safe error text, and a
  Reprocess action on `READY`/`FAILED` rows. Dense table ≥768px, stacked cards below.

---

# 12. Navigation

Sidebar is the primary navigation and behaves identically across pages: on the chat it
lists conversations; the profile menu contains theme/admin/logout. Admin pages keep a
visible «بازگشت به چت» action. Mobile keeps navigation reachable via the header menu
button (drawer) — navigation is never hidden entirely.

**Collapsible sidebar (desktop ≥1024px)**: the panel-top toggle in the sidebar header
collapses it to a 56px rail (width transition, 200ms ease-out; hidden content fades out
via opacity + visibility, which also removes it from tab order and the accessibility
tree). `aria-expanded` on the toggle reflects the state; the aside carries the stable
`id="chat-sidebar"` referenced by `aria-controls`. State persists in localStorage
(`hooshyar.sidebar-collapsed`, strict-parse so invalid values fall back to expanded).
Collapse does not apply below 1024px — there the sidebar is an overlay drawer and keeps
its own open/close controls. In RTL the panel icon is mirrored (`scaleX(-1)`) so its
divider hugs the sidebar edge.

---

# 13. Page Patterns

## Authentication (Login/Register)

Split layout: brand panel (mark, headline, tagline, feature list, dot pattern) +
form area. Mobile <900px: compact brand header + single column. States: field
validation (on-blur/submit), submit loading, error banner (`role="alert"`), switch link.

## Chat

Header (title + model) → message column (empty state / skeleton / messages) → composer.
Loading: skeletons; empty: EmptyChat; streaming: placeholder message with caret + status
line + stop button; errors: toast + per-message error note; **interrupted / failed rows
surface a primary-accent Retry button (the first action) which re-sends the preceding
user prompt with the same `clientMessageId` so the backend treats it as a replay**.

An **offline banner** slides in under the chat header (200ms ease-out) when
`navigator.onLine` flips false. It carries a pulsing red dot, is `role="status"`
`aria-live="polite"`, and disappears the instant connectivity returns. The banner
is a UI HINT — it never blocks sending (a request will still surface its own error).

**Attachments** live inside the composer box (see the file row above). The upload starts the
moment files are picked, so the chip's spinner reflects a real request, and the chip only turns
into a success tint when the backend says `READY` — the UI never optimistically claims success.
While any chip is non-terminal the view polls the file status endpoint; after a reload the chips
and their statuses are rebuilt from the conversation's file list (never from memory). A failed
chip keeps a red tone and its reason, and sending with a non-ready chip is refused with a clear
toast rather than a silently empty answer. Chips on sent messages are clickable once `READY`
and open the viewer; they always read right-to-left with the bubble (`dir="rtl"` is explicit
because a Latin filename under `dir="auto"` would otherwise flip their order and edge).

The **last-opened conversation** persists across reloads (`localStorage`
`hooshyar.active-conversation`, UUID-validated). Foreign / deleted ids are
silently cleared.

## Admin List

Toolbar (count + primary «افزودن مدل») → table/cards. Loading skeleton; load failure:
retry ErrorState; destructive actions confirmed in modal; outcome via toast. Switch
controls (free access) toggle inline via `PATCH` and re-fetch; backend refusals (e.g.
un-freeing the default model) surface as error toasts.

## Admin Files

Same shell as Admin List. A status filter (`همه` / `UPLOADING` / `PROCESSING` / `READY` /
`FAILED`) with per-status counts plus a queue-depth line, a dense table / stacked cards, and an
empty state when a filter matches nothing. Failure reasons are shown as-is (they are already
user-safe) and never as raw stack traces; the Reprocess action is only offered on terminal rows
and its outcome surfaces as a toast.

---

# 14. States

Every interactive component implements: default, hover, focus-visible (2px accent
outline, offset 2px), active, disabled (opacity + not-allowed). Async components add
loading (spinner/skeleton). Forms add error. Lists add empty. See §11.

---

# 15. Accessibility

* Semantic HTML (`nav`, `main`, `header`, `aria-label` on regions).
* Keyboard: full tab order, Enter sends / Shift+Enter newline, Esc closes drawer/menu/modal.
* Visible focus states globally (`:focus-visible`).
* `aria-live` for toasts; `role="alert"` for form errors; `aria-current` on active
  conversation; `aria-expanded/haspopup` on menus; `aria-live="polite"` on in-progress
  assistant rows (pending / streaming with no live deltas on this tab) and on the
  offline banner.
* Contrast: body text ≥ 4.5:1 in both themes; accent-on-white 6.3:1.
* `prefers-reduced-motion` disables animation globally (base.css).

---

# 16. Responsive Rules

```text
Sidebar:      persistent ≥1024px · overlay drawer <1024px
Chat header:  hamburger + brand mark appear <1024px
Admin table:  full table ≥768px · stacked cards <768px
Auth split:   two panels >900px · single column below
Composer:     compact padding, always within thumb reach
```

**Overflow & touch rules** (verified against 320px):

* Flex items that truncate (`text-overflow: ellipsis`) must also set `min-width: 0`
  (chat header title) or an explicit `max-width` (model-selector name) — otherwise the
  ellipsis never engages.
* The composer textarea sets `min-width: 0` so its intrinsic width cannot push the
  composer box past the viewport.
* Dropdown menus are viewport-capped (`max-width: calc(100vw - 2rem)`).
* Modals are height-capped (`max-height: calc(100dvh - 3rem)`, scrollable body) so tall
  forms stay reachable on small screens.
* Wide markdown tables scroll inside the message column (`display: block;
  overflow-x: auto`) instead of stretching the page.
* Mobile-only navigation controls (hamburger, drawer close) use ≥2.5rem touch targets.
* Toolbars wrap (`flex-wrap: wrap`) rather than overflow (admin toolbar).
* Never mask layout bugs with a global `overflow-x: hidden`.

---

# 17. Iconography

Inline SVG, stroke-based (1.6–2.2 stroke width, round caps), currentColor, sized
12–18px. No emoji as icons (emoji are allowed only inside Persian UI copy, e.g. the
welcome line, never as controls). No icon-font dependency.

---

# 18. Images & Illustrations

None in the MVP. The brand mark + geometric dot pattern (auth panel) carry all
visual identity. Empty states use icon art, not illustrations.

---

# 19. Content & UX Writing

* Persian-first, warm but professional («گفتگو تازه», «در حال تولید پاسخ…»).
* Errors state what happened + what to do («بارگذاری مدل‌ها ناموفق بود … تلاش دوباره»).
* Provider/technical details never reach the UI (backend returns generic messages).
* Technical tokens (emails, model ids, API keys) render LTR in monospace.

---

# 20. Design System Evolution

When changing the system: update `tokens.css` first, then components, then review all
four views in both themes, then update this file. Do not create local exceptions.

---

# 21. Reference Pages

The Chat view (`/`) is the reference page for the visual language; the Admin view is the
reference for data-table patterns. Compare new pages against these in both themes.

---

# 22. Design Decision Log

```text
Decision: Indigo accent (#4f46e5 family), warm off-white light theme, cool near-black dark theme
Reason:   Matches the product brief's «sophisticated indigo» direction; distinct from
          generic AI-product purple/blue clones while staying calm and premium.
Date:     2026-09-13
Affected: tokens.css, all components.

Decision: Dark AND light themes, both first-class
Reason:   Brief requires both; long AI sessions favor dark, admin work favors light.
Date:     2026-09-13
Affected: tokens.css, useTheme, index.html pre-paint script.

Decision: Assistant messages are workspace content (no heavy bubbles); user messages
          get a soft accent block aligned to the inline-start (right) side in RTL.
Reason:   Differentiates the product from ChatGPT-style layouts; matches Persian
          reading direction.
Date:     2026-09-13
Affected: MessageItem.vue.

Decision: Retry reuses the original `clientMessageId` and creates a new assistant row
          (no row mutation, no in-place rewrite of history)
Reason:   The backend's idempotency layer treats a matching id+content as a replay
          (same user row, fresh assistant row, `meta.replay = true`). The user sees
          their original question exactly once and gets a fresh answer below it —
          matching the chat history they would expect after a refresh.
Date:     2026-09-15
Affected: MessageItem.vue, ChatView.vue, messages.service.ts.

Decision: `interrupted` and `failed` rows surface a primary-accent Retry button as
          the first action (not a generic error toast)
Reason:   Disconnect vs failure are semantically different for the user (one is
          expected — they clicked Stop; the other is unexpected — provider down).
          Collapsing them into a single "error" path makes a deliberate Stop look
          like a system failure. The retry button is the same control either way,
          but the surface tone differs (italic muted for `interrupted`, red for
          `failed`).
Date:     2026-09-15
Affected: MessageItem.vue.

Decision: Offline banner is a hint, not a transport gate
Reason:   `navigator.onLine` reports connectivity, not reachability — the browser
          may say "online" while DNS / captive portals are broken. The banner keeps
          the user informed; each request still surfaces its own error. Blocking
          Send while offline would create a new mode (queued retry, deferred state)
          that the MVP does not need.
Date:     2026-09-15
Affected: ChatView.vue, useOnline.ts.

Decision: `errorMessage` (server-side detail) is never rendered verbatim to the client;
          the client gets a generic Persian message and a non-leaky Retry button
Reason:   Provider errors can contain tokens, URLs, internal class names. Showing
          them to the user is a small information leak. The server stores them for
          debugging; the UI shows the user-facing copy only.
Date:     2026-09-15
Affected: MessageItem.vue, messages.service.ts, api/client.ts.

Decision: Inline SVG icons instead of an icon library
Reason:   Fewer than 20 icons needed; zero dependencies; consistent stroke system.
Date:     2026-09-13
Affected: all components.

Decision: Sidebar collapse (desktop) is width-transition to a 56px rail; content hides
          via opacity+visibility; mobile drawer ignores collapse state entirely.
Reason:   Matches the ChatGPT-style interaction the product brief asks for; visibility
          (not display:none) lets content fade during the transition while still leaving
          the tab order; media-query scoping guarantees the mobile drawer never regresses.
Date:     2026-09-14
Affected: AppSidebar.vue, ChatView.vue, tokens.css.

Decision: Vazirmatn primary + Inter for Latin fragments
Reason:   Excellent Persian readability; Inter keeps emails/ids crisp; both
          self-hosted via @fontsource (no runtime CDN dependency).
Date:     2026-09-13
Affected: main.ts, base.css.

Decision: A file chip only shows «آماده» when the backend says READY — the upload status is
          never advanced optimistically, and a non-ready attachment blocks sending with an
          explicit message instead of being dropped silently
Reason:   The file's status is server state (queued, extracted, failed). A hopeful UI would
          answer from a file whose text does not exist yet and would hide genuine failures;
          telling the user «این فایل هنوز در حال پردازش است» is honest and actionable.
Date:     2026-09-16
Affected: FileChip.vue, MessageComposer.vue, ChatView.vue.

Decision: File chips reuse the existing status-pill language (soft semantic tint + inline
          SVG icon) rather than introducing an upload-specific visual pattern
Reason:   The same four states already exist for models (active/inactive/free) and there is no
          new affordance to invent — a new pattern would have to be maintained in two places.
          Working states borrow the info palette, ready the success palette, failure the
          danger palette, so a row of chips reads at a glance in both themes.
Date:     2026-09-16
Affected: FileChip.vue, FileTable.vue.

Decision: Pending files render inside the composer box, in a row above the text row
Reason:   A file chosen for the message being written belongs to that message, so it grows the
          same box instead of a second surface the user has to read as a separate object. The
          row is separated by a hairline rather than a panel, carries no label or counter
          (the chips say what they are), and each chip removes itself — so the box stays the
          single place a message is composed.
Date:     2026-09-16
Affected: MessageComposer.vue.

Decision: A ready file alone can be sent, with a neutral instruction standing in for the draft
Reason:   Requiring text before the button unlocks invents friction the product does not need
          ("analyze this file" is the obvious intent of attaching one). The backend still
          requires non-blank content, so the UI supplies «این فایل را بررسی کن.» / «این فایل‌ها
          را بررسی کن.» instead of relaxing an invariant the whole chat path depends on, and
          the recorded message stays self-explanatory in history and in the conversation title.
Date:     2026-09-16
Affected: MessageComposer.vue, ChatView.vue.

Decision: Send is disabled while an upload is in flight, but never while a file is processing
Reason:   An uploading file is not in the conversation yet, so sending would drop it silently —
          that is a real data-loss risk and deserves a blocked action with an explanation.
          Once uploaded, the file is server-side work; blocking chat on it would violate the
          product rule that file processing never stalls the conversation.
Date:     2026-09-16
Affected: MessageComposer.vue, ChatView.vue.

Decision: Previews and downloads are proxied through the API instead of presigned storage URLs
Reason:   Ownership is already enforced per request in the backend, MinIO stays private, and no
          storage credentials or bucket URLs reach the browser — the same rule the rest of the
          file feature follows. The cost (bytes through the backend) is acceptable at MVP scale.
Date:     2026-09-16
Affected: files.controller.ts, FileViewerModal.vue, api/client.ts.

Decision: Chip status is an icon, never a word, and a message carries at most six chips
Reason:   Chips sit inside the message box the user is typing in, so every word spent on
          «آماده» / «در حال آپلود…» costs space the draft needs: the words moved into the tooltip
          and the accessible name, the visible chip kept its icon, and the name cap dropped far
          enough that four to five chips fit one row at `--chat-measure`. The six-file ceiling
          mirrors `FILE_MAX_PER_MESSAGE` in the picker (trimming a batch with a toast) so the
          limit is felt before the server has to reject a request.
Date:     2026-09-17
Affected: FileChip.vue, MessageComposer.vue, ChatView.vue, api/client.ts.
```

---

# 23. Final Rule

Before adding a new visual pattern, ask: does the project already have one that solves
this? If yes — reuse it. If no — build it as a reusable component, then document it here.
