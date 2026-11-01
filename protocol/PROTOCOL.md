# Nexa Chat wire protocol (current source)

## Transport

1. The mobile app opens a TLS/TCP connection to the Rust signaling listener (default port `7443`). It is raw TLS/TCP, not HTTP/REST.
2. Signaling is UTF-8 JSON, one JSON object per newline, bounded to 64 KiB per frame.
3. After authenticated SDP offer/answer and ICE candidate exchange, each app opens an ordered WebRTC DataChannel to its Rust WebRTC peer. DataChannel frames are JSON objects and are bounded to 16 KiB by the backend.
4. Each client connects to the server. Client A and client B do not connect directly.

**This protocol is currently framed JSON, not CBOR or a binary message protocol.** The DataChannel may carry base64-encoded opaque message bytes, but its outer control envelope is JSON.

## Signaling client frames

```json
{"type":"register","username":"alice","display_name":"Alice","password":"example-password"}
{"type":"login","username":"alice","password":"example-password"}
{"type":"resume","token":"session-token"}
{"type":"logout"}
{"type":"search_users","query":"bob"}
{"type":"create_conversation","other_uid":"nx_..."}
{"type":"list_conversations"}
{"type":"conversation_history","conversation_id":"cv_..."}
{"type":"update_profile","display_name":"Alice","about":"Hello"}
{"type":"offer","sdp":"..."}
{"type":"ice_candidate","candidate":{}}
{"type":"ping"}
```

Authentication is connection-scoped. One TLS connection authenticates as one account; send `logout` before changing accounts.

## DataChannel client frames

```json
{"type":"send_message","message_id":"msg_12345678","conversation_id":"cv_...","ciphertext_b64":"..."}
{"type":"delivered_ack","message_id":"msg_12345678"}
{"type":"seen_ack","message_id":"msg_12345678"}
{"type":"ping"}
```

The sender does not supply a recipient UID. The server derives the recipient from conversation membership. Conversation is 1:1 only. A message ID is 8–80 ASCII letters/digits/underscore/hyphen. Ciphertext is capped at 8 KiB before base64 framing.

## Server delivery frames

- `saved_ack`: message and outbox row committed to the database.
- `new_message`: opaque message envelope delivered to the recipient DataChannel.
- `delivered_ack`: receiver says it has locally accepted/decrypted/persisted the message.
- `seen_ack`: receiver says the conversation message was viewed.
- `presence_update`: same-server-process online/offline event.
- `error`: rejected request with code/message.

The intended client order is decrypt → local durable save → `delivered_ack`; only after viewing the conversation should it send `seen_ack`. The current app has no E2EE implementation, therefore it deliberately sends neither ACK.

## Important security limitation

The backend cannot verify that `ciphertext_b64` contains genuine E2EE ciphertext. The mobile UI prevents live sending until a reviewed client-side encryption implementation and key/prekey relay are installed. A modified client could bypass UI checks; production backend must only be exposed after the E2EE/key enrollment release gate is complete.
