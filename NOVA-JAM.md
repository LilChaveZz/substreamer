# Nova-Jam

Nova-Jam lets Android Substreamer clients share playback state and control in a
room. It is an optional integration with a separately deployed Nova-Jam
sidecar; the sidecar and Navidrome are not modified or bundled with Substreamer.

## Requirements

- An Android device signed in with an account on the same Navidrome instance
  configured for the Nova-Jam sidecar. Every room member needs an account on
  this instance.
- A Nova-Jam sidecar reachable at `/ws` on the host from the saved server URL.
  Configure the server or reverse proxy so the WebSocket endpoint is available
  at that path.
- HTTPS on the saved server URL is recommended so the WebSocket connection
  uses TLS.

Open **Settings > Jam** to create a room or join with its three-character
alphanumeric code. The player also provides a Jam entry point and indicates
when a room is active or reconnecting. QR generation and scanning are not
implemented.

## Playback and account data

The room shares the current track ID, queue IDs, playback state, and position.
Each device resolves those IDs through its Substreamer library and streams
audio directly from the same Navidrome instance using that member's account.
The sidecar coordinates playback state; it does not relay audio or stream URLs.
A room member can control playback for everyone in the room.
Members can reorder upcoming tracks from the player queue. The new order is
shared with the room without restarting the active track; the active track and
previously played rows stay fixed during a drag and cannot be moved.

Substreamer authenticates to the sidecar with the configured server URL,
username, and a salted MD5 password token. The raw password and Jam session are
not stored separately or persisted by the Jam feature. Use a trusted sidecar
and a TLS-protected connection.

Jam is Android-only. Room state remains in memory and is cleared when the
account session ends; a room is not automatically rejoined after a cold app
restart. On a network reconnect during the current app session, Substreamer
reauthenticates and rejoins the current room.

## Implementation notes

- `src/services/jam/jamService.ts` owns the WebSocket session and reconnect
  lifecycle.
- `src/services/jam/jamPlayerBridge.ts` synchronizes room transport with
  Substreamer's player service and in-memory player state.
- `src/store/jamStore.ts` keeps transient room status; it does not persist.
- `src/screens/jam.tsx` provides the Android room controls.

Playback synchronization depends on the deployed sidecar protocol. Native
queue replacement and screen-off reliability still require validation on
Android devices against that sidecar.
