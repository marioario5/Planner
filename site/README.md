# Planner website (locked)

The same planner as the phone app, in a browser, for when you don't have your phone. It talks to the same server, so
everything stays in sync: ticks, Start/Finish/stop, flags and the day rating. It refreshes by itself every 20 seconds
and whenever you come back to the tab.

## How the lock works

The page that gets served is only a plain search box and an encrypted blob. The planner itself (its code, the server
address and the API token) is inside the blob, encrypted with AES-256-GCM using a key derived from the password
(PBKDF2-HMAC-SHA256, 600,000 iterations, random salt and IV, 128-bit tag). Typing the exact password into the search box
and pressing Enter decrypts the blob in the browser and swaps the page for the planner. A wrong guess just shows
"No results for ...", like any search. There is no unlock button, no error, and nothing in the page that says what it is.

The password is never written to any file. It only exists while you run the build and while you type it.

## Build and publish

```bash
node site/build.mjs
```

It asks for the planner server address, the API token and the password (typing is hidden), then writes
`docs/index.html`. Commit and push `docs/`, then in the repo's Settings > Pages choose "Deploy from a branch",
branch `main`, folder `/docs`. The site lives at `https://<your-username>.github.io/<repo>/`.

Rebuild whenever you change the password, the server address or the token, or when the site code changes.

The server must allow the site's origin. By default it allows `https://marioario5.github.io`; for another address set the
`ALLOWED_ORIGINS` variable on the Worker (comma-separated).

## Things to know

- **The password protects your data only as well as it is hard to guess.** The blob is public, so anyone can try guesses
  against it offline (600,000 iterations makes each guess slow, but a short or guessable password can still fall). Anyone
  who gets in also gets the API token. Use a long passphrase, and if you ever think it leaked, change the token on the
  server (`wrangler secret put API_TOKEN`) and rebuild.
- You have to type the password again every time you open or reload the page. Nothing is remembered.
- The page loads the Press Start 2P font from Google Fonts; the planner still works without it.
- The unencrypted source is in `site/src`, and it is public if the repo is. The lock hides your data and access, not the code.

## Tests

`server/test/site.test.mjs` (run with the server tests: `cd server && npm test`) covers the task rules, the server calls,
the encryption, and the served page's own script (wrong guess, empty search, right password).
