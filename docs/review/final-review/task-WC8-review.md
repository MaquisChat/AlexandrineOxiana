# Task WC8 review: the estimate before a channel, playlist or profile is captured

Worktree `.claude/worktrees/kg-1`, branch `wc-8-estimate`, range a210250..573aebb (one commit). Reviewer did not build it.

## Verdict: READY WITH FIXES

## Important

**I1. An estimate of the OLD address is started when the address is changed while the estimate is being read.** `packages/ui/src/screens/Capture.tsx:1178`. The profile field's `onChange` closes an estimate only `if (!busy.current)`. While the estimate is being read, `busy` is true, so nothing closes. When the answer arrives, the estimate of the first address is shown under the new address. `Start` then sends `shown.url` (the old address) and empties the field, so the new address is lost. Probe: I typed `@old`, pressed Capture profile, typed `@new` while the estimate was held, then released it and pressed Start. Sent: `{"url":"https://www.youtube.com/@old",…}`, and the field was `""`. Smallest fix: at the answer, drop the estimate when `profileUrl.trim() !== url` (keep a ref to the field's value), or make the field read-only while listing.

**I2. Options changed under an open estimate are silently ignored.** `Capture.tsx:854-859`. `startProfile` sends `shown.options`, the options captured when Capture profile was pressed. The form's other controls stay live under the estimate: Metadata only, dates, maximum, content types, comments, legal basis, browser session, Transcription choice and model. Probe: I opened the estimate, ticked "Metadata only", then pressed Start. Sent: `{"transcribe":false,"quality":"720p"}`, so full videos are downloaded although the researcher asked for metadata only. The same holds for a corrected legal basis, which is then never sent. Smallest fix: close the estimate on any change to the profile form (as is done for the address), or disable the profile fieldsets while an estimate is shown.

**I3. A failed read of the project's switch silently sends `transcribe:false`, overriding the switch.** `Capture.tsx:832-838`. With "Use the project's setting" chosen and the project's switch ON, `GET …/automation` answering 500 leaves the box unticked with no word said. `Start` then sends an explicit `transcribe:false`. Probe output: `checked=false alert=null`, sent `{"transcribe":false,"quality":"720p"}`. Before this task the service applied the switch itself, so this is a new way to lose transcriptions. The read also has no time limit: it holds back the estimate inside the same `Promise.all`. Smallest fix: on failure, say so beside the box (e.g. "The project's setting could not be read; tick Transcribe if you want these transcribed.") and test it. An alternative is to leave `transcribe` out of the request, so that the service applies the switch (R669 item 3), but the plan pins an explicit value.

**I4. The listing has no time limit and no Cancel, and it locks the whole screen.** `Capture.tsx:824-848` and `:767`. The estimate request is sent with no signal and no time limit (`FIRST_READ_TIMEOUT_MS` applies only to the first reads). While it runs, the shared `busy`/`submitting` keep "Capture profile" **and "Capture links"** disabled, and nothing lets the researcher give up. Listing a large channel can take minutes; a service that never answers leaves "Asking YouTube for the list of videos…" on screen forever. A single link cannot be captured meanwhile, which R669 item 2 says must work at once. A platform outside youtube/instagram/tiktok gets no status at all, only a disabled button. Smallest fix: give the estimate its own busy flag (not the links form's), add a Cancel during listing (it aborts the request through a signal and drops the answer), and set a generous limit (e.g. 3 minutes) that ends in a plain sentence.

**I5. A missing tool refused by the estimate is no longer named, and no link is given (R126 regression).** Task 5's estimate answers 409 `TOOL_NOT_INSTALLED` with the tool id as `reason` (for example `video-downloader`). `refused` → `plainError` (`Capture.tsx:120`) rebuilds the error without `reason`, so the researcher reads only the library's generic sentence: "A tool this needs is not installed on this computer, so nothing was saved. Install it from the Optional tools screen, then try again." There is no tool name and no link. Before Task 8, the same profile went into the queue, where `MissingToolNotice` named the tool and linked it. No test covers an estimate refused for a tool. Smallest fix: in the form's error region, render `<MissingToolNotice from={err} as="p">` for `TOOL_NOT_INSTALLED` (keep the `ApiClientError` in state, not only the string), with a test for reason `video-downloader`.

**I6. The double-press test does not prove the synchronous guard.** `Capture.test.tsx` "Start sends the quality and the transcription choice once, however often it is pressed". Mutation: I removed `if (busy.current) return;` from `start()`, and the test still PASSED, because `user.dblClick` lands after the re-render has disabled the button. A probe with two `fireEvent.click` calls inside one `act` sent **2** requests with the guard removed and 1 with it. Smallest fix: in that test, press twice synchronously (`act(() => { fireEvent.click(b); fireEvent.click(b); })`).

## Minor

- M1. `Capture.tsx:856`. When "Do not transcribe" is chosen above, the estimate is asked without `transcribeModel`, so the box says "speech model: medium". Ticking it then sends `transcribeModel: model`, the disabled select's value (for example `small`): the model sent differs from the one named. Fix: at Start, send `shown.estimate.speechModel`, or always ask the estimate with `model`.
- M2. For metadata only, the Transcribe box is still offered and `transcribe:true` can be sent with no media. Hide or disable it when `metadataOnly`.
- M3. With `videoToolsInstalled: null` the screen treats Video tools as installed (720p, no hint). That is defensible, but nothing says the app could not tell. If ffmpeg is in fact missing, the run pauses on the tool later. No ruling asks for more; note it for the owner.
- M4. `Capture.test.tsx` "an answer after the project changed is dropped" waits on a real `setTimeout(50)` and asserts that something did not happen (Global Constraints: no sleep). It would be better to wait for the estimate request's answer to have been delivered.
- M5. The listing status `<span role="status">` is inserted already filled (`Capture.tsx:1243`). Some screen readers do not announce a live region inserted with its text. Keep the region mounted and change only its text.
- M6. When the estimate is refused, or the Start is refused, the pressed button is disabled while it runs and focus is not put anywhere afterwards. This is the existing pattern of the form, so it is not new.

## Contract check

- `CaptureEstimateRequest {url, options}` matches the shared type and Task 5's table. Task 4's `estimateCapture` reads `transcribeModel` → `speechModel` and `metadataOnly`.
- The fake's `exampleEstimate` matches `CaptureEstimate` field for field (no `measuredSpeed`, correctly optional). Kind, platform, the null fields and `videoToolsInstalled` are typed by the shared interface.
- `CaptureProfileRequest`: `options.quality` is one of `DOWNLOAD_QUALITIES`, there is an explicit `transcribe`, and there is no quality for metadata only. Task 5's `captureOptions` takes `quality` as optional. That holds on kg-5's routes as they stand.
- Errors: 403 with the reason is shown (tested); 429 `RATE_LIMITED` goes through `errorText`, which says the message once (not tested on this screen); 409 `TOOL_NOT_INSTALLED` is shown without the tool (I5); 409 `CONFLICT RUN_ALREADY_RUNNING` on Start shows the service's message and the estimate stays. Keeping the estimate after a refused Start is right: another quality can be chosen.
- `GET /projects/:id/automation` → `ProjectAutomation`, as in Task 7's table.
- Sentences: every estimate sentence comes from `estimateText`/`QUALITY_LABELS`, with no retyping. The region's order is heading, count, alreadyIn, cutShort, Quality, Transcribe, Disk (+tooBig), Time (+transcribeTime when ticked), then Start / Start anyway and Cancel. The radios are in the sketch's order, with 720p by default. Without tools, four are disabled with `aria-describedby` "These need Video tools.", the `ToolsLink` goes to `/settings/tools?tool=ffmpeg`, and ready-made is offered and chosen. With tools, ready-made is not shown. The size follows the chosen quality (tested). The legends come from `estimateText.legends`.
- R671: the new ffmpeg sentence matches the meaning of the worker catalogue's `without` sentence (`toolpins.py:254`).
- R677: the sentence is character-exact, and there is a test for each case.
- The hint was replaced as the plan says; the report names the old one.
- Untouched, as required: the `WorkLines` mount, `useEventFeed`, `Capture.firstReads.test.tsx` and the stream count. Single links are unchanged.
- Changed existing tests: the five profile tests now press Start, and each change is what the flow requires. In the explicit-transcribe bodies, the metadata-only one has no quality and the comments one has `quality:"720p"`. The `user.clear` was dropped because a successful Start empties the field. Nothing was loosened.

## Scenario 10 (read, not run)

`captureIt` fills the field, clicks Capture profile, registers `waitForResponse` for `capture-profile` **before** clicking Start, then clicks the `Start` / `Start anyway…` button. Playwright's auto-wait covers the listing. The order is right. The second run comes after "The profile capture finished." is visible. In kg-5's `DownloadRunner.launch`, `forget(h)` runs before `endQueue` publishes the finish, so the same address is no longer held, and the 409 `RUN_ALREADY_RUNNING` will not happen. The second estimate has count 0 ("Nothing new…"); Start is still offered and tooBig is undefined. It should work once Task 5's routes exist, provided the fake yt-dlp accepts the quality chosen (`ready` if the e2e catalogue reports ffmpeg missing, else `720p`). I could not check that here.

## Mutations

1. `start()` without its synchronous guard: the named double-press test still passed (I6). My probe failed with 2 requests, and passed once the guard was restored.
2. `initialQuality` keyed on `null` instead of `false`: 2 tests in `CaptureEstimate.test.tsx` and 1 in `Capture.test.tsx` failed.
3. The R677 note keyed on `status !== "failed"`: `CaptureQueue.test.tsx` "a run that did not finish…" failed.

All files were restored. `git status --short` is empty.

## Runs

`CaptureEstimate.test.tsx` 12/12, `Capture.test.tsx` 76/76, `Capture.firstReads.test.tsx` 15/15, `CaptureQueue.test.tsx` 24/24, `MissingToolNotice.test.tsx` 11/11, `.hookups` 8/8, `.capture` 4/4. `typecheck`, `lint:css` and `lint:colours` for `@ao/ui` are clean.

## Not checked

- The e2e scenario: not run, as the dispatch says.
- How long the listing really takes against YouTube.
- Screen-reader announcements on a real Mac (VoiceOver with the status and the disabled radios).
- The quality the e2e harness's catalogue leads to.

---

# Second look (R683)

Range 573aebb..942ca42 (a1236d0, e98f272, 687c04e, 7a4ac08, d697397, 942ca42), checked against the fix brief and R685.

## Verdict: APPROVED WITH MINORS

I1–I6 and M1, M2, M4 and M5 are mended. I found no Critical or Important issue.

## Checked
- **A.** The `background.ts` diff only adds `settingsChanged`, `switchNotRead`, `listingSlow(p)`, `listingAny` and `listingSlowAny`, character for character as the briefs give them (curly quotes, ellipsis). Each is tested in `background.test.ts` (28/28).
- **B.** There is one comparison: `profileForm` (`Capture.tsx` ≈:846) with an effect on it. It covers the address, since, until, the maximum, content types, metadata only, comments, legal basis, the browser session (`useSession`, `browser`), the Transcription choice, the model and Refresh existing. No control of the profile request is missing. I found no setter of these values outside a researcher's own action (no default filled in from a read), so neither a re-render nor a late read can close the estimate. A request still out is aborted. Mutation: without the signal, 2 tests fail, because they read `request.signal.aborted` at the assertion. `settingsChanged` is said once, in a status region that is always mounted. The address typed meanwhile is kept, also on a Start success (`profileUrlNow`).
- **C.** What Start sends: "Use the project's setting" with the box untouched → no `transcribe` key; "Transcribe" or "Do not transcribe" above → explicit; the box changed → explicit; metadata only → no box and never `true`; the model sent is `estimate.speechModel`. The switch is read through `readWithin(firstReadMs)` beside the estimate, never in the way of it (tested). A failed read shows `switchNotRead`, tied to the box with `aria-describedby`.
- **D.** Cancel during the listing aborts the request, moves focus to the field and drops the late answer (tested). `listingSlow` and `listingSlowAny` are tested with a fake clock. The links form has its own busy flag: a link capture works while an estimate is out and while one is open, and the estimate stays. A 409 `TOOL_NOT_INSTALLED` on the estimate and on Start goes through `MissingToolNotice` with the link (ffmpeg and video-downloader are each tested), and the estimate stays open after a refused Start.
- **E.** Without the synchronous guard (now in `startProfileWork`, which Start uses), the double-press test fails. The project-change test waits on `m.settled(…)` and no longer on a timer. `start()`'s guard now covers only the links form, whose tests are unchanged.
- **Unchanged areas.** The changed existing profile tests drop `transcribe` (untouched project setting) and keep `transcribeModel: "medium"` where the setting is not metadata only; that is the R683 C1 change, and nothing is loosened. `Capture.firstReads.test.tsx`, `WorkLines.tsx`, the `WorkLines` mount and `useEventFeed` are untouched.

## Minor
- **N1.** Probe: switch ON, read held; the researcher ticks then unticks the box; the read arrives. The box shows unticked with no note, but Start sends no `transcribe`, so the service applies the switch (ON) and transcribes. The cause is `explicit = … || estTranscribe !== estInitial.current` (`Capture.tsx` ≈:944). The rule (C1) is "changed the box". Fix: `|| estTouched.current`. The case is narrow: two clicks before a local read answers.
- **N2.** No test covers "a read that arrives after the box was touched does not overwrite it". The mutation removing `estTouched.current` from the read's handler passed all 92 tests. The code is right by reading. Add a test, ideally together with N1.
- **N3.** A form change while a Start is in flight closes the estimate and says `settingsChanged` ("…Press “Capture profile” to see it again."), while the capture still starts and appears in the queue. The sentence misleads for that moment. Fix: skip the effect while `profileBusy` holds a Start, or hold the form's fields during a Start.
- **N4.** Only three of the thirteen compared values have a test (the address, metadata only, the Transcription choice), as the brief allowed. Dropping, say, `types` from `profileForm` would go unnoticed.

## Runs
`Capture.test.tsx` 92/92, `CaptureEstimate.test.tsx` 14/14, `Capture.firstReads.test.tsx` 15/15, `CaptureQueue.test.tsx` 24/24, `MissingToolNotice.test.tsx` 11/11, shared `background.test.ts` 28/28. `typecheck`, `lint:css` and `lint:colours` for `@ao/ui` are clean. I restored every file after the mutations (guard: test failed; `estTouched`: survived; signal: 2 failed) and removed the probe. `git status --short` is empty.

## Not checked
The e2e scenario (no routes in this worktree) and VoiceOver on a real Mac.
