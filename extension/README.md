# Planner YouTube reporter (Firefox)

Reports the YouTube video that is playing to the planner server, so YouTube mode switches on and off by itself and the
music experiment can see what is watched. Nothing is sent while nothing plays, and an ad is not counted as a video.

## Install (temporary: Firefox removes it when it restarts)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick `extension/manifest.json`.
3. The add-on's settings page opens. Enter the planner address and the API token (the same ones the website uses), then **Save and test**.

## Keep it permanently

Release Firefox only keeps add-ons that Mozilla has signed. Signing an add-on for your own use is free:

1. Make an account at addons.mozilla.org and create API credentials (Tools, Manage API Keys).
2. In this folder run `npx web-ext sign --channel=unlisted --api-key=<key> --api-secret=<secret>`.
3. Open the `.xpi` it writes in Firefox to install it for good.

## How it works

- `content.js` (runs on youtube.com) checks every 5 seconds whether a video is really playing, and reports it every 15 seconds while it plays.
- `background.js` groups the reports into a session and, after 5 minutes of nothing playing, tells the server the session is over.
- The server (`PUT /api/watch/:id`) opens YouTube mode when the first video plays, sets the mode (lecture or browsing) from the title and channel, and closes it when playback stops. A YouTube mode switched on by hand in the app is never touched.
