# Information screen migration

Page ids exported by `src/ui/InformationScreens.tsx` are `about`, `collaborators`, `contact-developer`, `join-group`, `info`, `beian`, `privacy`, `useragreement`, `licenses`, and `log-upload-privacy`. The public entry point is `InformationScreen({height, width?, page, onNavigate, onOpenUrl?, ref})`.

Text and measurements are transcribed from the old Android source: 18dp safe horizontal padding maps to `ScrollEntries`' 18-unit default, the 52dp action pills use 52 units, collaborator pills use 60 units, 8dp row gaps are retained, and the 17sp title / 13sp body scale follows the existing PodJS UI.

`information-data.ts` contains the old `strings.xml` text, registration number, QQ group URL, and MIIT URL. Privacy and user agreement fetch the same backend paths as Android (`/functions/v1/legal/watch/privacy-policy` and `/functions/v1/legal/watch/user-agreement`) when `legalBaseUrl` is supplied; loading, error, and retry remain explicit. External actions are surfaced through `onOpenUrl`; log upload remains disabled until `onUploadLogs` is supplied.
