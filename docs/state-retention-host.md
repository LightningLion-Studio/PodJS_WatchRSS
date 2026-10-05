# M2 — owned browser and modal drafts

M2 extends M1's existing route memory and the Android/Wear owned-dialog lifecycle. It adds host state APIs and guest continuations, without changing layout/style or confirmed business operations.

| State | Configuration recreation | Bundle/process recreation |
| --- | --- | --- |
| Owned in-app browser current URL/theme options/viewport mode/WebView zoom/scroll | Host descriptor restores after successful boot | Same saved descriptor; reload current URL as GET |
| Bili/RSS modal search, AddRSS modal fallback unconfirmed text/selection | Host retained draft, matched to the restored route ID and title; new guest binds confirmation | Draft resets, consistent with native retained search/input models |
| Notes modal fallback title/body | Parent reloads the real note, resumes the pending stage; confirmed title is not replayed when body is pending | No unconfirmed modal text in Bundle; confirmed/autosaved note remains in repository |
| New-note close destination after identity autosave | Small create-mode flag retained with the existing route memory | Existing saved note identity prevents duplicate creation; no modal draft is revived |

The native `WebViewActivity` saves its scale mode and initial Intent URL, and does not serialize WebView history/DOM. M2 additionally restores current URL and small viewport/scroll values as requested. This does not preserve arbitrary web page application state or resubmit forms. Android restores the page through the actual WebView/provider and current site state. Shorter content clamps to its real range; new user input takes over restoration. Authorization WebViews and explicit Cookie entry use their existing account/client recovery path and do not opt into ordinary page/draft snapshots.

`system.browser.inApp.state` and `input.text.state` are optional capabilities. Existing hosts receive the original browser/input arguments. Runtime versions with the capabilities keep their host snapshots separate from guest `application.activityState`; guest namespace writes cannot erase a browser or host draft. A saved browser descriptor and retained input descriptor each have a 32 KiB UTF-8/versioned bound. Bad/unknown/oversized state safely falls back. No webpage body, form values, cookies, decoder handles or host request IDs enter the guest navigation Bundle.

`useModalInput` maps the stable route memory ID to a host key, probes only an active owner, reissues the prompt, and consumes only a new explicit confirmation. Page exit/disposal dismisses its keyed prompt and invalidates delayed probes/replies. Reopening a new route does not adopt an old draft. Cancel/confirm/dismiss remove the live candidate; no repository/account operation runs merely because pending recovery was present. Notes use separate title/body keys and re-read the existing note before restoring a modal fallback editor.

Verification includes production route Context/helper and NotesScreen/NoteInlineEditor reconstruction with native UI/service boundaries mocked, actual autosave behavior, JVM host snapshot/schema/selection boundaries, capability/wire checks, Android/Wear Java and test compilation, dual-ABI JNI linkage and the mandatory app resource/bytecode build. The supplied local WebView and real EditText instrumentation tests are not executed in this offline task. Android Activity save/retain timing, process death, IME focus/selection, responsive page scroll and physical watch interaction remain device acceptance items; the main checkout's `wrss-minor-report.md` has exact owner steps.
