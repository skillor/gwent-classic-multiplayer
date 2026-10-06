# Tests

End-to-end tests for the online multiplayer mode.

## Prerequisites (one-time)

```bash
cd tests
npm install
```

## Running the tests

Simply run:

```bash
npm test
```

This starts a local static server on port 8077 automatically if one is not already running, and executes all test suites:
- `e2e-singleplayer.js` — vs-AI
- `e2e-multiplayer.js` — full online match, checksums, disconnect (via PeerJS WebRTC)
- `e2e-rematch.js` — post-match re-ready + mid-game exit
- `e2e-quickmatch.js` — find-opponent pairing, search screen, cancel
